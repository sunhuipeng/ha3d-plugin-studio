/* useUiStore —— 界面态 / 反馈 / 锁 / MCP 横条 / 预览高亮
 *
 * 这些都是「多个互不相邻组件都要读写」的状态，适合放 Pinia：
 *   App.vue 顶栏、LeftRail、RightPanel 的浮层、PluginStage 的预览状态、
 *   ws-client.js 的 MCP 事件与配置锁，以前全靠一个模块级 reactive 对象 S 串起来。
 *
 * 定时器句柄放模块级变量，不进 $state（响应式包装定时器没有意义）。
 * three 场景 / 引擎实例绝不进本 store，见 lib/api.js 的 viewportApi。
 */
import { defineStore } from 'pinia';
import { useProjectStore } from './project';
import { viewportApi } from '../lib/api';

let toastTimer = null;
let bigToastTimer = null;

/* 暗色模式偏好：localStorage 持久化，key 与 ha3d.* 前缀区分开（studio 自己的设置）。
 * 启动时同步读一次并写到 <html>：style.css 的 data-theme 选择器与 Element Plus 的 .dark
 * 都挂在这个元素上，必须早于 ThreeHost.init（它在挂载时读 data-theme 决定 3D 底色）。 */
const DARK_KEY = 'studio.dark';
function loadDark() {
  try { return localStorage.getItem(DARK_KEY) === '1'; } catch (_) { return false; }
}
function applyDarkToDom(on) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', on ? 'dark' : 'light');
  root.classList.toggle('dark', on);   // Element Plus dark css-vars 用 .dark
}

export const useUiStore = defineStore('studio-ui', {
  state: () => ({
    /* 暗色模式（调灯效用）：初值来自 localStorage，创建后立即同步到 <html>（见下方 $subscribe 说明） */
    dark: loadDark(),
    view: 'home',            // 'home' 启动页(项目列表) | 'editor' 编辑开发页
    panel: null,             // 右侧浮层面板 id
    toast: { show: false, msg: '', err: false },
    bigToast: { show: false, title: '', detail: '', err: false },
    publishing: false,       // 发布/导出进行中（禁用发布按钮 + 等待动画）
    /* 配置锁（纯前端状态）：locked 时左侧浮层只读，避免人和 AI 同时改配置互相覆盖。
     * by = 'mcp'（AI 改）/ 'user'（人改）。服务端不存不判，刷新一律未锁。 */
    lock: { locked: false, by: '', at: 0, note: '' },
    mcp: { active: false, connected: false, text: '', busy: false },
    /* 部件面板大图预览：文件 + GLB 内高亮节点名（空 = 整个模型） */
    previewFile: '',
    previewNode: '',
    previewStatus: null,     // 插件渲染区状态快照（PluginStage 写，PlanInset/CodePanel 读）
    /* mock 实体状态变化计数：卡片值树靠它重算（与 home 的 haStore.entityVersion 同口径）。
       Map / WebSocket / 引擎实例绝不进 store，这里只是一个轻量版本号。 */
    entityVersion: 0,
  }),

  getters: {
    isLocked: (s) => !!s.lock.locked,
    /* 锁是谁的：AI 还是人（提示文案用） */
    lockByText: (s) => (s.lock.by === 'mcp' ? 'AI' : '你'),
    isEditing: (s) => s.view === 'editor',
  },

  actions: {
    /* 把当前 dark 同步到 <html> + localStorage，并通知已挂载的 3D host 切底色。
     * host 通过 viewportApi 暴露 setDark（PluginStage / CatalogEditor 各自挂），未挂载时忽略。 */
    applyTheme() {
      applyDarkToDom(this.dark);
      try { localStorage.setItem(DARK_KEY, this.dark ? '1' : '0'); } catch (_) {}
      try {
        const pv = viewportApi.pluginPreview || viewportApi.catalogPreview;
        if (pv && typeof pv.setDark === 'function') pv.setDark(this.dark);
      } catch (_) {}
    },
    toggleDark() {
      this.dark = !this.dark;
      this.applyTheme();
      return this.dark;
    },
    showToast(msg, err = false) {
      this.toast = { show: true, msg, err };
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { this.toast.show = false; }, err ? 5000 : 2600);
    },
    hideToast() { clearTimeout(toastTimer); this.toast.show = false; },

    /* 重大提示：居中大横幅，自动消失，可点击关闭。
     * err=true 用于发布失败——错误需要用户去改设置，停留时间放长到 9 秒，配色转红。 */
    showBigToast(title, detail = '', err = false) {
      this.bigToast = { show: true, title, detail, err: !!err };
      clearTimeout(bigToastTimer);
      bigToastTimer = setTimeout(() => { this.bigToast.show = false; }, err ? 9000 : 3200);
    },
    hideBigToast() { clearTimeout(bigToastTimer); this.bigToast.show = false; },

    setView(v) { this.view = v; },
    setPanel(id) { this.panel = id; },
    togglePanel(id) { this.panel = this.panel === id ? null : id; },
    setPublishing(v) { this.publishing = !!v; },

    setPreviewFile(file) { this.previewFile = file || ''; },
    setPreviewNode(node) { this.previewNode = node || ''; },
    setPreviewStatus(st) { this.previewStatus = st; },
    clearPreview() { this.previewFile = ''; this.previewNode = ''; },
    /* 实体状态广播（mock-ha.on）的唯一写入口：只递增版本号，不复制实体表。 */
    bumpEntityVersion() { this.entityVersion++; },

    /* 点击「模型文件库」列表项以外的任意位置 → 取消预览高亮（见 installUiGuards） */
    clearPreviewOutside(e) {
      if (!this.previewFile) return;
      const t = e.target;
      if (t && t.closest && t.closest('.parts-ul li, #float-panel, #center')) return;
      this.clearPreview();
    },

    /* MCP 横条：一次 $patch 同时改多个字段，devtools 里也是一条记录 */
    setMcp(patch) { Object.assign(this.mcp, patch); },

    applyLock(st) {
      if (!st) { this.lock = { locked: false, by: '', at: 0, note: '' }; return; }
      this.lock = {
        locked: !!st.locked,
        by: st.by || '',
        at: Number(st.at) || 0,
        note: st.note || '',
      };
    },
    /* 打开 / 刷新页面一律未锁，永远不会有「锁死解不开」 */
    async loadLock() { this.applyLock(null); },
    /* 人点按钮改锁：只改当前页面状态，不写服务端、不广播 */
    async setLock(locked) {
      if (this.lock.locked === !!locked) return;
      this.applyLock({ locked: !!locked, by: 'user', at: Date.now(), note: '' });
      if (this.lock.locked) this.showToast('配置已锁定：左侧面板转为只读，避免和 AI 同时改配置');
      else {
        useProjectStore().clearSaveState();
        this.showToast('配置已解锁：可以手动编辑了');
      }
    },

    /* 切换项目 / 回启动页：把只属于上一项目的界面态一次清干净 */
    resetEditorUi() {
      this.panel = null;
      this.previewFile = '';
      this.previewNode = '';
      this.previewStatus = null;
      this.applyLock(null);
    },
  },
});
