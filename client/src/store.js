/* ha3d-plugin-studio 前端全局状态与动作 */
import { reactive } from 'vue';
import { bumpModel } from './thumb';
import { normalizeOptionType } from './option-schema';
import { normalizeField } from './field-schema';

export const DEVICE_TYPES = ['light', 'switch', 'sensor', 'climate', 'water_heater', 'cover', 'fan', 'media_player', 'vacuum', 'camera', 'other'];
export const OPENING_TYPES = ['door', 'window'];
export const OPTION_TYPES = [
  { value: 'range', label: 'range 滑条' },
  { value: 'number', label: 'number 数字' },
  { value: 'checkbox', label: 'checkbox 复选' },
  { value: 'select', label: 'select 下拉' },
  { value: 'text', label: 'text 文本（缺省）' },
];
/* 字段 domains 多选可用的实体域（HA 常用） */
export const ENTITY_DOMAINS = [
  'sensor', 'binary_sensor', 'switch', 'light', 'climate', 'cover', 'fan',
  'humidifier', 'water_heater', 'lock', 'media_player', 'number', 'select',
  'button', 'vacuum', 'camera',
];

export const S = reactive({
  view: 'home',       // 'home' 启动页(项目列表) | 'editor' 编辑开发页
  projects: [],
  proj: null,
  styleId: null,      // 当前编辑的样式 id（顶栏切换）
  panel: null,
  saveState: '',
  target: null,
  models: [],         // 模型文件库（models 目录全部 .glb）
  previewFile: '',    // 部件面板大图预览的模型文件
  previewNode: '',    // 大图预览里高亮的 GLB 内节点名（空 = 整个模型）
  fixing: false,      // 材质修复中
  previewStatus: null, // 插件渲染区状态快照（PluginStage 写入，PlanInset/CodePanel 读）
  toast: { show: false, msg: '', err: false },
  mcp: { active: false, connected: false, text: '', busy: false },  // MCP 连接/调用提示横条（前端顶部）
  publishing: false,                                   // 发布/导出进行中（禁用发布按钮 + 等待动画）
  bigToast: { show: false, title: '', detail: '' },    // 居中大横幅成功提示（发布成功等）
  /* 配置快照对账状态（GET /api/projects/:id/snapshot）：stale = 配置改过、代码可能没跟着变 */
  snapshot: {
    has: false, at: '', label: '', version: '',
    stale: false, changeCount: 0,
    scopes: { settings: 0, styles: 0, fields: 0 },
    summary: [], hint: '',
  },
});

/* 视口组件注册进来的能力（地面/归零等需要 three 场景） */
export const viewportApi = {};

let toastTimer = null;
export function toast(msg, err = false) {
  S.toast = { show: true, msg, err };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { S.toast.show = false; }, err ? 5000 : 2600);
}

/* 重大成功提示（发布成功等）：居中大横幅，自动消失，可点击关闭 */
let bigToastTimer = null;
export function bigToast(title, detail = '') {
  S.bigToast = { show: true, title, detail };
  clearTimeout(bigToastTimer);
  bigToastTimer = setTimeout(() => { S.bigToast.show = false; }, 3200);
}

export async function api(method, url, body, raw) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    if (raw) { opt.body = body; opt.headers['Content-Type'] = 'application/octet-stream'; }
    else { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  }
  const r = await fetch(url, opt);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

function normalize(proj) {
  proj.plugin ||= {};
  /* 插件 id 恒等于项目 id（安装目录 = custom/plugins/<项目id>，重复安装覆盖同一份） */
  proj.plugin.id = proj.id;
  proj.plugin.entityId ||= '';
  /* 插件名称 = 项目名称（项目名是唯一来源；老数据里改乱的在打开时自动对齐） */
  if (proj.name) proj.plugin.name = proj.name;
  proj.styles ||= [{ id: 'default', name: proj.plugin.name || '默认造型', z: 0, icon: '', desc: '', options: [] }];
  for (const s of proj.styles) {
    if (!Array.isArray(s.options)) s.options = [];
    for (const o of s.options) {
      /* type 归一化：bool → checkbox，缺省/未知 → text（口径见 option-schema.js） */
      if (!o || typeof o !== 'object') continue;
      o.type = normalizeOptionType(o.type);
      if (o.type === 'select' && !Array.isArray(o.choices)) o.choices = [];
    }
  }
  /* 字段是插件级实体绑定，所有样式共用一份 */
  proj.fields ||= [];
  for (const f of proj.fields) {
    if (typeof f.domains === 'string') f.domains = f.domains.split(/[\s,，]+/).filter(Boolean);
    if (!Array.isArray(f.domains)) f.domains = [];
    /* valueType / enumValues 是给人看和给 AI 读的说明（不参与渲染），缺省补成 text + 空数组 */
    normalizeField(f);
  }
  proj.customJs ||= '';
  /* 给 AI 的提示词（左侧「提示词」面板写，MCP studio_get_project 会带出去） */
  proj.aiPrompt ||= '';
  /* 配置快照不跟着项目对象走：它由 /snapshot 接口独占维护，前端保存时回写会覆盖 MCP 刚记的快照 */
  delete proj.snapshot;
  return proj;
}

/* 当前编辑的样式与其参数 */
export function curStyle() {
  if (!S.proj || !S.proj.styles?.length) return null;
  return S.proj.styles.find((s) => s.id === S.styleId) || S.proj.styles[0];
}

let saveTimer = null;
export function scheduleSave() {
  if (!S.proj) return;
  S.saveState = '未保存…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 900);
}

let lastSnapCheck = 0;
export async function saveNow() {
  if (!S.proj) return;
  try {
    await api('PUT', `/api/projects/${S.proj.id}`, { project: S.proj });
    S.saveState = '已保存 ✓';
    /* 配置可能刚被改过 → 顺手重算一次「与快照的差异」，顶栏徽标跟手（1.5s 节流） */
    if (S.snapshot.has) {
      const now = Date.now();
      if (now - lastSnapCheck > 1500) { lastSnapCheck = now; act.loadSnapshot(); }
    }
  } catch (e) { toast('保存失败: ' + e.message, true); }
}

export const act = {
  async loadProjects() {
    S.projects = (await api('GET', '/api/projects')).items;
  },
  async loadTarget() {
    try { S.target = await api('GET', '/api/target'); } catch (e) { S.target = null; }
  },
  async saveTarget(payload) {
    const d = await api('PUT', '/api/target', payload);   // { host, key }
    S.target = d;
    toast('发布目标已保存: ' + d.host);
  },
  async newProject(name) {
    const d = await api('POST', '/api/projects', { name: name || '未命名插件' });
    await act.loadProjects();
    await act.openProject(d.project.id);
    toast('项目已创建');
  },
  async openProject(id) {
    try {
      await saveNow();
      S.proj = normalize(await api('GET', `/api/projects/${id}`));
      S.styleId = S.proj.styles[0]?.id || null;
      S.panel = null;
      S.view = 'editor';
      syncHash(id);
      await act.loadProjects();
      await act.loadModels();
      await act.loadSnapshot();
    } catch (e) {
      toast('打开失败: ' + e.message, true);
      syncHash(null);
      S.view = 'home';
    }
  },
  async goHome() {
    await saveNow();
    S.view = 'home';
    S.proj = null;
    S.snapshot = { has: false, at: '', label: '', version: '', stale: false, changeCount: 0,
      scopes: { settings: 0, styles: 0, fields: 0 }, summary: [], hint: '' };
    syncHash(null);
    await act.loadProjects();
  },
  async deleteProject(id) {
    await api('DELETE', `/api/projects/${id}`);
    if (S.proj && S.proj.id === id) S.proj = null;
    await act.loadProjects();
  },
  async copyProject(id, name) {
    const d = await api('POST', `/api/projects/${id}/copy`, { name });
    await act.loadProjects();
    return d.project;
  },
  async renameProject(id, name) {
    const proj = normalize(await api('GET', `/api/projects/${id}`));
    proj.name = name;
    if (proj.plugin) proj.plugin.name = name;   // 插件名称跟着项目名称走
    await api('PUT', `/api/projects/${id}`, { project: proj });
    await act.loadProjects();
  },
  /* 编辑页渲染快照 → 存进项目目录 preview.png（启动页卡片读这张图，不做现场渲染） */
  async savePreview(dataUrl) {
    if (!S.proj || !dataUrl || !dataUrl.startsWith('data:image/png;base64,')) return;
    const b64 = dataUrl.slice('data:image/png;base64,'.length);
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    await api('PUT', `/api/projects/${S.proj.id}/preview.png`, buf, true);
  },
  /* ---- 配置快照（属性 + 字段 + 样式）----
   * 快照由服务端存进 project.json 的 snapshot 字段；这里只维护对账状态。
   * stale=true：快照之后配置改过 → 代码大概率还是按旧配置写的，发布前要提醒重新生成 */
  async loadSnapshot() {
    if (!S.proj) return null;
    try {
      const d = await api('GET', `/api/projects/${S.proj.id}/snapshot`);
      S.snapshot = {
        has: !!d.hasSnapshot,
        at: (d.snapshot && d.snapshot.at) || '',
        label: (d.snapshot && d.snapshot.label) || '',
        version: (d.snapshot && d.snapshot.version) || '',
        stale: !!d.stale,
        changeCount: d.changeCount || 0,
        scopes: d.scopes || { settings: 0, styles: 0, fields: 0 },
        summary: d.summary || [],
        hint: d.hint || '',
      };
      return S.snapshot;
    } catch (e) { return null; }
  },
  async takeSnapshot(label) {
    if (!S.proj) return null;
    await saveNow();   // 面板改动是防抖保存的，先落盘再记快照，否则记到的是旧值
    const d = await api('PUT', `/api/projects/${S.proj.id}/snapshot`, { label: label || '' });
    await act.loadSnapshot();
    toast(d.replaced ? '已用当前配置覆盖旧快照' : '已记录配置快照');
    return d;
  },
  copyStyle(id) {
    if (!S.proj) return null;
    const src = S.proj.styles.find((s) => s.id === id) || curStyle();
    if (!src) return null;
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = 'style' + (S.proj.styles.length + 1) + '_' + Math.random().toString(36).slice(2, 5);
    copy.name = (src.name || src.id) + ' 副本';
    S.proj.styles.push(copy);
    S.styleId = copy.id;    // 切到副本上编辑
    scheduleSave();
    toast('已复制样式为「' + copy.name + '」');
    return copy;
  },
  removeStyle(id) {
    if (!S.proj) return false;
    if (S.proj.styles.length <= 1) { toast('至少保留一个样式', true); return false; }
    const i = S.proj.styles.findIndex((s) => s.id === id);
    if (i < 0) return false;
    S.proj.styles.splice(i, 1);
    if (S.styleId === id) S.styleId = S.proj.styles[0].id;
    scheduleSave();
    return true;
  },
  addField() {
    S.proj.fields.push({
      key: '', label: '', domains: [], placeholder: '', tip: '',
      valueType: 'text', enumValues: [],
    });
    scheduleSave();
  },
  addOption() {
    const st = curStyle();
    if (!st) return;
    st.options.push({ key: '', label: '', type: 'range', def: '', min: 0, max: 1, step: 0.1, choices: [], tip: '' });
    scheduleSave();
  },
  /* 背景插件：一键加上 ha-3d-home 插件引擎保留的偏移参数（与 home 的 K.offsetOpts() 定义保持一致，
   * 见 ha-3d-home/public/js/plugins.js）。已有同名 key 的跳过，不重复添加。 */
  addOffsetOpts() {
    const st = curStyle();
    if (!st) return;
    if (!Array.isArray(st.options)) st.options = [];
    const defs = [
      { key: 'offsetX', label: '东西偏移', type: 'range', min: -30, max: 30, step: 0.5, def: 0, tip: '房屋在背景画面里东/西偏多少米（+西 = 往右拖背景左移，房屋相对偏东）' },
      { key: 'offsetZ', label: '南北偏移', type: 'range', min: -30, max: 30, step: 0.5, def: 0, tip: '房屋在背景画面里南/北偏多少米（+北 = 往右拖背景上移，房屋相对偏南）' },
    ];
    let added = 0;
    defs.forEach((o) => {
      if (st.options.some((x) => x && x.key === o.key)) return;
      st.options.push(JSON.parse(JSON.stringify(o)));
      added++;
    });
    if (!added) { toast('当前样式已包含偏移参数', true); return; }
    scheduleSave();
    toast('已添加偏移参数（offsetX / offsetZ）');
  },
  async importFile(file) {
    if (!S.proj) return;
    const buf = await file.arrayBuffer();
    await api('PUT', `/api/projects/${S.proj.id}/models/${encodeURIComponent(file.name)}`, buf, true);
    await act.loadModels();
  },
  async importFiles(files) {
    let ok = 0;
    for (const f of files) {
      if (!f.name.toLowerCase().endsWith('.glb')) { toast('仅支持 .glb: ' + f.name, true); continue; }
      try { await act.importFile(f); ok += 1; } catch (e) { toast('导入失败: ' + f.name + ' ' + e.message, true); }
    }
    if (ok) toast(`已导入 ${ok} 个模型`);
  },
  /* ---- 模型文件库 ---- */
  async loadModels() {
    if (!S.proj) { S.models = []; return; }
    try { S.models = (await api('GET', `/api/projects/${S.proj.id}/models`)).files; }
    catch (e) { S.models = []; }
  },
  async deleteModel(file) {
    if (!S.proj) return;
    try { await api('DELETE', `/api/projects/${S.proj.id}/models/${encodeURIComponent(file)}`); } catch (e) { toast('删除失败: ' + e.message, true); }

    await act.loadModels();
    toast('已删除: ' + file);
  },
  /* 修复 GLB 材质过暗（metallic 偏高 / sRGB 未转换 / 压暗扩展） */
  async fixMaterial(file) {
    if (!S.proj || !file) return;
    S.fixing = true;
    try {
      const r = await api('POST', `/api/projects/${S.proj.id}/models/${encodeURIComponent(file)}/fix-materials`);
      toast(r.message);
      bumpModel(S.proj.id, file);   // 清缩略图缓存并刷新预览/画布
    } catch (e) {
      toast('修复失败: ' + e.message, true);
    } finally {
      S.fixing = false;
    }
  },
  /* 文件库中直接拆分多节点 GLB：服务端把每个 node 导出为独立 .glb 加入文件库（不动画布部件） */
  async splitModelFile(file) {
    if (!S.proj) return;
    try {
      const r = await api('POST', `/api/projects/${S.proj.id}/models/${encodeURIComponent(file)}/split`);
      await act.loadModels();
      toast(`已拆分「${file}」为 ${r.files.length} 个独立模型，已加入文件库（原文件保留；画布中引用原文件的部件不受影响）`);
    } catch (e) {
      toast('拆分失败: ' + e.message, true);
    }
  },
  /* 文件库：只把指定节点导出为一个独立 .glb（原文件不动，画布部件不受影响） */
  async splitModelNode(file, nodeName) {
    if (!S.proj) return;
    try {
      const r = await api('POST', `/api/projects/${S.proj.id}/models/${encodeURIComponent(file)}/split`, { node: nodeName });
      await act.loadModels();
      toast(`已把节点「${r.node}」导出为 ${r.files[0].file}（原文件保留）`);
    } catch (e) {
      toast('拆分失败: ' + e.message, true);
    }
  },
  async publish(bump) {
    if (S.publishing) return;
    S.publishing = true;
    try {
      await saveNow();
      const d = await api('POST', `/api/projects/${S.proj.id}/publish`, { bump });
      if (S.proj) S.proj.plugin.version = d.manifest.version;
      bigToast('发布成功', `已安装到 ${d.host}（v${d.manifest.version}${d.copied.length ? '，模型 ' + d.copied.length + ' 个' : ''}）`);
      /* 发布时会顺带算一次配置漂移，回来刷新顶栏快照状态 */
      if (d.drift) await act.loadSnapshot();
    } finally {
      S.publishing = false;
    }
  },
  /* 导出插件压缩包（与远程安装同一份 zip 内容，仅下载不改版本号） */
  async exportZip() {
    if (S.publishing) return;
    S.publishing = true;
    try {
      await saveNow();
      const r = await fetch(`/api/projects/${S.proj.id}/export`);
      if (!r.ok) {
        let m = await r.text();
        try { m = JSON.parse(m).error || m; } catch (e) { /* 原样展示 */ }
        throw new Error(m);
      }
      const blob = await r.blob();
      const mm = /filename="?([^";]+)"?/.exec(r.headers.get('Content-Disposition') || '');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = mm ? mm[1] : (S.proj.plugin.id + '.zip');
      a.click();
      URL.revokeObjectURL(a.href);
      /* 服务端打包时也算了一次漂移（兜底：前端点击前没查到的情形） */
      const driftCount = Number(r.headers.get('X-Config-Drift-Count') || 0);
      if (r.headers.get('X-Config-Drift') === '1') {
        toast(`已导出 ${a.download}（提示：配置有 ${driftCount} 处改动未重新生成，包内还是旧效果）`, true);
      } else {
        toast('已导出 ' + a.download);
      }
      await act.loadSnapshot();
    } finally {
      S.publishing = false;
    }
  },
  /* 导出项目备份：整个项目文件夹（project.json + preview.png + models/）原样打包下载（可再导入还原） */
  async exportProjectZip() {
    if (S.publishing) return;
    S.publishing = true;
    try {
      await saveNow();
      const r = await fetch(`/api/projects/${S.proj.id}/export-project`);
      if (!r.ok) {
        let m = await r.text();
        try { m = JSON.parse(m).error || m; } catch (e) { /* 原样展示 */ }
        throw new Error(m);
      }
      const blob = await r.blob();
      const mm = /filename="?([^";]+)"?/.exec(r.headers.get('Content-Disposition') || '');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = mm ? mm[1] : (S.proj.id + '-project.zip');
      a.click();
      URL.revokeObjectURL(a.href);
      toast('已导出项目备份 ' + a.download);
    } finally {
      S.publishing = false;
    }
  },
  /* 导入项目：上传「导出项目」备份 zip，服务端还原成新项目（id 冲突自动换新） */
  async importProject(file) {
    if (S.publishing) return;
    S.publishing = true;
    try {
      const r = await fetch('/api/projects/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      await act.loadProjects();
      toast('已导入项目「' + (d.name || d.id) + '」(' + d.id + ')');
    } finally {
      S.publishing = false;
    }
  },
};

/* 点击「模型文件库」列表项以外的任意位置 → 取消预览高亮
   （#center 内由视口自己管理，浮层面板内的点击不算外部） */
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => {
    if (!S.previewFile) return;
    const t = e.target;
    if (t && t.closest && t.closest('.parts-ul li, #float-panel, #center')) return;
    S.previewFile = '';
    S.previewNode = '';
  }, true);
}

/* ---- hash 路由: #/ = 启动页, #/project/<id> = 编辑页（刷新/直链不丢状态） ---- */
function syncHash(id) {
  const h = id ? '#/project/' + id : '#/';
  if (location.hash !== h) location.hash = h;
}
function routeFromHash() {
  const m = /^#\/project\/([A-Za-z0-9_-]+)/.exec(location.hash);
  return m ? m[1] : null;
}
async function syncRoute() {
  const id = routeFromHash();
  if (id) {
    if (S.view !== 'editor' || !S.proj || S.proj.id !== id) await act.openProject(id);
  } else if (S.view === 'editor') {
    await act.goHome();
  }
}
export function initRoute() {
  window.addEventListener('hashchange', () => { syncRoute().catch((e) => toast(e.message, true)); });
  return syncRoute().catch((e) => toast(e.message, true));
}
