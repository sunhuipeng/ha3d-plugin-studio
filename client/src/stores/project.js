/* useProjectStore —— 项目数据 / 编辑态 / 引擎内存镜像 / 保存 / 漂移对账 / 发布导出
 *
 * 这是全局状态的主体（原 store.js 里 act 的大部分方法）。拆成 Pinia 后：
 *   state   = 唯一事实源（项目 JSON 的内存副本 + 引擎 live 镜像）
 *   getters = 派生视图（engineList / curStyle / catalogItems / snapText…），组件不必自己各算一份
 *   actions = 所有写入口（含异步网络请求、防抖保存、导出下载），devtools 里可逐条追溯
 *
 * 边界：three / WebSocket / 视口能力不进本 store，见 lib/api.js 与 ws-client.js。
 * 「配置是唯一事实源」的语义不变：引擎内存 live 引用，保存时全量序列化回项目 JSON。
 */
import { defineStore } from 'pinia';
import { reactive } from 'vue';
import { api } from '../lib/api';
import { normalize, normalizeEngineFields } from '../lib/normalize';
import { syncHash } from '../lib/route-core';
import { denyWhenLocked } from '../lib/guards';
import { diffConfig } from '../config-diff';
import { newItemFromModel } from '../catalog';
import { useUiStore } from './ui';
import { useAssetsStore } from './assets';

/* 防抖保存句柄 / toast 节流之类都是非响应式模块状态，不放 $state */
let saveTimer = null;

const emptySnapshot = () => ({
  has: false, stale: false, changeCount: 0,
  scopes: { styles: 0, fields: 0 }, summary: [], hint: '',
});

/* 三个导出/发布动作共用的下载流程：取 blob → 按 Content-Disposition 取文件名 → a.click()
 * 抽成纯函数，Action 只负责编排状态，逻辑不重复三遍。 */
async function downloadResponse(r, fallback) {
  if (!r.ok) {
    let m = await r.text();
    try { m = JSON.parse(m).error || m; } catch (e) { /* 原样展示 */ }
    throw new Error(m);
  }
  const blob = await r.blob();
  const mm = /filename="?([^";]+)"?/.exec(r.headers.get('Content-Disposition') || '');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = mm ? mm[1] : fallback;
  a.click();
  URL.revokeObjectURL(a.href);
  return a.download;
}

export const useProjectStore = defineStore('studio-project', {
  state: () => ({
    projects: [],
    proj: null,
    target: null,
    styleId: null,       // 当前编辑的样式 id（顶栏切换）
    saveState: '',
    /* 引擎运行后的内存镜像（live 引用，reactive 包装 def.styles / def.fields）：
     * UI 与 MCP 读这里 —— AI 代码声明什么就显示什么；保存时全量覆盖进项目 JSON。 */
    engineStyles: null,
    engineFields: null,
    codeBaseline: null,  // { styles, fields } 纯数据；渲染成功后从 def._baseline 取
    /* 配置漂移对账状态：基线 = 代码加载时（合并项目 JSON 前）的 styles/fields 深拷贝，
     * stale = 当前引擎内存与基线不同 → 顶栏「配置已变更 N 处」 */
    snapshot: emptySnapshot(),
    /* MCP 改了家具清单后 +1：CatalogEditor 监听它重载 3D 预览 */
    catalogEpoch: 0,
  }),

  getters: {
    isCatalog: (s) => !!(s.proj && s.proj.plugin && s.proj.plugin.kind === 'catalog'),
    pluginKind: (s) => (s.proj && s.proj.plugin && s.proj.plugin.kind) || 'device',
    projectId: (s) => (s.proj && s.proj.id) || '',

    /* UI 读的样式/字段列表：引擎内存优先（运行后的真实数据），没渲染过 / 渲染失败时回落项目配置 */
    engineList: (s) => (s.engineStyles && s.engineStyles.length)
      ? s.engineStyles : ((s.proj && s.proj.styles) || []),
    fieldList: (s) => (s.engineFields && s.engineFields.length)
      ? s.engineFields : ((s.proj && s.proj.fields) || []),

    /* 当前编辑的样式与其参数（引擎内存优先） */
    curStyle() {
      const list = this.engineList;
      if (!list.length) return null;
      return list.find((s) => s.id === this.styleId) || list[0];
    },

    /* 家具项目清单：一个 glb 一条 */
    catalogItems: (s) => (s.proj && s.proj.catalog && Array.isArray(s.proj.catalog.items))
      ? s.proj.catalog.items : [],

    /* 顶栏配置漂移徽标：原来在 App.vue 里各写一份 computed，收成 getter 供全站复用 */
    snapText() {
      const s = this.snapshot;
      if (!s.has) return '配置与代码一致';
      if (s.stale) return `配置已变更 ${s.changeCount} 处`;
      return '配置与代码一致';
    },
    snapTitle() {
      const s = this.snapshot;
      if (!s.has) return '还没有渲染过插件：渲染成功后以「AI 代码声明的样式/字段」为基线，之后改了配置这里会显示差异';
      if (!s.stale) return '当前内存配置与 AI 代码加载时声明的一致';
      return `相对代码加载时的配置（基线），样式 ${s.scopes.styles} / 字段 ${s.scopes.fields} 处不同：\n· `
        + (s.summary.join('\n· ') || '（无明细）');
    },
  },

  actions: {
    clearSaveState() { this.saveState = ''; },
    resetSnapshot() { this.snapshot = emptySnapshot(); },

    /* ---- 项目列表 / 发布目标 ---- */
    async loadProjects() {
      this.projects = (await api('GET', '/api/projects')).items;
    },
    async loadTarget() {
      try { this.target = await api('GET', '/api/target'); }
      catch (e) { this.target = null; }
    },
    async saveTarget(payload) {
      const d = await api('PUT', '/api/target', payload);   // { host, key }
      this.target = d;
      useUiStore().showToast('发布目标已保存: ' + d.host);
    },

    /* ---- 打开 / 关闭 / 增删改项目 ---- */
    async newProject(name, kind) {
      const k = kind || 'device';
      const d = await api('POST', '/api/projects', { name: name || '未命名项目', kind: k });
      await this.loadProjects();
      await this.openProject(d.project.id);
      useUiStore().showToast('项目已创建');
    },
    async openProject(id) {
      const ui = useUiStore();
      try {
        await this.saveNow();
        this.proj = normalize(await api('GET', `/api/projects/${id}`));
        this.engineStyles = null;
        this.engineFields = null;
        this.codeBaseline = null;   // 新项目还没渲染，等渲染成功后从新代码取基线
        this.resetSnapshot();
        /* 家具项目没有 styles（normalize 提前返回），这里不能裸取 [0] */
        this.styleId = (Array.isArray(this.proj.styles) && this.proj.styles[0] && this.proj.styles[0].id) || null;
        ui.panel = null;
        ui.setView('editor');
        syncHash(id);
        await this.loadProjects();
        await useAssetsStore().loadModels();
        if (this.proj.plugin.kind === 'catalog') useAssetsStore().loadCatalogTypes().catch(() => {});
        await ui.loadLock();   // 打开 / 刷新页面一律未锁
      } catch (e) {
        ui.showToast('打开失败: ' + e.message, true);
        syncHash(null);
        ui.setView('home');
      }
    },
    async goHome() {
      const ui = useUiStore();
      await this.saveNow();
      ui.setView('home');
      this.proj = null;
      ui.applyLock(null);
      this.engineStyles = null;
      this.engineFields = null;
      this.codeBaseline = null;
      this.resetSnapshot();
      syncHash(null);
      await this.loadProjects();
    },
    async deleteProject(id) {
      await api('DELETE', `/api/projects/${id}`);
      if (this.proj && this.proj.id === id) this.proj = null;
      await this.loadProjects();
    },
    async copyProject(id, name) {
      const d = await api('POST', `/api/projects/${id}/copy`, { name });
      await this.loadProjects();
      return d.project;
    },
    async renameProject(id, name) {
      const proj = normalize(await api('GET', `/api/projects/${id}`));
      proj.name = name;
      if (proj.plugin) proj.plugin.name = name;   // 插件名称跟着项目名称走
      await api('PUT', `/api/projects/${id}`, { project: proj });
      await this.loadProjects();
    },
    /* 编辑页渲染快照 → 存进项目目录 preview.png（启动页卡片读这张图，不做现场渲染） */
    async savePreview(dataUrl) {
      if (!this.proj || !dataUrl || !dataUrl.startsWith('data:image/png;base64,')) return;
      const b64 = dataUrl.slice('data:image/png;base64,'.length);
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      await api('PUT', `/api/projects/${this.proj.id}/preview.png`, buf, true);
    },

    /* ---- 防抖保存 ----
     * 锁只作用在左侧浮层面板（那边控件已只读）；中间编辑区照常可改可存，所以不拦保存。 */
    scheduleSave() {
      if (!this.proj) return;
      this.saveState = '未保存…';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => this.saveNow(), 900);
    },
    /* MCP 直接写了磁盘上的 project.json：取消挂着的防抖保存，避免旧内存 900ms 后覆盖回去 */
    cancelPendingSave() {
      clearTimeout(saveTimer);
      saveTimer = null;
      this.saveState = '已保存 ✓';
    },
    /* 全量覆盖：保存前把引擎内存的 styles / fields 序列化进项目 JSON。
     * 函数属性（背景 apply 等）无法序列化，恢复时由代码侧提供。 */
    fullSyncEngineToProject() {
      if (!this.proj || !this.engineStyles) return;   // 没渲染过 → JSON 保持原样
      this.proj.styles = this.engineStyles.filter((s) => s && s.id).map((s) => {
        const out = { id: s.id, name: s.name || s.id };
        ['icon', 'desc', 'z', 'labelOffset', 'refresh'].forEach((k) => {
          if (s[k] !== undefined) out[k] = s[k];
        });
        out.options = (s.options || []).filter((o) => o && typeof o === 'object' && o.key)
          .map((o) => JSON.parse(JSON.stringify(o)));
        return out;
      });
      this.proj.fields = (this.engineFields || []).filter((f) => f && f.key)
        .map((f) => JSON.parse(JSON.stringify(f)));
    },
    /* 漂移对账：当前引擎内存 vs 代码基线 → 顶栏「配置已变更 N 处」。
     * 触发点：渲染成功（syncEngineMirror）、每次保存（值/结构改动落盘时） */
    refreshDrift() {
      const base = this.codeBaseline;
      if (!base || !this.engineStyles) { this.resetSnapshot(); return; }
      const d = diffConfig(base.styles, base.fields, this.engineStyles || [], this.engineFields || [],
        this.proj && this.proj.plugin && this.proj.plugin.kind);
      this.snapshot = {
        has: true,
        stale: d.changeCount > 0,
        changeCount: d.changeCount,
        scopes: d.scopes,
        summary: d.summary,
        hint: '',
      };
    },
    async saveNow(opts) {
      if (!this.proj) return;
      try {
        this.fullSyncEngineToProject();
        await api('PUT', `/api/projects/${this.proj.id}`, { project: this.proj });
        this.saveState = '已保存 ✓';
        this.refreshDrift();
      } catch (e) {
        useUiStore().showToast('保存失败: ' + e.message, true);
        if (opts && opts.throwOnError) throw e;   // MCP 同步要拿到真错误，不能静默成功
      }
    },
    /* 点徽标「以当前内存为准」= 重置基线、清掉已变更标记 */
    rebaseline() {
      const ui = useUiStore();
      if (!this.engineStyles && !this.engineFields) { ui.showToast('还没有渲染过，没有可记的基准', true); return; }
      this.codeBaseline = {
        styles: JSON.parse(JSON.stringify(this.engineStyles || [])),
        fields: JSON.parse(JSON.stringify(this.engineFields || [])),
      };
      this.refreshDrift();
      ui.showToast('已把当前配置记为新基准');
    },

    /* ---- 引擎内存镜像 ----
     * 渲染成功后由 PluginStage 调：把 def.styles / def.fields 包装成 reactive 给 UI。
     * 是 live 引用：UI 通过它改值，引擎 spawn 时读到的就是新值（respawn 即时生效）。 */
    syncEngineMirror(preview) {
      if (!preview || !preview.def) {
        this.engineStyles = null; this.engineFields = null; this.codeBaseline = null; return;
      }
      this.engineStyles = reactive(preview.def.styles || []);
      this.engineFields = reactive(normalizeEngineFields(preview.def.fields || []));
      this.codeBaseline = preview.def._baseline || null;
      this.refreshDrift();
    },

    /* ---- 样式 / 字段 / 参数编辑（项目配置 + 引擎内存双写） ---- */
    copyStyle(id) {
      const ui = useUiStore();
      if (denyWhenLocked()) return null;
      if (!this.proj) return null;
      const list = this.engineList;
      const src = list.find((s) => s.id === id) || this.curStyle;
      if (!src) return null;
      /* 保留函数属性（背景样式的 apply 是渲染主体，JSON 克隆会丢掉） */
      const copy = {};
      for (const k in src) {
        copy[k] = k === 'options' ? JSON.parse(JSON.stringify(src.options || [])) : src[k];
      }
      copy.id = 'style' + (list.length + 1) + '_' + Math.random().toString(36).slice(2, 5);
      copy.name = (src.name || src.id) + ' 副本';
      const plain = JSON.parse(JSON.stringify({
        id: copy.id, name: copy.name, z: copy.z, labelOffset: copy.labelOffset,
        refresh: copy.refresh, icon: copy.icon, desc: copy.desc, options: copy.options,
      }));
      this.proj.styles.push(plain);
      if (this.engineStyles) this.engineStyles.push(copy);
      this.styleId = copy.id;
      this.scheduleSave();
      ui.showToast('已复制样式为「' + copy.name + '」');
      return copy;
    },
    removeStyle(id) {
      const ui = useUiStore();
      if (denyWhenLocked()) return false;
      if (!this.proj) return false;
      if (this.engineList.length <= 1) { ui.showToast('至少保留一个样式', true); return false; }
      const list = this.proj.styles || [];
      const i = list.findIndex((x) => x && x.id === id);
      if (i >= 0) list.splice(i, 1);
      if (this.engineStyles) {
        const j = this.engineStyles.findIndex((s) => s && s.id === id);
        if (j >= 0) this.engineStyles.splice(j, 1);
      }
      if (this.styleId === id) {
        const rest = this.engineList;
        this.styleId = rest[0] ? rest[0].id : null;
      }
      this.scheduleSave();
      return true;
    },
    /* 没填 key 的草稿条目只在内存里 */
    removeOption(styleId, opt) {
      if (denyWhenLocked()) return;
      if (!this.proj || !opt) return;
      const s = this.engineList.find((x) => x && x.id === styleId);
      if (s && Array.isArray(s.options)) {
        const i = s.options.indexOf(opt);
        if (i >= 0) s.options.splice(i, 1);
      }
      if (opt.key) {
        const ps = (this.proj.styles || []).find((x) => x && x.id === styleId);
        if (ps && Array.isArray(ps.options)) {
          const j = ps.options.findIndex((o) => o && o.key === opt.key);
          if (j >= 0) ps.options.splice(j, 1);
        }
      }
      this.scheduleSave();
    },
    removeField(f) {
      if (denyWhenLocked()) return;
      if (!this.proj || !f) return;
      if (this.engineFields) {
        const i = this.engineFields.indexOf(f);
        if (i >= 0) this.engineFields.splice(i, 1);
      }
      const list = this.proj.fields || [];
      const j = f.key ? list.findIndex((x) => x && x.key === f.key) : list.indexOf(f);
      if (j >= 0) list.splice(j, 1);
      this.scheduleSave();
    },
    addField() {
      if (denyWhenLocked()) return;
      const f = {
        key: '', label: '', domains: [], placeholder: '', tip: '',
        valueType: 'text', enumValues: [], attributes: '',
      };
      this.proj.fields.push(f);
      if (this.engineFields) this.engineFields.push(f);
      this.scheduleSave();
    },
    addOption() {
      if (denyWhenLocked()) return;
      const st = this.curStyle;
      if (!st) return;
      const o = { key: '', label: '', type: 'range', def: '', min: 0, max: 1, step: 0.1, choices: [], tip: '' };
      const ps = (this.proj.styles || []).find((x) => x && x.id === st.id);
      if (ps) {
        if (!Array.isArray(ps.options)) ps.options = [];
        ps.options.push(o);
      }
      if (!Array.isArray(st.options)) st.options = [];
      st.options.push(o);
      this.scheduleSave();
    },
    /* 背景插件：一键加上 ha-3d-home 插件引擎保留的位置参数（与 home 的 K.positionOpts() 一致）。 */
    addOffsetOpts() {
      const ui = useUiStore();
      if (denyWhenLocked()) return;
      const st = this.curStyle;
      if (!st) return;
      const defs = [
        { key: 'offsetX', label: '东西偏移', type: 'range', min: -30, max: 30, step: 0.5, def: 0, tip: '房屋在背景画面里东/西偏多少米（+西 = 往右拖背景左移，房屋相对偏东）' },
        { key: 'offsetZ', label: '南北偏移', type: 'range', min: -30, max: 30, step: 0.5, def: 0, tip: '房屋在背景画面里南/北偏多少米（+北 = 往右拖背景上移，房屋相对偏南）' },
        { key: 'houseY', label: '离地高度', type: 'range', min: -10, max: 30, step: 0.5, def: 0, tip: '房屋地板相对背景基准面的高度（米）：正值=房屋悬空/建在山顶平台，负值=房屋在低洼/下沉庭院。插件从 ctx.options.houseY 读同一个值来画脚下地形' },
      ];
      const ps = (this.proj.styles || []).find((x) => x && x.id === st.id);
      if (ps && !Array.isArray(ps.options)) ps.options = [];
      if (!Array.isArray(st.options)) st.options = [];
      let added = 0;
      defs.forEach((o) => {
        if (st.options.some((x) => x && x.key === o.key)) return;
        const copy = JSON.parse(JSON.stringify(o));
        if (ps) ps.options.push(copy);
        st.options.push(copy);
        added++;
      });
      if (!added) { ui.showToast('当前样式已包含位置参数', true); return; }
      this.scheduleSave();
      ui.showToast('已添加位置参数（offsetX / offsetZ / houseY）');
    },

    /* ---- 家具项目清单 ---- */
    addCatalogItem(file, size, displayName) {
      if (!this.proj || !this.proj.plugin || this.proj.plugin.kind !== 'catalog') return null;
      this.proj.catalog ||= {};
      if (!Array.isArray(this.proj.catalog.items)) this.proj.catalog.items = [];
      const taken = new Set(this.catalogItems.map((x) => x && x.id));
      const it = newItemFromModel(file, size, taken);
      if (displayName) it.name = String(displayName).slice(0, 40);
      this.proj.catalog.items.push(it);
      this.scheduleSave();
      return it;
    },
    removeCatalogItem(id) {
      if (!this.proj || !this.proj.catalog || !Array.isArray(this.proj.catalog.items)) return;
      const list = this.proj.catalog.items;
      const i = list.findIndex((x) => x && x.id === id);
      if (i < 0) return;
      list.splice(i, 1);
      this.scheduleSave();
    },

    /* ---- 导出 / 发布（ publishing 是全局 UI 态，统一由 ui store 管） ---- */
    async catalogExport() {
      const ui = useUiStore();
      if (ui.publishing || !this.proj) return;
      ui.setPublishing(true);
      try {
        await this.saveNow();
        const name = await downloadResponse(
          await fetch(`/api/projects/${this.proj.id}/export-catalog`),
          this.proj.id + '.zip');
        ui.showToast('已导出 ' + name);
      } finally { ui.setPublishing(false); }
    },
    async catalogPublish(bump) {
      const ui = useUiStore();
      if (ui.publishing || !this.proj) return;
      ui.setPublishing(true);
      try {
        await this.saveNow();
        const d = await api('POST', `/api/projects/${this.proj.id}/publish-catalog`, { bump: !!bump });
        if (this.proj) this.proj.plugin.version = d.manifest.version;
        this.saveState = '已保存 ✓';
        ui.showBigToast('发布成功', `已安装到 ${d.host}（${d.count} 件家具，v${d.manifest.version}）`);
      } finally { ui.setPublishing(false); }
    },
    async publish(bump) {
      const ui = useUiStore();
      if (ui.publishing) return;
      ui.setPublishing(true);
      try {
        await this.saveNow();
        const d = await api('POST', `/api/projects/${this.proj.id}/publish`, { bump });
        if (this.proj) this.proj.plugin.version = d.manifest.version;
        ui.showBigToast('发布成功', `已安装到 ${d.host}（v${d.manifest.version}${d.copied.length ? '，模型 ' + d.copied.length + ' 个' : ''}）`);
      } finally { ui.setPublishing(false); }
    },
    async exportZip() {
      const ui = useUiStore();
      if (ui.publishing) return;
      ui.setPublishing(true);
      try {
        await this.saveNow();
        const name = await downloadResponse(
          await fetch(`/api/projects/${this.proj.id}/export`),
          this.proj.plugin.id + '.zip');
        ui.showToast('已导出 ' + name);
      } finally { ui.setPublishing(false); }
    },
    /* 导出项目备份：整个项目文件夹（project.json + preview.png + models/）原样打包下载 */
    async exportProjectZip() {
      const ui = useUiStore();
      if (ui.publishing) return;
      ui.setPublishing(true);
      try {
        await this.saveNow();
        const name = await downloadResponse(
          await fetch(`/api/projects/${this.proj.id}/export-project`),
          this.proj.id + '-project.zip');
        ui.showToast('已导出项目备份 ' + name);
      } finally { ui.setPublishing(false); }
    },
    async importProject(file) {
      const ui = useUiStore();
      if (ui.publishing) return;
      ui.setPublishing(true);
      try {
        const r = await fetch('/api/projects/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/zip' },
          body: file,
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
        await this.loadProjects();
        ui.showToast('已导入项目「' + (d.name || d.id) + '」(' + d.id + ')');
      } finally { ui.setPublishing(false); }
    },
  },
});
