/* WebSocket 中继（前端页面 ↔ Node 服务端）
 *
 * 职责：
 *  - 前端连接时上报自己打开的项目（hello: { projectId, projectName }）
 *  - MCP 工具需要前端执行时，按 projectId 选中「第一个连上的前端」固定交互；
 *    该前端断开后自动改用同项目的下一个
 *  - 前端执行完通过 tool_result 回传，hub 按请求 id 唤醒等待的 MCP 工具
 *
 * 协议：
 *  前端 → 服务端:
 *    { type:'hello', projectId, projectName, visible?, focused? }
 *    { type:'presence', visible, focused }        ← 聚焦 / 切换标签页 / 可见性变化时上报
 *    { type:'tool_result', id, ok:true, result }
 *    { type:'tool_result', id, ok:false, error }
 *  服务端 → 前端:
 *    { type:'welcome', clientId, ts }
 *    { type:'tool', id, name, args }
 *    { type:'refresh', what:'models', file? }
 *    { type:'ask_presence' }                      ← 询问当前可见/聚焦状态（单窗口收敛前先问）
 *    { type:'close_extra', kept, reason }         ← 你不是被保留的窗口，自己关掉（前端会断开中继并关页面）
 */
'use strict';

const { WebSocketServer } = require('ws');

/* 连接日志默认关（正常运行时每次刷新页面都打太吵），DEBUG=ws 时打开 */
const DEBUG_WS = /(^|,)ws(,|$)/.test(process.env.DEBUG || '');
const log = (...a) => { if (DEBUG_WS) console.log(...a); };

const clients = new Map();   // ws -> client info
const pending = new Map();   // requestId -> { resolve, reject, timer, ws }
let seq = 0;

/* MCP 活跃会话数由 mcp-sse 维护，这里只存一个取值函数：
 * 前端页面（重新）连上时，如果 MCP 早就连着，也要立刻亮起提示横条——
 * 否则刷新页面后就再也收不到 'connected' 事件（它只在会话建立那一刻广播）。 */
let mcpSessionsFn = null;
function setMcpSessions(fn) { mcpSessionsFn = fn; }
function mcpSessions() {
  try { return Number(mcpSessionsFn && mcpSessionsFn()) || 0; } catch (e) { return 0; }
}

function send(info, obj) {
  if (!info || !info.ws || info.ws.readyState !== 1) return false;
  try { info.ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
}

function drop(info, reason) {
  if (!clients.has(info.ws)) return;
  clients.delete(info.ws);
  try { info.ws.close(); } catch (e) { /* ignore */ }
  log(`[ws] 前端断开 ${info.clientId}（${reason}）`);
  /* 该前端身上未完成的请求全部失败，避免 MCP 调用方一直等 */
  for (const [id, p] of pending) {
    if (p.ws === info.ws) {
      pending.delete(id);
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error('执行该工具的前端页面已断开'), { code: 'FRONTEND_GONE' }));
    }
  }
}

function onMessage(info, buf) {
  let msg;
  try { msg = JSON.parse(String(buf)); } catch (e) { return; }
  info.lastSeen = Date.now();

  if (msg.type === 'hello') {
    const changed = info.projectId !== String(msg.projectId || '');
    info.projectId = String(msg.projectId || '');
    info.projectName = String(msg.projectName || '');
    /* 页面身份：同一标签页的所有 socket 共用一个 pageId（HMR / 重连会留下多条 socket，
     * 单窗口收敛必须按页面去重，否则会把同一页面的旧连接当成「另一个标签页」去关） */
    if (msg.pageId) info.pageId = String(msg.pageId);
    if (typeof msg.visible === 'boolean') info.visible = msg.visible;
    if (typeof msg.focused === 'boolean') info.focused = msg.focused;
    if (changed) log(`[ws] ${info.clientId} 打开项目 ${info.projectId || '(首页)'}`);
    return;
  }

  if (msg.type === 'presence') {
    if (msg.pageId) info.pageId = String(msg.pageId);
    info.visible = !!msg.visible;
    info.focused = !!msg.focused;
    return;
  }

  if (msg.type === 'tool_result') {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(Object.assign(new Error(msg.error || '前端执行失败'), { code: 'FRONTEND_ERROR' }));
  }
}

/* 选定某个项目固定交互的前端：优先「用户正在看的页面」，页面内取最新的 socket。
 * 为什么要看可见/焦点：用户可能开着多个页面，工具应当落在眼前这一页，
 * 而不是恰好最近连上的那一页（否则截图 / 调参会落到背后的窗口）。
 * 同分（都没焦点也没可见）时按连接时间倒序 —— 刷新页面产生的新连接一定加载了最新构建，
 * 能自动避开还跑着旧 bundle 的标签页。 */
function pick(projectId) {
  const list = [...clients.values()]
    .filter((c) => c.projectId === projectId && c.ws.readyState === 1);
  if (!list.length) return null;
  const pages = groupPages(list).sort((a, b) => b.score - a.score
    || b.clients[0].connectedAt - a.clients[0].connectedAt);
  const page = pages[0];
  return page.clients.find((c) => c.focused)
    || page.clients.find((c) => c.visible)
    || page.clients[0];
}

/* 与项目无关的全局交互（如「打开某项目」）：选最近连上的任意前端 */
function pickAny() {
  const list = [...clients.values()]
    .filter((c) => c.ws.readyState === 1)
    .sort((a, b) => b.connectedAt - a.connectedAt);
  return list[0] || null;
}

/* 让前端执行一个工具并等待结果（target 由调用方选定） */
function exec(target, name, args = {}, timeoutMs = 15000) {
  const id = 'r' + (++seq);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error(`前端执行工具 ${name} 超时（${timeoutMs}ms）`), { code: 'TIMEOUT' }));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, ws: target.ws });
    if (!send(target, { type: 'tool', id, name, args })) {
      pending.delete(id);
      clearTimeout(timer);
      reject(Object.assign(new Error('指令发送失败：前端连接已失效'), { code: 'SEND_FAILED' }));
    }
  });
}

/* 让前端执行一个工具，返回其 result；无前端 / 超时 / 断开都会 reject */
function call(projectId, name, args = {}, timeoutMs = 15000) {
  const target = pick(projectId);
  if (!target) {
    return Promise.reject(Object.assign(
      new Error(`项目「${projectId || '(未指定)'}」当前没有前端页面打开；请先在浏览器打开该项目的编辑页，再重试`),
      { code: 'NO_FRONTEND' },
    ));
  }
  return exec(target, name, args, timeoutMs);
}

/* 在任意已连接的编辑页上执行（最近连接优先）——open_project / reload 这类全局动作用 */
function callAny(name, args = {}, timeoutMs = 15000) {
  const target = pickAny();
  if (!target) {
    return Promise.reject(Object.assign(
      new Error('当前没有任何编辑页连上来；请先在浏览器打开 studio（任意页面均可）'),
      { code: 'NO_FRONTEND' },
    ));
  }
  return exec(target, name, args, timeoutMs);
}

function listFrontends() {
  return [...clients.values()].map((c) => ({
    clientId: c.clientId,
    pageId: c.pageId || c.clientId,
    projectId: c.projectId,
    projectName: c.projectName,
    alive: c.ws.readyState === 1,
    visible: !!c.visible,
    focused: !!c.focused,
    connectedAt: c.connectedAt,
    lastSeen: c.lastSeen,
    chosen: pick(c.projectId) === c,
  }));
}

/* ---- 单窗口收敛：MCP 只在一个**页面**里干活，多余页面才关 ----
 * 关键：服务端的单位是「连接」，用户的单位是「页面」——一个页面可能因为 HMR / 重连
 * 留下多条 socket，按连接去关会把用户唯一的那页关掉。所以这里一律按 pageId 归组：
 *   · 同一页面内部的多条连接：只挑最新那条当保留者，其余**不动**（它们随页面刷新自然消失）；
 *   · 只有「不同页面」才会收到 close_extra。
 * 顺序：先问一遍 presence（可见/聚焦）→ 挑保留页面 → 通知其余页面自己关
 *      → 等一会儿仍连着的由服务端兜底断开（旧页面不认 close_extra 时不至于一直挂着） */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pageKey = (c) => c.pageId || c.clientId;

/* 页面评分：有焦点 > 可见 > 最近活跃；同分取最近连上的页面 */
function pageScore(page) {
  const best = page.clients.reduce((acc, c) => ({
    focused: acc.focused || !!c.focused,
    visible: acc.visible || !!c.visible,
    lastSeen: Math.max(acc.lastSeen, c.lastSeen || 0),
  }), { focused: false, visible: false, lastSeen: 0 });
  return (best.focused ? 4 : 0) + (best.visible ? 2 : 0) + 0;   // 具体的 lastSeen 用于并列时比较
}

/* 把存活连接按 pageId 归组 */
function groupPages(list) {
  const map = new Map();
  for (const c of list) {
    const k = pageKey(c);
    if (!map.has(k)) map.set(k, { pageId: k, clients: [] });
    map.get(k).clients.push(c);
  }
  const pages = [...map.values()];
  pages.forEach((p) => {
    p.clients.sort((a, b) => b.connectedAt - a.connectedAt);   // [0] = 该页面最新的 socket
    p.score = pageScore(p);
  });
  return pages;
}

/* 显式 clientId 优先；否则「有焦点 > 可见 > 最近连上」——按页面挑，返回该页面最新的连接 */
function pickKeeper({ keepClientId, projectId } = {}) {
  const live = [...clients.values()].filter((c) => c.ws.readyState === 1);
  if (keepClientId) {
    const hit = live.find((c) => c.clientId === keepClientId);
    if (!hit) throw Object.assign(new Error('keepClientId 不存在或已断开：' + keepClientId), { code: 'KEEPER_GONE' });
    /* 指定的可能只是该页面的一条旧 socket：统一升到同一页面最新的那条 */
    const page = groupPages(live.filter((c) => pageKey(c) === pageKey(hit)))[0];
    return (page && page.clients[0]) || hit;
  }
  const pool = projectId ? live.filter((c) => c.projectId === projectId) : live;
  if (!pool.length) {
    throw Object.assign(new Error(projectId ? `项目 ${projectId} 当前没有前端页面打开` : '当前没有任何编辑页连上来'), { code: 'NO_FRONTEND' });
  }
  const pages = groupPages(pool).sort((a, b) => b.score - a.score
    || (b.clients[0].lastSeen || 0) - (a.clients[0].lastSeen || 0)
    || b.clients[0].connectedAt - a.clients[0].connectedAt);
  return pages[0].clients[0];
}

async function askPresence(waitMs = 350) {
  const live = [...clients.values()].filter((c) => c.ws.readyState === 1);
  for (const c of live) send(c, { type: 'ask_presence', ts: Date.now() });
  if (live.length) await sleep(waitMs);
  return live.length;
}

/* 只关「别的页面」；同一页面的其它连接一律不碰（它们不是多余窗口，只是旧 socket） */
async function closeExtra(keep, waitMs = 1200) {
  const keepPage = pageKey(keep);
  const targets = [...clients.values()]
    .filter((c) => c.ws.readyState === 1 && pageKey(c) !== keepPage);
  const rows = targets.map((c) => ({
    clientId: c.clientId,
    pageId: pageKey(c),
    projectId: c.projectId,
    projectName: c.projectName,
    notified: send(c, {
      type: 'close_extra',
      kept: keep.clientId,
      keptPageId: keepPage,
      reason: 'single_window',
      ts: Date.now(),
    }),
    selfClosed: false,
    forced: false,
  }));
  if (targets.length) await sleep(waitMs);
  targets.forEach((c, i) => {
    const gone = !clients.has(c.ws) || c.ws.readyState !== 1;
    rows[i].selfClosed = gone;
    if (!gone) {
      rows[i].forced = true;
      drop(c, 'single_window 兜底断开');
    }
  });
  return rows;
}

/* 广播给某项目的所有前端（用于服务端落盘后的局部刷新） */
function notify(projectId, payload) {
  let n = 0;
  for (const c of clients.values()) {
    if (c.projectId === projectId && send(c, payload)) n += 1;
  }
  return n;
}

/* 广播给所有前端（MCP 连接状态这类全局提示） */
function broadcast(payload) {
  let n = 0;
  for (const c of clients.values()) {
    if (send(c, payload)) n += 1;
  }
  return n;
}

function attach(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    let projectId = '';
    try { projectId = new URL(req.url, 'http://localhost').searchParams.get('projectId') || ''; } catch (e) { /* ignore */ }
    const info = {
      clientId: 'f' + (++seq),
      /* 页面身份由前端 hello 上报（同一标签页共用一个 pageId）；老构建不报时退化成 clientId */
      pageId: '',
      ws,
      projectId,
      projectName: '',
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      /* 可见性 / 聚焦：单窗口收敛时用来挑「用户正在看的那个」 */
      visible: true,
      focused: false,
    };
    clients.set(ws, info);

    ws.on('message', (buf) => onMessage(info, buf));
    ws.on('pong', () => { info.lastSeen = Date.now(); });
    ws.on('close', () => drop(info, 'socket closed'));
    ws.on('error', () => drop(info, 'socket error'));

    send(info, { type: 'welcome', clientId: info.clientId, ts: Date.now() });
    /* 前端刚连上：MCP 若已在会话中，补一条 connected，横条立刻显示待命/执行态 */
    const n = mcpSessions();
    if (n > 0) send(info, { type: 'mcp', event: 'connected', sessions: n, ts: Date.now() });
    log(`[ws] 前端接入 ${info.clientId} project=${info.projectId || '(首页)'}`);
  });

  const heartbeat = setInterval(() => {
    for (const info of clients.values()) {
      if (info.ws.readyState !== 1) continue;
      try { info.ws.ping(); } catch (e) { /* ignore */ }
      if (Date.now() - info.lastSeen > 90_000) drop(info, 'heartbeat timeout');
    }
  }, 30_000);
  wss.on('close', () => clearInterval(heartbeat));

  return wss;
}

module.exports = {
  attach, call, callAny, listFrontends, notify, broadcast, setMcpSessions,
  pickKeeper, askPresence, closeExtra, groupPages, pageKey,
};
