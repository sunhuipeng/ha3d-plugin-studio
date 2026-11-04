/* 前端 ↔ Node 服务端 WebSocket 中继客户端
 *
 * MCP 工具经服务端转发到这里执行：
 *   { type:'tool', id, name, args }  → 本地执行 → { type:'tool_result', id, ok, result }
 * 服务端还可能发：
 *   { type:'refresh', what:'models' }                                → 局部刷新模型列表
 *   { type:'refresh', what:'snapshot' }                               → MCP 记录/清除配置快照，刷新顶栏徽标
 *   { type:'mcp', event:'connected'|'activity'|'disconnected', tool? } → 顶部横条提示
 */
import { watch } from 'vue';
import { S, act, api, viewportApi } from './store';
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

function send(obj) {
  if (!ws || ws.readyState !== 1) return false;
  try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
}

function hello() {
  send({
    type: 'hello',
    projectId: S.proj?.id || '',
    projectName: S.proj?.name || '',
    visible: document.visibilityState === 'visible',
    focused: document.hasFocus(),
  });
}

/* 可见 / 聚焦状态上报：studio_single_window 靠它挑「用户正在看的那个标签页」 */
function reportPresence() {
  send({ type: 'presence', visible: document.visibilityState === 'visible', focused: document.hasFocus() });
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

/* ---------------- 插件渲染区：等待就绪 ---------------- */
async function ensurePreviewStage(timeout = 8000) {
  const t0 = Date.now();
  while (!viewportApi.pluginPreview) {
    if (!S.proj) throw new Error('当前没有打开的项目');
    if (Date.now() - t0 > timeout) throw new Error('插件渲染区初始化超时（可能 WebGL 不可用）');
    await sleep(60);
  }
  return viewportApi.pluginPreview;
}

async function waitPreviewIdle(pv, timeout = 20000) {
  const t0 = Date.now();
  while (pv.loading && pv.loading() && Date.now() - t0 < timeout) await sleep(90);
}

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

const handlers = {
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

  /* 只摆姿态不出图：转模型 / 移模型 / 归位 / 转相机，返回当前机位与模型姿态 */
  view: async (args = {}) => {
    const a = args || {};
    const pv = await ensurePreviewStage();
    await waitPreviewIdle(pv);
    const pose = applyPose(pv, a);
    const d = pv.describe();
    return { camera: d.camera, model: pose.model || d.model, size: d.size, label: d.label };
  },

  /* 截图：可以先把机位、模型姿态摆好，再出图 */
  screenshot: async (args = {}) => {
    const a = args || {};
    const pv = await ensurePreviewStage();
    await waitPreviewIdle(pv);
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

  /* 切换样式：S.styleId 变更会触发 PluginStage 的 watch → 重渲 */
  set_style: async ({ styleId } = {}) => {
    if (!S.proj) throw new Error('当前没有打开的项目');
    if (!styleId) throw new Error('缺少 styleId');
    const hit = (S.proj.styles || []).find((s) => s && s.id === styleId);
    if (!hit) throw new Error('样式不存在: ' + styleId + '（可用 studio_get_project 查）');
    const pv = await ensurePreviewStage();
    S.styleId = styleId;
    await sleep(250);          // 等 watch 触发 refresh
    await waitPreviewIdle(pv);
    const info = pv.describe();
    if (!info || info.ok === false) throw new Error((info && info.error) || '渲染失败');
    return info;
  },

  /* 样式参数调节（MCP 自动核验用）：写 styles[].options[].def → 软重渲 → 回读实际生效值。
   * 参数值的唯一来源就是样式 schema 上的 def（引擎用它合并出 ctx.options），
   * 所以这里改 def 就等于在左下卡片上拖滑条。不传 key = 只读当前样式的全部参数值。 */
  set_option: async ({ styleId, key, value } = {}) => {
    if (!S.proj) throw new Error('当前没有打开的项目');
    const styles = S.proj.styles || [];
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

    /* 参数变了必须重跑代码（ctx.options 是 spawn 时合并出的快照），不能只 update()。
     * 实体状态不用管：preview.load 会先快照再推回去（改参数不至于把「灯已开」清成 off） */
    const pv = await ensurePreviewStage();
    await waitPreviewIdle(pv);
    let st = await pv.refresh({});
    for (let i = 0; i < 8 && !st; i++) { await sleep(200); st = await pv.refresh({}); }
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
    if (d.kind !== 'device') throw new Error('当前不是设备类插件（kind=' + (d.kind || '?') + '），没有点击控制');
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

  /* 单窗口收敛：服务端问「你现在可见/有焦点吗」→ 回 presence */
  if (msg.type === 'ask_presence') {
    reportPresence();
    return;
  }
  /* 单窗口收敛：本页不是被保留的那个 → 断中继 + 关页面 */
  if (msg.type === 'close_extra') {
    shutdownSelf();
    return;
  }

  if (msg.type === 'refresh') {
    if (msg.what === 'models') {
      /* files + bump：文件内容被服务端改写（如 MCP 修复材质）→ 顶掉缩略图/节点缓存并让预览重载，绕开浏览器缓存 */
      if (msg.bump) {
        const pid = (S.proj && S.proj.id) || '';
        if (pid) (Array.isArray(msg.files) ? msg.files : []).forEach((f) => bumpModel(pid, f));
      }
      try { await act.loadModels(); } catch (e) { /* ignore */ }
    }
    else if (msg.what === 'snapshot' && S.proj) {
      /* MCP 记录 / 清除了配置快照 → 刷新顶栏徽标 */
      act.loadSnapshot();
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

/* 在 App setup 中调用一次 */
export function initWs() {
  connect();
  watch(() => S.proj?.id, () => hello());
  watch(() => S.proj?.name, () => hello());
  /* 切换标签页 / 窗口失焦 → 告诉服务端谁在前台（studio_single_window 用） */
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', reportPresence);
    window.addEventListener('focus', reportPresence);
    window.addEventListener('blur', reportPresence);
  }
}
