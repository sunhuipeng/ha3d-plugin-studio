/* ha3d-plugin-studio 前端全局状态与动作 */
import { reactive } from 'vue';
import { bumpModel } from './thumb';
import { normalizeOptionType, stripExtraOptionKeys } from './option-schema';
import { normalizeField } from './field-schema';
import { diffConfig } from './config-diff';
import { FALLBACK_CATALOG_TYPES, normalizeItem, newItemFromModel } from './catalog';

/* 设备类插件（kind:'device'）可选的 type：
 *   DEVICE_TYPES —— HA 实体域（灯/开关/空调…）
 *   WALL_TYPES   —— 贴墙设备：门 / 窗。它们**没有独立的 kind**，就是 type 不同的设备类，
 *                   只是数据放在 home 的 floors.doors/windows 里、默认不显示 3D 标签。
 * OPENING_TYPES 是旧名字（面板与脚本仍在用），等价于 WALL_TYPES。 */
export const DEVICE_TYPES = ['light', 'switch', 'sensor', 'climate', 'water_heater', 'cover', 'fan', 'media_player', 'vacuum', 'camera', 'other'];
export const WALL_TYPES = ['door', 'window'];
export const OPENING_TYPES = WALL_TYPES;
export const MODEL_TYPES = DEVICE_TYPES.concat(WALL_TYPES);
export const isWallType = (t) => t === 'door' || t === 'window';
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
  /* 引擎运行后的内存镜像（live 引用，reactive 包装 def.styles / def.fields）：
   * UI（样式胶囊 / 左下面板卡片 / MCP）读这里 —— AI 代码声明什么就显示什么。
   * 保存时 fullSyncEngineToProject() 把它全量覆盖进项目 JSON（内存镜像存档）。
   * 每次渲染/重生成功后 syncEngineMirror() 重建。 */
  engineStyles: null,
  engineFields: null,
  toast: { show: false, msg: '', err: false },
  mcp: { active: false, connected: false, text: '', busy: false },  // MCP 连接/调用提示横条（前端顶部）
  /* 配置锁（服务端内存态，见 server/lock.js）：locked 时左侧浮层只读，
   * 避免人和 AI 同时改配置互相覆盖。by = 'mcp'（AI 改）/ 'user'（人改） */
  lock: { locked: false, by: '', at: 0, note: '' },
  publishing: false,                                   // 发布/导出进行中（禁用发布按钮 + 等待动画）
  bigToast: { show: false, title: '', detail: '' },    // 居中大横幅成功提示（发布成功等）
  /* 配置漂移对账状态（客户端算，见 refreshDrift）：
   * 基线 = 代码加载时（合并项目 JSON 前）的 styles/fields 深拷贝（def._baseline）；
   * stale = 当前引擎内存与基线不同 → 顶栏「配置已变更 N 处」 */
  snapshot: {
    has: false, stale: false, changeCount: 0,
    scopes: { styles: 0, fields: 0 },
    summary: [], hint: '',
  },
  codeBaseline: null,   // { styles, fields } 纯数据；渲染成功后从 def._baseline 取
  /* 家具项目（kind:'catalog'）分类下拉：来自 GET /catalog-types（studio 服务端优先向
   * ha-3d-home 的 /api/catalog 取，取不到才用本地兜底表）。source = 'home' | 'fallback' */
  catalogTypes: FALLBACK_CATALOG_TYPES.slice(),
  catalogTypesSource: '',
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

/* ---- 配置锁（只作用于当前页面）----
 * 纯前端状态：锁定期间左侧所有浮层只读（样式层 + CSS 双保险）、本地改动不落盘，
 * 免得用旧内存覆盖 AI 刚写进 project.json 的配置。
 * 服务端既不存也不判：刷新 / 重开页面一律回到未锁，永远不会「锁死解不开」。 */
export function applyLock(st) {
  if (!st) { S.lock = { locked: false, by: '', at: 0, note: '' }; return; }
  S.lock = {
    locked: !!st.locked,
    by: st.by || '',
    at: Number(st.at) || 0,
    note: st.note || '',
  };
}

/* 锁是谁的：AI 还是人（提示文案用） */
export function lockByText() {
  return S.lock.by === 'mcp' ? 'AI' : '你';
}

let lockTipAt = 0;
/* 锁定期间的写操作统一拦在这一层（UI 之外的双保险） */
function denyWhenLocked() {
  if (!S.lock.locked) return false;
  if (Date.now() - lockTipAt > 2500) {
    lockTipAt = Date.now();
    toast('配置已锁定（' + lockByText() + '正在改）：左侧面板只读，解锁后才能编辑', true);
  }
  return true;
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
  /* 统一插件类迁移：门/窗原先的 kind:'opening' 已废除，改为 kind:'device' + type door/window。
     打开老项目时静默升级，代码里残留的 kind:'opening' 由引擎注册时归一 */
  if (proj.plugin.kind === 'opening') proj.plugin.kind = 'device';
  if (!proj.plugin.kind) proj.plugin.kind = 'device';
  /* 背景类没有实体类型（面板里 type 输入框是隐藏的）：值统一固定成 'bg' */
  if (proj.plugin.kind === 'background') proj.plugin.type = 'bg';
  /* 家具项目（kind:'catalog'）：结构与插件项目完全不同 —— 只有 catalog.items（一个 glb 一条），
   * 没有样式 / 字段 / 代码 / 选项。这里提前返回，别把插件那套默认值灌进去。 */
  if (proj.plugin.kind === 'catalog') {
    proj.catalog = (proj.catalog && typeof proj.catalog === 'object') ? proj.catalog : {};
    proj.catalog.items = (Array.isArray(proj.catalog.items) ? proj.catalog.items : [])
      .filter((x) => x && typeof x === 'object').map(normalizeItem);
    if (!proj.plugin.version) proj.plugin.version = '1.0.0';
    delete proj.snapshot;
    return proj;
  }
  proj.styles ||= [{ id: 'default', name: proj.plugin.name || '默认造型', z: 0, icon: '', desc: '', options: [] }];
  for (const s of proj.styles) {
    if (!Array.isArray(s.options)) s.options = [];
    for (const o of s.options) {
      /* type 归一化 + 按「类型 → 字段」表剔除不适用键（min/max/step/choices）：
       * 老存档里的历史脏数据（如非 range 参数带着 min/max）打开时即清掉 */
      if (!o || typeof o !== 'object') continue;
      o.type = normalizeOptionType(o.type);
      stripExtraOptionKeys(o, o.type);
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

/* UI 读的样式/字段列表：引擎内存优先（运行后的真实数据），没渲染过 / 渲染失败时回落项目配置 */
export function engineList() {
  if (S.engineStyles && S.engineStyles.length) return S.engineStyles;
  return (S.proj && S.proj.styles) || [];
}
export function engineFieldList() {
  if (S.engineFields && S.engineFields.length) return S.engineFields;
  return (S.proj && S.proj.fields) || [];
}

/* 渲染成功后由 PluginStage 调：把引擎内存 def.styles / def.fields 包装成 reactive 给 UI。
 * 是 live 引用：UI 通过它改值，引擎 spawn 时读到的就是新值（respawn 即时生效）。
 * 同时取代码基线（def._baseline，applyProjectConfig 合并前深拷贝的那份）做漂移对账。 */
export function syncEngineMirror(preview) {
  if (!preview || !preview.def) {
    S.engineStyles = null; S.engineFields = null; S.codeBaseline = null; return;
  }
  S.engineStyles = reactive(preview.def.styles || []);
  S.engineFields = reactive(preview.def.fields || []);
  S.codeBaseline = preview.def._baseline || null;
  refreshDrift();
}

/* 漂移对账：当前引擎内存 vs 代码基线 → 顶栏「配置已变更 N 处」。
 * 触发点：渲染成功（syncEngineMirror）、每次保存（值/结构改动落盘时） */
function refreshDrift() {
  const base = S.codeBaseline;
  if (!base || !S.engineStyles) {
    S.snapshot = { has: false, stale: false, changeCount: 0, scopes: { styles: 0, fields: 0 }, summary: [], hint: '' };
    return;
  }
  const d = diffConfig(base.styles, base.fields, S.engineStyles || [], S.engineFields || [],
    S.proj && S.proj.plugin && S.proj.plugin.kind);
  S.snapshot = {
    has: true,
    stale: d.changeCount > 0,
    changeCount: d.changeCount,
    scopes: d.scopes,
    summary: d.summary,
    hint: '',
  };
}

/* 当前编辑的样式与其参数（引擎内存优先） */
export function curStyle() {
  const list = engineList();
  if (!list.length) return null;
  return list.find((s) => s.id === S.styleId) || list[0];
}

let saveTimer = null;
export function scheduleSave() {
  if (!S.proj) return;
  /* 锁只作用在左侧浮层面板（那边控件已只读）；中间编辑区（左下角参数卡等）照常可改可存，
     所以这里不拦保存 —— 拦住反而会让合法改动只留在内存里。 */
  S.saveState = '未保存…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 900);
}

/* 全量覆盖：保存前把引擎内存的 styles / fields 序列化进项目 JSON。
 * JSON = 配置唯一事实源（结构与数据的来源，加载时按它重建 def）；
 * 函数属性（背景 apply 等）无法序列化，恢复时由代码侧提供。 */
function fullSyncEngineToProject() {
  if (!S.proj || !S.engineStyles) return;   // 没渲染过 → JSON 保持原样
  S.proj.styles = S.engineStyles.filter((s) => s && s.id).map((s) => {
    const out = { id: s.id, name: s.name || s.id };
    ['icon', 'desc', 'z', 'labelOffset', 'refresh'].forEach((k) => {
      if (s[k] !== undefined) out[k] = s[k];
    });
    out.options = (s.options || []).filter((o) => o && typeof o === 'object' && o.key)
      .map((o) => JSON.parse(JSON.stringify(o)));
    return out;
  });
  S.proj.fields = (S.engineFields || []).filter((f) => f && f.key)
    .map((f) => JSON.parse(JSON.stringify(f)));
}

export async function saveNow(opts) {
  if (!S.proj) return;
  try {
    fullSyncEngineToProject();
    await api('PUT', `/api/projects/${S.proj.id}`, { project: S.proj });
    S.saveState = '已保存 ✓';
    refreshDrift();   // 值/结构可能刚改过 → 顶栏「配置已变更」跟手
  } catch (e) {
    toast('保存失败: ' + e.message, true);
    if (opts && opts.throwOnError) throw e;   // MCP 同步要拿到真错误，不能静默成功
  }
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
  /* 新建项目：kind 在创建时定死（device / background / catalog），之后不可改 */
  async newProject(name, kind) {
    const k = kind || 'device';
    const d = await api('POST', '/api/projects', { name: name || '未命名项目', kind: k });
    await act.loadProjects();
    await act.openProject(d.project.id);
    toast('项目已创建');
  },
  async openProject(id) {
    try {
      await saveNow();
      S.proj = normalize(await api('GET', `/api/projects/${id}`));
      S.engineStyles = null;
      S.engineFields = null;
      S.codeBaseline = null;   // 新项目还没渲染，等渲染成功后从新代码取基线
      S.snapshot = { has: false, stale: false, changeCount: 0, scopes: { styles: 0, fields: 0 }, summary: [], hint: '' };
      /* 家具项目没有 styles（normalize 提前返回），这里不能裸取 [0] */
      S.styleId = (Array.isArray(S.proj.styles) && S.proj.styles[0] && S.proj.styles[0].id) || null;
      S.panel = null;
      S.view = 'editor';
      syncHash(id);
      await act.loadProjects();
      await act.loadModels();
      if (S.proj.plugin.kind === 'catalog') act.loadCatalogTypes().catch(() => {});
      await act.loadLock();   // 打开 / 刷新页面一律未锁（锁是纯前端状态，不继承）
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
    applyLock(null);
    S.engineStyles = null;
    S.engineFields = null;
    S.codeBaseline = null;
    S.snapshot = { has: false, stale: false, changeCount: 0, scopes: { styles: 0, fields: 0 }, summary: [], hint: '' };
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
  /* ---- 配置漂移（内存 vs 代码基线）----
   * 基线在渲染成功时从 def._baseline 取（代码解析后、合并 JSON 前的深拷贝），
   * 不再落盘快照；点徽标「以当前内存为准」= 重置基线、清掉已变更标记。 */
  rebaseline() {
    if (!S.engineStyles && !S.engineFields) { toast('还没有渲染过，没有可记的基准', true); return; }
    S.codeBaseline = {
      styles: JSON.parse(JSON.stringify(S.engineStyles || [])),
      fields: JSON.parse(JSON.stringify(S.engineFields || [])),
    };
    refreshDrift();
    toast('已把当前配置记为新基准');
  },
  copyStyle(id) {
    if (denyWhenLocked()) return null;
    if (!S.proj) return null;
    const list = engineList();
    const src = list.find((s) => s.id === id) || curStyle();
    if (!src) return null;
    /* 保留函数属性（背景样式的 apply 是渲染主体，JSON 克隆会丢掉） */
    const copy = {};
    for (const k in src) {
      copy[k] = k === 'options' ? JSON.parse(JSON.stringify(src.options || [])) : src[k];
    }
    copy.id = 'style' + (list.length + 1) + '_' + Math.random().toString(36).slice(2, 5);
    copy.name = (src.name || src.id) + ' 副本';
    /* 项目配置（基础层，持久化）+ 引擎内存（respawn 立即生效）两边都加 */
    const plain = JSON.parse(JSON.stringify({
      id: copy.id, name: copy.name, z: copy.z, labelOffset: copy.labelOffset,
      refresh: copy.refresh, icon: copy.icon, desc: copy.desc, options: copy.options,
    }));
    S.proj.styles.push(plain);
    if (S.engineStyles) S.engineStyles.push(copy);
    S.styleId = copy.id;    // 切到副本上编辑
    scheduleSave();
    toast('已复制样式为「' + copy.name + '」');
    return copy;
  },
  /* 删除样式：项目配置与引擎内存里都直接摘掉（配置是唯一事实源，代码里仍声明也不会复活） */
  removeStyle(id) {
    if (denyWhenLocked()) return false;
    if (!S.proj) return false;
    if (engineList().length <= 1) { toast('至少保留一个样式', true); return false; }
    const list = S.proj.styles || [];
    const i = list.findIndex((x) => x && x.id === id);
    if (i >= 0) list.splice(i, 1);
    if (S.engineStyles) {
      const j = S.engineStyles.findIndex((s) => s && s.id === id);
      if (j >= 0) S.engineStyles.splice(j, 1);
    }
    if (S.styleId === id) {
      const rest = engineList();
      S.styleId = rest[0] ? rest[0].id : null;
    }
    scheduleSave();
    return true;
  },
  /* 删除一条样式参数：内存与项目配置里同时摘掉（没填 key 的草稿条目只在内存里） */
  removeOption(styleId, opt) {
    if (denyWhenLocked()) return;
    if (!S.proj || !opt) return;
    const s = engineList().find((x) => x && x.id === styleId);
    if (s && Array.isArray(s.options)) {
      const i = s.options.indexOf(opt);
      if (i >= 0) s.options.splice(i, 1);
    }
    if (opt.key) {
      const ps = (S.proj.styles || []).find((x) => x && x.id === styleId);
      if (ps && Array.isArray(ps.options)) {
        const j = ps.options.findIndex((o) => o && o.key === opt.key);
        if (j >= 0) ps.options.splice(j, 1);
      }
    }
    scheduleSave();
  },
  /* 删除字段：同 removeOption 口径（内存 + 项目配置同时摘掉） */
  removeField(f) {
    if (denyWhenLocked()) return;
    if (!S.proj || !f) return;
    if (S.engineFields) {
      const i = S.engineFields.indexOf(f);
      if (i >= 0) S.engineFields.splice(i, 1);
    }
    const list = S.proj.fields || [];
    const j = f.key ? list.findIndex((x) => x && x.key === f.key) : list.indexOf(f);
    if (j >= 0) list.splice(j, 1);
    scheduleSave();
  },
  addField() {
    if (denyWhenLocked()) return;
    const f = { key: '', label: '', domains: [], placeholder: '', tip: '', valueType: 'text', enumValues: [] };
    S.proj.fields.push(f);
    /* 同一对象进内存 def.fields：字段编辑既立即生效又直接持久化 */
    if (S.engineFields) S.engineFields.push(f);
    scheduleSave();
  },
  addOption() {
    if (denyWhenLocked()) return;
    const st = curStyle();
    if (!st) return;
    const o = { key: '', label: '', type: 'range', def: '', min: 0, max: 1, step: 0.1, choices: [], tip: '' };
    /* 项目配置里有这个样式 → 参数进 JSON（基础层，持久化）；内存同步加，respawn 立即可调 */
    const ps = (S.proj.styles || []).find((x) => x && x.id === st.id);
    if (ps) {
      if (!Array.isArray(ps.options)) ps.options = [];
      ps.options.push(o);
    }
    if (!Array.isArray(st.options)) st.options = [];
    st.options.push(o);
    scheduleSave();
  },
  /* 背景插件：一键加上 ha-3d-home 插件引擎保留的偏移参数（与 home 的 K.offsetOpts() 定义保持一致，
   * 见 ha-3d-home/public/js/plugins.js）。已有同名 key 的跳过，不重复添加。 */
  addOffsetOpts() {
    if (denyWhenLocked()) return;
    const st = curStyle();
    if (!st) return;
    const defs = [
      { key: 'offsetX', label: '东西偏移', type: 'range', min: -30, max: 30, step: 0.5, def: 0, tip: '房屋在背景画面里东/西偏多少米（+西 = 往右拖背景左移，房屋相对偏东）' },
      { key: 'offsetZ', label: '南北偏移', type: 'range', min: -30, max: 30, step: 0.5, def: 0, tip: '房屋在背景画面里南/北偏多少米（+北 = 往右拖背景上移，房屋相对偏南）' },
    ];
    const ps = (S.proj.styles || []).find((x) => x && x.id === st.id);
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
    if (!added) { toast('当前样式已包含偏移参数', true); return; }
    scheduleSave();
    toast('已添加偏移参数（offsetX / offsetZ）');
  },
  async importFile(file) {
    if (denyWhenLocked()) return;
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
  /* ---- 配置锁（纯前端）---- */
  /* 打开项目 / 刷新页面时调用：一律从未锁开始，避免「一进来就锁着、再也解不开」 */
  async loadLock() {
    applyLock(null);
  },
  /* 人点按钮改锁：只改当前页面状态，不写服务端、不广播（刷新即恢复可编辑） */
  async setLock(locked) {
    if (S.lock.locked === !!locked) return;
    applyLock({ locked: !!locked, by: 'user', at: Date.now(), note: '' });
    if (S.lock.locked) toast('配置已锁定：左侧面板转为只读，避免和 AI 同时改配置');
    else { S.saveState = ''; toast('配置已解锁：可以手动编辑了'); }
  },
  /* ---- 模型文件库 ---- */
  async loadModels() {
    if (!S.proj) { S.models = []; return; }
    try { S.models = (await api('GET', `/api/projects/${S.proj.id}/models`)).files; }
    catch (e) { S.models = []; }
  },
  async deleteModel(file) {
    if (denyWhenLocked()) return;
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
    if (denyWhenLocked()) return;
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
    if (denyWhenLocked()) return;
    if (!S.proj) return;
    try {
      const r = await api('POST', `/api/projects/${S.proj.id}/models/${encodeURIComponent(file)}/split`, { node: nodeName });
      await act.loadModels();
      toast(`已把节点「${r.node}」导出为 ${r.files[0].file}（原文件保留）`);
    } catch (e) {
      toast('拆分失败: ' + e.message, true);
    }
  },
  /* ---- 家具项目（kind: 'catalog'）：清单在 proj.catalog.items，一个 glb 一条 ---- */
  async loadCatalogTypes() {
    try {
      const d = await api('GET', '/api/catalog-types');
      if (Array.isArray(d.types) && d.types.length) {
        S.catalogTypes = d.types;
        S.catalogTypesSource = d.source || '';
      }
    } catch (e) { /* home 没连上也别拦着：用兜底表 */ }
  },
  catalogItems() {
    return (S.proj && S.proj.catalog && Array.isArray(S.proj.catalog.items)) ? S.proj.catalog.items : [];
  },
  /* 模型导入后调用：按文件名生成条目 id / 显示名，尺寸用实测包围盒（没有就默认值）
   * displayName 可传原始文件名（上传时文件名会被 ASCII 化，展示名仍用用户看到的那份） */
  addCatalogItem(file, size, displayName) {
    if (!S.proj || !S.proj.plugin || S.proj.plugin.kind !== 'catalog') return null;
    S.proj.catalog ||= {};
    if (!Array.isArray(S.proj.catalog.items)) S.proj.catalog.items = [];
    const taken = new Set(S.proj.catalog.items.map((x) => x && x.id));
    const it = newItemFromModel(file, size, taken);
    if (displayName) it.name = String(displayName).slice(0, 40);
    S.proj.catalog.items.push(it);
    scheduleSave();
    return it;
  },
  removeCatalogItem(id) {
    if (!S.proj || !S.proj.catalog || !Array.isArray(S.proj.catalog.items)) return;
    const list = S.proj.catalog.items;
    const i = list.findIndex((x) => x && x.id === id);
    if (i < 0) return;
    list.splice(i, 1);
    scheduleSave();
  },
  /* 条目换了模型文件：id 不跟着变（已导出的包靠 id 稳定），只改引用 */
  /* 导出家具包：item.json + 各条目引用的 glb（home 侧直接「导入插件」或用远程安装） */
  async catalogExport() {
    if (S.publishing || !S.proj) return;
    S.publishing = true;
    try {
      await saveNow();
      const r = await fetch(`/api/projects/${S.proj.id}/export-catalog`);
      if (!r.ok) {
        let m = await r.text();
        try { m = JSON.parse(m).error || m; } catch (e) { /* 原样展示 */ }
        throw new Error(m);
      }
      const blob = await r.blob();
      const mm = /filename="?([^";]+)"?/.exec(r.headers.get('Content-Disposition') || '');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = mm ? mm[1] : (S.proj.id + '.zip');
      a.click();
      URL.revokeObjectURL(a.href);
      toast('已导出 ' + a.download);
    } finally {
      S.publishing = false;
    }
  },
  /* 发布家具包到 ha-3d-home：走同一个远程安装接口，home 按 kind 分流到 custom/models/<项目id>/ */
  async catalogPublish(bump) {
    if (S.publishing || !S.proj) return;
    S.publishing = true;
    try {
      await saveNow();
      const d = await api('POST', `/api/projects/${S.proj.id}/publish-catalog`, { bump: !!bump });
      if (S.proj) S.proj.plugin.version = d.manifest.version;
      S.saveState = '已保存 ✓';
      bigToast('发布成功', `已安装到 ${d.host}（${d.count} 件家具，v${d.manifest.version}）`);
    } finally {
      S.publishing = false;
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
      toast('已导出 ' + a.download);
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
