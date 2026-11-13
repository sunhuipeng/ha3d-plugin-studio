/* 前端 ↔ Node 服务端 WebSocket 中继客户端
 *
 * MCP 工具经服务端转发到这里执行：
 *   { type:'tool', id, name, args }  → 本地执行 → { type:'tool_result', id, ok, result }
 * 服务端还可能发：
 *   { type:'refresh', what:'models' }                                → 局部刷新模型列表
 *   { type:'refresh', what:'catalog' }                               → MCP 改了家具清单：重拉配置覆盖内存 + 重载预览
 *   { type:'mcp', event:'connected'|'activity'|'disconnected', tool? } → 顶部横条提示
 */
import { watch } from 'vue';
import { S, act, api, viewportApi, engineList, scheduleSave, cancelPendingSave, applyLock, toast } from './store';
import { bumpModel } from './thumb';
import { readRuntimeLog, runtimeLogStats, clearRuntimeLog, setRuntimeProjectGetter } from './runtime-log';

/* 让运行期日志带上项目标记（切项目后不会串到别的项目上） */
setRuntimeProjectGetter(() => (S.proj && S.proj.id) || '');

/* 服务端固定 8098；页面可能跑在 5175(dev) 或 8098(生产) */
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:8098/ws`;

let ws = null;
let retry = 0;
let retryTimer = null;
/* 被 MCP「单窗口收敛」关掉后不再重连（否则服务端一断开，它又连回来） */
let shuttingDown = false;
/* 本页在服务端的 clientId（welcome 里给），用于识别「关闭指令是不是发给自己的」 */
let myClientId = '';

/* 页面（标签页）身份：**同一个页面里所有 socket 共用一个 pageId**。
 * 为什么需要它：initWs() 在 App.vue 顶层调用，HMR 重新执行本模块时会再建一条 socket，
 * 旧 socket 不关 → 服务端会看到「同一页面 = 多个连接」。单窗口收敛必须按页面去重，
 * 否则会把同一页面的旧连接当多余页面，发一条关闭指令就让用户把页面关掉了。
 * 挂在 window 上而不是模块变量：模块被 HMR 重新求值后仍复用同一个 id。 */
const PAGE_ID = (() => {
  if (typeof window === 'undefined') return 'page';
  if (!window.__ha3dPageId) {
    window.__ha3dPageId = 'pg' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }
  return window.__ha3dPageId;
})();

function send(obj) {
  if (!ws || ws.readyState !== 1) return false;
  try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
}

function hello() {
  send({
    type: 'hello',
    pageId: PAGE_ID,
    projectId: S.proj?.id || '',
    projectName: S.proj?.name || '',
    visible: document.visibilityState === 'visible',
    focused: document.hasFocus(),
  });
  /* 锁是纯前端状态：断线重连 / 切项目都不需要补拉，保持现状 */
}

/* 可见 / 聚焦状态上报：studio_single_window 靠它挑「用户正在看的那个标签页」 */
function reportPresence() {
  send({
    type: 'presence',
    pageId: PAGE_ID,
    visible: document.visibilityState === 'visible',
    focused: document.hasFocus(),
  });
}

/* 收到 close_extra：断开中继（不再接收指令）→ 尝试关页面 → 关不掉就盖一层说明 */
function shutdownSelf() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearTimeout(retryTimer);
  try {
    if (ws) { ws.onclose = null; ws.onerror = null; ws.close(); }
  } catch (e) { /* ignore */ }
  ws = null;
  /* 浏览器只允许脚本关闭「由脚本打开」的页面，手动开的标签页 close() 会被忽略 */
  try { window.open('', '_self'); window.close(); } catch (e) { /* ignore */ }
  setTimeout(() => {
    if (document.visibilityState === 'hidden') return;   // 已经关掉了
    showShutdownOverlay();
  }, 300);
}

function showShutdownOverlay() {
  if (document.getElementById('hub-closed-tip')) return;
  const el = document.createElement('div');
  el.id = 'hub-closed-tip';
  el.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:99999', 'display:flex',
    'align-items:center', 'justify-content:center', 'flex-direction:column',
    'gap:14px', 'background:#14171c', 'color:#e6e9ef',
    'font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif',
    'text-align:center', 'padding:32px',
  ].join(';');
  el.innerHTML = `
    <div style="font-size:20px;font-weight:600">本标签页已被 MCP 关闭</div>
    <div style="color:#9aa4b2;max-width:520px">
      studio 只保留了一个编辑页（MCP 操作固定落在那个窗口，避免多个标签页来回跳）。<br>
      这里已经断开与 studio 的连接，不再接收任何指令。<br>
      浏览器不允许脚本关闭手动打开的标签页 —— 请直接关掉这个标签即可。
    </div>
    <button id="hub-closed-btn" style="margin-top:6px;padding:8px 20px;border-radius:8px;border:1px solid #3a4250;background:#222831;color:#e6e9ef;cursor:pointer;font-size:13px">
      关闭此页
    </button>`;
  document.body.appendChild(el);
  const btn = document.getElementById('hub-closed-btn');
  if (btn) btn.onclick = () => { try { window.open('', '_self'); window.close(); } catch (e) { /* ignore */ } };
}

/* ---- MCP 提示横条 ----
 * 现实：一次工具调用常常只有几十毫秒（studio_get_project ≈ 30ms，连接、执行、断开全在
 * 一帧内走完），如果「正在执行」按真实耗时渲染，就是肉眼看不见的闪烁，页面上只留下
 * 「MCP 已连接」的残影。所以这里做两件事：
 *   1. 「正在执行」至少展示 MCP_MIN_BUSY_MS（不足就延后收尾，保证看得见）
 *   2. 执行完保留 MCP_KEEP_DONE_MS 的「已执行：<能力>（耗时）」，下次调用直接覆盖
 * 收起条件仍是两个：会话全部断开且结果展示完，或连接期长时间没有任何动作。 */
const MCP_MIN_BUSY_MS = 900;     /* 「正在执行」最少展示时长 */
const MCP_KEEP_DONE_MS = 4000;   /* 断开后结果展示时长（一次调用一个会话，这就是余量） */
const MCP_IDLE_MS = 180000;      /* 连接期间 3 分钟无动作 → 收起 */

const mcp = { sessions: 0, busy: false, tool: '', cost: 0, since: 0 };
let mcpTimer = null;      /* 收起 / 结果过期的定时器 */
let mcpPending = null;    /* 「正在执行」最短展示的延迟收尾 */

const fmtCost = (ms) => (ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's');

function renderMcp() {
  clearTimeout(mcpTimer);
  if (mcp.busy) {                                  /* 执行中：不设收起计时 */
    S.mcp.active = true;
    S.mcp.connected = true;
    S.mcp.busy = true;
    S.mcp.text = `MCP 正在执行：${mcp.tool}…`;
    return;
  }
  if (mcp.sessions > 0) {                          /* 会话还在：常驻等待态 */
    S.mcp.active = true;
    S.mcp.connected = true;
    S.mcp.busy = false;
    S.mcp.text = mcp.tool
      ? `MCP 已执行：${mcp.tool}（${fmtCost(mcp.cost)}），等待指令…`
      : 'MCP 已连接，等待指令…';
    mcpTimer = setTimeout(() => { S.mcp.active = false; }, MCP_IDLE_MS);
    return;
  }
  if (mcp.tool) {                                  /* 会话已断但刚执行完：把结果留一会儿 */
    S.mcp.active = true;
    S.mcp.connected = false;
    S.mcp.busy = false;
    S.mcp.text = `MCP 已执行：${mcp.tool}（${fmtCost(mcp.cost)}）`;
    mcpTimer = setTimeout(() => { mcp.tool = ''; renderMcp(); }, MCP_KEEP_DONE_MS);
    return;
  }
  S.mcp.active = false;
  S.mcp.connected = false;
  S.mcp.busy = false;
}

/* 服务端只推四个事件，四个都在这里收敛成上面三种展示状态：
 *   connected(sessions) / activity(tool) / idle(tool,耗时由前端算) / disconnected(sessions) */
function onMcpEvent(msg) {
  if (msg.event === 'connected') {
    mcp.sessions = Number(msg.sessions) || 1;
  } else if (msg.event === 'activity') {
    clearTimeout(mcpPending);
    mcpPending = null;
    mcp.busy = true;
    mcp.tool = msg.tool || '…';
    mcp.since = Date.now();
  } else if (msg.event === 'idle') {
    /* 配置锁兜底：MCP 横条事件是 hub.broadcast 给所有页面的，而 lock/unlock 指令
     * （服务端 hub.call）只发给被选中的一个页面。多标签页 / 测试页在线时会出现
     * 「横条写已解锁，用户眼前这页却仍只读」。这里让看到 unlock 横条的每一页都
     * 同步解锁，与广播口径一致；服务端 tools-lock.js 的 syncAll 是同幂等双保险，
     * 旧服务端进程（未重启）也能靠这条把状态对齐。只对 unlock 兜底：工具失败时
     * 偏向「放开编辑权」是安全的，反过来误锁就不合适了。 */
    if (msg.tool === 'studio_unlock_config') {
      applyLock({ locked: false, by: 'mcp', at: Date.now(), note: '' });
    }
    const cost = mcp.since ? Date.now() - mcp.since : 0;
    if (msg.tool) mcp.tool = msg.tool;
    /* 太快了就等够最短展示时长再切回等待态 */
    clearTimeout(mcpPending);
    mcpPending = setTimeout(() => {
      mcpPending = null;
      mcp.busy = false;
      mcp.cost = cost;
      renderMcp();
    }, Math.max(0, MCP_MIN_BUSY_MS - cost));
    return;
  } else if (msg.event === 'disconnected') {
    mcp.sessions = Number(msg.sessions) || 0;
  } else {
    return;
  }
  renderMcp();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 预览区：等待就绪 ---------------- */
async function ensurePreviewStage(timeout = 8000) {
  const t0 = Date.now();
  while (!viewportApi.pluginPreview) {
    if (!S.proj) throw new Error('当前没有打开的项目');
    if (Date.now() - t0 > timeout) throw new Error('插件渲染区初始化超时（可能 WebGL 不可用）');
    await sleep(60);
  }
  return viewportApi.pluginPreview;
}

/* 通用视图门面：插件页注册 pluginPreview、家具页注册 catalogPreview，
 * 两者都基于同一个 ThreeHost，暴露同形状的相机 / 截图 / 模型姿态方法。
 * view / screenshot 走这里，一条链路服务两类项目，不用各写一套中继。 */
async function ensureViewportStage(timeout = 8000) {
  const t0 = Date.now();
  while (!viewportApi.pluginPreview && !viewportApi.catalogPreview) {
    if (!S.proj) throw new Error('当前没有打开的项目');
    if (Date.now() - t0 > timeout) throw new Error('3D 预览区初始化超时（可能 WebGL 不可用）');
    await sleep(60);
  }
  return viewportApi.pluginPreview || viewportApi.catalogPreview;
}

/* 家具页专属：先点中清单某件家具并等 GLB 真正进场景，再摆姿态 / 截图，避免拍到空场景 */
async function selectCatalogItem(pv, itemId) {
  if (!itemId) return null;
  if (typeof pv.selectItem !== 'function') {
    throw new Error('itemId 只在家具包编辑页可用（插件项目请用 styleId / entityId）');
  }
  return pv.selectItem(itemId);
}

async function waitPreviewIdle(pv, timeout = 20000) {
  const t0 = Date.now();
  while (pv.loading && pv.loading() && Date.now() - t0 < timeout) await sleep(90);
}

/* ---------------- 配置双写：清单即事实源 ----------------
 * 传了 styles 就整表替换样式（每条参数也整条替换），传了 fields 就整表替换字段。
 * 不做墓碑、不做 merge：清单里没有的条目就是没有了 —— 重渲时也不会从代码里并回来，
 * 因为配置才是结构来源，代码只提供同 id 的渲染函数（见 engine/project-config.js）。 */
const cloneList = (list) => JSON.parse(JSON.stringify(Array.isArray(list) ? list : []));

/* ---------------- 可被 MCP 调用的前端能力 ----------------
 * 代码 → 运行 → 摆姿态 → 看图 → 改状态 → 切样式这一条闭环。
 * 实体、部件、造型信息都写在插件代码里，不需要单独查询。
 */

/* 把模型姿态与相机摆到位（排查问题：先转/移到看得清，再按角度拍） */
function applyPose(pv, a) {
  let model = null;
  if (a.modelReset) model = pv.transformModel({ reset: true });
  if (a.modelSet) {
    /* 绝对姿态，排查同一处问题时最稳定 */
    model = pv.transformModel({ set: a.modelSet });
  } else if (a.modelRotate || a.modelMove) {
    const r = a.modelRotate || [];
    const m = a.modelMove || [];
    model = pv.transformModel({ rx: r[0], ry: r[1], rz: r[2], x: m[0], y: m[1], z: m[2] });
  }
  if (a.view) pv.setView(a.view);
  if (a.orbitAzimuth != null || a.orbitElevation != null) pv.orbit(a.orbitAzimuth || 0, a.orbitElevation || 0);
  if (a.panX != null || a.panY != null) pv.pan(a.panX || 0, a.panY || 0);
  if (a.zoomFactor != null) pv.zoom(a.zoomFactor);

  const abs = {};
  ['azimuth', 'elevation', 'distance', 'zoom', 'target', 'fov'].forEach((k) => {
    if (a[k] != null) abs[k] = a[k];
  });
  if (Object.keys(abs).length) pv.setCamera(abs);
  return { model, abs };
}

/* 样式参数值按 schema 的 type 归一：range/number → 数字并按 min/max 夹取，
 * checkbox → 布尔（接受 1/0、true/false、on/off），其余一律字符串。
 * AI 传参数常把数字写成字符串，这里统一收口，别让它落到 def 上变成 "1" 还是 1 的混乱。 */
function coerceOptionValue(opt, v) {
  const t = String(opt.type || 'text');
  if (t === 'range' || t === 'number') {
    if (v === '' || v === null || v === undefined) throw new Error(`参数 ${opt.key} 需要数值，收到空值`);
    const n = Number(v);
    if (!isFinite(n)) throw new Error(`参数 ${opt.key} 需要数值，收到 ${JSON.stringify(v)}`);
    let x = n;
    if (opt.min != null && opt.min !== '' && x < Number(opt.min)) x = Number(opt.min);
    if (opt.max != null && opt.max !== '' && x > Number(opt.max)) x = Number(opt.max);
    return x;
  }
  if (t === 'checkbox' || t === 'bool') {
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toLowerCase();
    if (['1', 'true', 'on', 'yes'].includes(s)) return true;
    if (['0', 'false', 'off', 'no'].includes(s)) return false;
    throw new Error(`参数 ${opt.key} 需要 true / false，收到 ${JSON.stringify(v)}`);
  }
  return String(v);
}

/* 从服务器重拉家具清单并覆盖前端内存：what:'catalog' 广播与 MCP 的 studio_refresh_catalog
 * 共用这一份实现，不复制第二套刷新逻辑。
 * 顺序很重要：先取消挂着的防抖保存（否则旧内存 900ms 后写回磁盘会把服务端的改动冲掉），
 * 再覆盖内存、清模型缓存、刷新模型列表，最后 +epoch 通知 CatalogEditor 重载 3D 预览。 */
async function refreshCatalogFromServer(msg = {}) {
  const pid = (S.proj && S.proj.id) || '';
  const isCatalog = !!(pid && S.proj.plugin && S.proj.plugin.kind === 'catalog');
  if (msg.bump) (Array.isArray(msg.files) ? msg.files : []).forEach((f) => bumpModel(pid, f));
  let pulled = false;
  let error = '';
  if (isCatalog) {
    try {
      const fresh = await api('GET', `/api/projects/${pid}`);
      if (fresh) {
        S.proj.catalog = fresh.catalog || { items: [] };
        if (fresh.plugin) {
          ['version', 'description', 'name'].forEach((k) => {
            if (fresh.plugin[k] !== undefined) S.proj.plugin[k] = fresh.plugin[k];
          });
        }
        if (fresh.name) S.proj.name = fresh.name;
        cancelPendingSave();
        S.catalogEpoch += 1;
        pulled = true;
      }
    } catch (e) { error = e.message || String(e); }
  } else {
    error = '当前页面不是家具包编辑页';
  }
  try { await act.loadModels(); } catch (e) { /* ignore */ }
  const items = (S.proj && S.proj.catalog && S.proj.catalog.items) || [];
  return {
    ok: pulled, projectId: pid, pulled, error,
    itemCount: items.length,
    items: items.map((x) => ({ id: x.id, name: x.name || x.id, model: x.model || '' })),
  };
}

const handlers = {
  /* 家具页：从服务器重拉清单覆盖内存（与 what:'catalog' 广播共用上面的实现） */
  catalog_refresh: async () => refreshCatalogFromServer({}),

  /* 家具页：当前正在预览哪件（多轮对话先定位「要改的是哪个」，不摆姿态、不出图） */
  catalog_current: async () => {
    const pv = await ensureViewportStage();
    if (typeof pv.selectItem !== 'function') throw new Error('当前打开的不是家具编辑页');
    return pv.describe();
  },
  /* 服务端已把代码落盘 → 清空上一轮渲染 → 按最新代码重建 */
  run_code: async ({ view } = {}) => {
    if (!S.proj) throw new Error('当前没有打开的项目');
    const pv = await ensurePreviewStage();
    await waitPreviewIdle(pv);
    /* 代码是服务端写的，前端内存里那份是旧的，重新取一次，避免后续保存把它冲掉 */
    try {
      const fresh = await api('GET', `/api/projects/${S.proj.id}`);
      if (fresh && typeof fresh.customJs === 'string') S.proj.customJs = fresh.customJs;
    } catch (e) { /* 取不到就用旧的 */ }
    const st = await pv.refresh({ view });
    const info = st || pv.describe();
    if (!info || info.ok === false) throw new Error((info && info.error) || '渲染失败');
    return info;
  },

  /* 直接重渲当前项目：重新执行代码 + 按当前项目配置合并。
   * 用在：sync_config 之后想立刻把画面刷新、或改完配置想确认渲染效果。
   * refreshConfig=true → 先按服务器上的 project.json 重贴内存配置（手改过 JSON 的场合） */
  render: async (args = {}) => {
    const a = args || {};
    if (!S.proj) throw new Error('当前没有打开的项目');
    const stage = await ensurePreviewStage();
    await waitPreviewIdle(stage);
    if (a.refreshConfig) {
      const fresh = await api('GET', `/api/projects/${S.proj.id}`);
      if (fresh) {
        if (typeof fresh.customJs === 'string') S.proj.customJs = fresh.customJs;
        if (Array.isArray(fresh.styles)) S.proj.styles = fresh.styles;
        if (Array.isArray(fresh.fields)) S.proj.fields = fresh.fields;
      }
    }
    /* skipSave：这里只是重渲，不该顺手把内存配置写盘（写盘是 sync_config / 保存的职责） */
    const st = await stage.refresh({ view: a.view, skipSave: true });
    const info = st || stage.describe();
    if (!info || info.ok === false) throw new Error((info && info.error) || '渲染失败');
    return info;
  },

  /* 运行期配置双写：styles / fields 直接按 MCP 传参覆盖（前端内存 + 服务端 JSON）。
   *
   *   ① S.proj.styles / fields ← 参数清单（整表替换，参数也整条替换）
   *   ② stage.refresh() 让引擎按新配置重建 → 样式/字段 tab、胶囊、画面一起换新
   *   ③ PUT 整个 S.proj 落盘（渲染成败都落盘：配置是主目标，渲染失败只进 warn）
   *
   * ⚠ saveNow 会把整个 S.proj PUT 回去，所以落盘前必须先把磁盘上的 customJs 取回来：
   *   若 AI 刚 write_code 但 run_code 失败（页面没开），内存里还是旧代码，直接保存会把新代码冲掉。 */
  sync_config: async (args = {}) => {
    const a = args || {};
    if (!S.proj) throw new Error('当前没有打开的项目');
    const hasStyles = Array.isArray(a.styles);
    const hasFields = Array.isArray(a.fields);
    if (!hasStyles && !hasFields) throw new Error('请至少传 styles 或 fields（最终版清单）');
    const stage = await ensurePreviewStage();
    await waitPreviewIdle(stage);

    let fresh;
    try { fresh = await api('GET', `/api/projects/${S.proj.id}`); }
    catch (e) { throw new Error('读不到项目，未落盘（避免用旧代码覆盖磁盘）: ' + e.message); }
    if (!fresh || typeof fresh.customJs !== 'string') throw new Error('项目读取异常，未落盘');
    S.proj.customJs = fresh.customJs;

    /* 配置这一半：清单即事实源，整表替换 */
    if (hasStyles) S.proj.styles = cloneList(a.styles);
    if (hasFields) S.proj.fields = cloneList(a.fields);
    if (hasStyles && S.styleId && !S.proj.styles.some((s) => s && s.id === S.styleId)) {
      S.styleId = (S.proj.styles[0] && S.proj.styles[0].id) || '';
    }

    /* 渲染这一半：重新执行代码并按新配置重建 → tab / 胶囊 / 引擎一起换新。
     * skipSave：refresh 内部默认会先保存一次，那一步会用「旧引擎镜像」覆盖刚写进内存的
     * 新配置，必须跳过，改由本方法最后落盘 */
    const warn = [];
    const renderInfo = await stage.refresh({ skipSave: true });
    const renderOk = !!(renderInfo && renderInfo.ok !== false);
    if (!renderOk) {
      warn.push('配置已保存，但页面没能按新配置重渲染：'
        + ((renderInfo && renderInfo.error) || '未知原因')
        + '。修好代码后重渲即生效');
    }

    /* 落盘：直接写这份清单，不走 saveNow 的「引擎镜像 → JSON」回推，
     * 否则渲染失败时会把刚写进内存的配置又覆盖回旧值 */
    await api('PUT', `/api/projects/${S.proj.id}`, { project: S.proj });
    S.saveState = '已保存 ✓';

    return {
      projectId: S.proj.id,
      savedAt: new Date().toISOString(),
      render: {
        ok: renderOk,
        ...(renderOk ? {} : { error: (renderInfo && renderInfo.error) || '' }),
      },
      warn,
      styles: (S.proj.styles || []).map((s) => ({
        id: s.id,
        name: s.name || s.id,
        options: (s.options || []).filter((o) => o && o.key).map((o) => o.key),
      })),
      fields: (S.proj.fields || []).map((f) => ({ key: f.key, label: f.label || f.key })),
      /* tab 里看到的（引擎内存）——服务端拿它和磁盘比。
       * 重渲失败时引擎还是上一版，比了只会误导：不回传，让服务端说明未校验 */
      runtime: renderOk ? {
        styles: (S.engineStyles || []).map((s) => ({
          id: s.id,
          options: (s.options || []).map((o) => (o && typeof o === 'object' ? o.key : o)).filter(Boolean),
        })),
        fields: (S.engineFields || []).map((f) => f.key),
      } : null,
    };
  },

  /* 家具页：点击左侧清单选中某件（与 view / screenshot 共用 selectItem 门面方法） */
  catalog_select: async ({ itemId } = {}) => {
    const pv = await ensureViewportStage();
    if (!itemId) throw new Error('缺少 itemId（见 studio_list_catalog_items）');
    return selectCatalogItem(pv, itemId);
  },

  /* 只摆姿态不出图：转模型 / 移模型 / 归位 / 转相机，返回当前机位与模型姿态 */
  view: async (args = {}) => {
    const a = args || {};
    const pv = await ensureViewportStage();
    await waitPreviewIdle(pv);
    await selectCatalogItem(pv, a.itemId);
    const pose = applyPose(pv, a);
    const d = pv.describe();
    return { camera: d.camera, model: pose.model || d.model || d.pose, size: d.size, label: d.label,
      ...(d.itemId ? { itemId: d.itemId, items: d.items } : {}) };
  },

  /* 截图：可以先把机位、模型姿态摆好，再出图 */
  screenshot: async (args = {}) => {
    const a = args || {};
    const pv = await ensureViewportStage();
    await waitPreviewIdle(pv);
    await selectCatalogItem(pv, a.itemId);
    const pose = applyPose(pv, a);

    const shot = Object.assign({
      width: Number(a.width) || 960,
      height: Number(a.height) || 640,
      view: a.view || null,
      withGrid: a.withGrid,
      /* -1 = 透明背景 */
      background: a.background === -1 ? null : a.background,
    }, pose.abs);

    const dataUrl = pv.screenshot(shot);
    if (!dataUrl) throw new Error('截图失败（渲染器未就绪）');
    return { dataUrl, preview: pv.describe() };
  },

  /* 实体状态：改值 → 插件 update() → 画面重绘 */
  set_entity: async ({ entityId, state, attributes } = {}) => {
    const pv = await ensurePreviewStage();
    await waitPreviewIdle(pv);
    if (!entityId) throw new Error('缺少 entityId，实体 id 见插件代码里的 getState/fields');
    const st = pv.setEntity(entityId, state, attributes);
    return { entity: st, label: pv.labelText(), entities: pv.listEntities() };
  },

  /* 配置锁（纯前端状态，见 store.applyLock）：MCP 想锁住用户手改时调这里，
   * 只影响当前这个页面，刷新即恢复。不传 locked = 只查状态。 */
  lock: async ({ locked, note } = {}) => {
    if (locked === undefined) {
      return { locked: S.lock.locked, by: S.lock.by, note: S.lock.note, at: S.lock.at };
    }
    const was = S.lock.locked;
    applyLock({ locked: !!locked, by: 'mcp', at: Date.now(), note: note || '' });
    if (was !== S.lock.locked && S.lock.locked) {
      toast('AI 锁定了配置：左侧面板转为只读（刷新页面即可恢复）');
    }
    return { locked: S.lock.locked, by: S.lock.by, note: S.lock.note, at: S.lock.at };
  },

  /* 切换样式：S.styleId 变更会触发 PluginStage 的 watch → 快速重生（respawn） */
  set_style: async ({ styleId } = {}) => {
    if (!S.proj) throw new Error('当前没有打开的项目');
    if (!styleId) throw new Error('缺少 styleId');
    const hit = engineList().find((s) => s && s.id === styleId);
    if (!hit) throw new Error('样式不存在: ' + styleId + '（可用 studio_get_project 查）');
    const pv = await ensurePreviewStage();
    S.styleId = styleId;
    await sleep(250);          // 等 watch 触发重生
    await waitPreviewIdle(pv);
    const info = pv.describe();
    if (!info || info.ok === false) throw new Error((info && info.error) || '渲染失败');
    return info;
  },

  /* 样式参数调节（MCP 自动核验用）：写内存 def 的 options[].def → 快速重生 → 回读实际生效值。
   * 数据源是引擎运行后的内存样式（engineList），改的就是预览正在用的那份，
   * respawn 不重新执行代码、不重置实体状态。不传 key = 只读当前样式的全部参数值。 */
  set_option: async ({ styleId, key, value } = {}) => {
    if (!S.proj) throw new Error('当前没有打开的项目');
    const styles = engineList();
    if (!styles.length) throw new Error('项目没有任何样式（先用面板建一个样式）');
    const style = styleId
      ? styles.find((s) => s && s.id === styleId)
      : (styles.find((s) => s && s.id === S.styleId) || styles[0]);
    if (!style) throw new Error('样式不存在: ' + styleId + '（可用 studio_get_project 查）');
    const list = style.options || [];
    const readValues = () => list.filter((o) => o && o.key)
      .map((o) => ({ key: o.key, label: o.label || o.key, type: o.type || '', value: o.def }));

    if (!key) return { styleId: style.id, readOnly: true, options: readValues() };

    const opt = list.find((o) => o && o.key === key);
    if (!opt) {
      const keys = list.map((o) => o && o.key).filter(Boolean);
      throw new Error(`参数不存在: ${key}（样式 ${style.id} 的参数：${keys.join(', ') || '无'}）`);
    }
    const from = opt.def;
    const to = coerceOptionValue(opt, value);
    opt.def = to;
    scheduleSave();   // 改的是内存 def：保存时全量覆盖回项目 JSON，这里触发防抖落盘

    /* 快速重生（respawn）：内存新值直接生效；不可用时回退全量渲染 */
    const pv = await ensurePreviewStage();
    await waitPreviewIdle(pv);
    let st = null;
    try { st = await pv.respawn({ styleId: style.id }); } catch (e) { st = null; }
    if (!st) {
      st = await pv.refresh({});
      for (let i = 0; i < 8 && !st; i++) { await sleep(200); st = await pv.refresh({}); }
    }
    if (!st || st.ok === false) throw new Error((st && st.error) || '重渲失败');
    await sleep(120);
    st = pv.describe() || st;
    return {
      styleId: style.id,
      key,
      from,
      to,
      options: readValues(),
      /* 引擎侧实际取到的参数值（ctx.options），用来确认改动真的传进插件了 */
      applied: (st.instance && st.instance.options) || null,
      preview: st,
    };
  },

  /* 点击设备（主体/标签同一条链路）：按插件 click 配置切主实体状态 → update() 重绘 */
  click: async (args = {}) => {
    const pv = await ensurePreviewStage();
    await waitPreviewIdle(pv);
    const d = pv.describe();
    if (d.kind !== 'device') throw new Error('当前是背景插件（kind=' + (d.kind || '?') + '），没有点击控制');
    const before = pv.isOnNow();
    const ent = pv.toggleDevice();
    if (!ent) throw new Error('点击没生效：插件未声明可用的 click 配置（或没有主实体）');
    await sleep(120);          // 等 update() 跑完一帧
    return {
      entityId: ent.entityId, from: before ? 'on' : 'off', to: ent.state,
      label: pv.labelText(), service: before ? 'click.off' : 'click.on',
      entities: pv.listEntities(),
    };
  },

  /* 标签预读：当前设备标签文案与可点状态（配合 click 用） */
  label: async () => {
    const pv = await ensurePreviewStage();
    await waitPreviewIdle(pv);
    return pv.labelState();
  },

  /* 运行期体检：渲染状态 + 最近的控制台报错。
   * 关键价值：插件的 update / plan2d / stateText / 动画帧里抛的异常不会冒到外面
   * （引擎里都是 catch + console.warn），只能从这里读出来。 */
  runtime: async (args = {}) => {
    const a = args || {};
    const pv = await ensurePreviewStage();
    const d = pv.describe ? pv.describe() : {};
    /* viewportApi.pluginPreview 是门面（只暴露白名单方法），引擎实例要从 getPreview() 拿 */
    const raw = typeof pv.getPreview === 'function' ? pv.getPreview() : null;
    const eng = raw && raw.engine ? raw.engine : null;
    const pid = d.projectId || (S.proj && S.proj.id) || '';
    const pick = (level) => readRuntimeLog({ level, limit: a.limit || 30, since: a.since, project: pid });
    /* 先读快照再清空：clear 的语义是「这次结果给你，缓冲从下轮重新攒」 */
    const snapshot = {
      stats: runtimeLogStats({ project: pid }),
      errors: pick('error'),
      warnings: a.level === 'error' ? [] : pick('warn'),
    };
    if (a.clear) clearRuntimeLog();
    return {
      projectId: d.projectId || (S.proj && S.proj.id) || '',
      projectName: (S.proj && S.proj.name) || '',
      render: {
        ok: d.ok !== false,
        error: d.error || '',
        loading: !!(pv.loading && pv.loading()),
        plugin: { id: d.pluginId || '', kind: d.kind || '', type: d.type || '', name: d.name || '' },
        style: { current: d.styleId || '', all: d.styles || [] },
        instance: d.instance || null,
        size: d.size || null,
        label: d.label || '',
        plan2d: d.plan2d,
        camera: d.camera || null,
        model: d.model || null,
        entities: d.entities || [],
      },
      engine: eng ? {
        defs: (eng.defs || []).length,
        instances: (eng.instances || []).length,
        lastError: eng._lastError || null,
      } : null,
      console: snapshot,
    };
  },

  /* 当前页面在哪：启动页（项目列表）还是某个项目编辑页。
   * 判断依据只看 URL 路由（#/project/<id>）—— 路由是唯一真身，
   * S.proj 只用来补项目名（页面刚从启动页跳进来时它可能还没加载完） */
  where: async () => {
    const hash = location.hash || '';
    const m = /^#\/project\/([A-Za-z0-9_-]+)/.exec(hash);
    const pid = (m && m[1]) || '';
    return {
      page: m ? 'project' : 'home',
      projectId: pid,
      projectName: (S.proj && S.proj.id === pid && S.proj.name) || '',
      hash,
      href: location.href,
      title: document.title || '',
    };
  },

  /* 打开指定项目：直接改 URL hash 走既有路由（hashchange → act.openProject） */
  open_project: async ({ projectId } = {}) => {
    const id = String(projectId || '');
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('projectId 不合法: ' + id);
    if (S.proj && S.proj.id === id) {
      return { projectId: id, name: S.proj.name, alreadyOpen: true };
    }
    const list = await api('GET', '/api/projects');
    const hit = (list.items || []).find((p) => p.id === id);
    if (!hit) throw new Error('项目不存在: ' + id + '（可用 studio_list_projects 查列表）');
    location.hash = '#/project/' + id;
    /* 等路由切过去（openProject 含拉取配置 + 首轮渲染） */
    const t0 = Date.now();
    while ((!S.proj || S.proj.id !== id) && Date.now() - t0 < 10000) await sleep(80);
    if (!S.proj || S.proj.id !== id) throw new Error('打开项目超时（10s）');
    await sleep(400);          // 等预览渲染启动
    const pv = viewportApi.pluginPreview;
    const info = pv && !pv.loading() ? pv.describe() : null;
    return { projectId: id, name: S.proj.name, opened: true, render: info };
  },

  /* 重新加载页面：服务端改完代码/构建后让浏览器拉新 bundle，免手动 F5。
     先回包再 reload（reload 会立刻断开 WS，回包要抢在前面）。 */
  reload: async () => {
    setTimeout(() => location.reload(), 300);
    return { reloading: true };
  },
};

async function onMessage(ev) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch (e) { return; }

  if (msg.type === 'mcp') {
    onMcpEvent(msg);
    return;
  }

  /* 服务端分配的连接 id：记下来，关闭指令里带的就是它 */
  if (msg.type === 'welcome') {
    myClientId = msg.clientId || '';
    return;
  }

  /* 单窗口收敛：服务端问「你现在可见/有焦点吗」→ 回 presence */
  if (msg.type === 'ask_presence') {
    reportPresence();
    return;
  }
  /* 单窗口收敛：本页不是被保留的那个 → 断中继 + 关页面。
   * 双保险：指令里若说明「保留的就是本页面」（keptPageId 相同 / kept 是自己），一律不关 ——
   * 同一页面可能有多个 socket（HMR / 重连残留），旧 socket 收到指令不能把整个页面带走。 */
  if (msg.type === 'close_extra') {
    if (msg.keptPageId && msg.keptPageId === PAGE_ID) return;
    if (msg.kept && myClientId && msg.kept === myClientId) return;
    shutdownSelf();
    return;
  }

  if (msg.type === 'refresh') {
    if (msg.what === 'catalog') {
      await refreshCatalogFromServer(msg);
      return;
    }
    if (msg.what === 'models') {
      /* files + bump：文件内容被服务端改写（如 MCP 修复材质）→ 顶掉缩略图/节点缓存并让预览重载，绕开浏览器缓存 */
      if (msg.bump) {
        const pid = (S.proj && S.proj.id) || '';
        if (pid) (Array.isArray(msg.files) ? msg.files : []).forEach((f) => bumpModel(pid, f));
      }
      try { await act.loadModels(); } catch (e) { /* ignore */ }
    }
    /* what:'code' 不再在这里渲染：写代码的工具会直接转发 run_code 并等待结果，
       这里若再跑一次 saveNow() 反而会用前端旧数据覆盖服务端刚写入的代码。 */
    return;
  }

  if (msg.type !== 'tool') return;
  const fn = handlers[msg.name];
  try {
    if (!fn) throw new Error('前端不支持工具: ' + msg.name);
    const result = await fn(msg.args || {});
    send({ type: 'tool_result', id: msg.id, ok: true, result });
  } catch (e) {
    send({ type: 'tool_result', id: msg.id, ok: false, error: e.message });
  }
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  const delay = Math.min(1000 * (2 ** retry), 15000);
  retry += 1;
  retryTimer = setTimeout(connect, delay);
}

function connect() {
  if (shuttingDown) return;
  try { ws = new WebSocket(WS_URL); } catch (e) { scheduleRetry(); return; }

  ws.onopen = () => { retry = 0; hello(); };
  ws.onmessage = onMessage;
  ws.onclose = () => { ws = null; if (!shuttingDown) scheduleRetry(); };
  ws.onerror = () => { try { if (ws) ws.close(); } catch (e) { /* ignore */ } };
}

/* 在 App setup 中调用一次。
 * ⚠ 一个页面**只能有一条 socket**：HMR 会重新执行本模块并再调一次 initWs，
 * 不收拾旧连接就会在服务端留下多个「同一页面」的连接（单窗口收敛会被误判）。 */
export function initWs() {
  /* HMR / 重复调用：先把上一次的连接与监听全部拆掉 */
  if (typeof window !== 'undefined' && typeof window.__ha3dWsTeardown === 'function') {
    try { window.__ha3dWsTeardown(); } catch (e) { /* ignore */ }
  }

  connect();
  const stops = [
    watch(() => S.proj?.id, () => hello()),
    watch(() => S.proj?.name, () => hello()),
  ];
  /* 切换标签页 / 窗口失焦 → 告诉服务端谁在前台（studio_single_window 用） */
  const hasDom = typeof document !== 'undefined';
  if (hasDom) {
    document.addEventListener('visibilitychange', reportPresence);
    window.addEventListener('focus', reportPresence);
    window.addEventListener('blur', reportPresence);
  }

  if (typeof window !== 'undefined') {
    window.__ha3dWsTeardown = () => {
      stops.forEach((stop) => { try { stop(); } catch (e) { /* ignore */ } });
      if (hasDom) {
        document.removeEventListener('visibilitychange', reportPresence);
        window.removeEventListener('focus', reportPresence);
        window.removeEventListener('blur', reportPresence);
      }
      clearTimeout(retryTimer);
      retryTimer = null;
      const sock = ws;
      ws = null;
      if (sock) {
        sock.onopen = null;
        sock.onmessage = null;
        sock.onclose = null;
        sock.onerror = null;
        try { sock.close(); } catch (e) { /* ignore */ }
      }
    };
  }
}
