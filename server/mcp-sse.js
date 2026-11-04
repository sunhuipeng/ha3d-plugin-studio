/* MCP over SSE：把 MCP 服务挂到 8098 上
 *
 *   GET  /mcp/sse       建立 SSE 长连接（WorkBuddy 的 MCP 客户端连这里）
 *   POST /mcp/messages  JSON-RPC 消息回传（sessionId 由 SSE endpoint 事件给出）
 *   GET  /mcp/health    健康检查：活跃会话数 + 前端连接列表
 *
 * 每个 SSE 会话独立创建一个 McpServer 实例；工具内部通过 ws-hub 与前端交互。
 * 会话建立/断开都会广播 { type:'mcp', event:'connected'|'disconnected', sessions }，
 * 每次工具调用另由 mcp-tools 的 wrapToolActivity 广播 activity / idle（带工具名），
 * 前端据此显示「MCP 正在执行：<能力名>」的顶部横条，连接期间常驻，断开才收起。
 */
'use strict';

const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { buildMcpServer } = require('./mcp-tools');
const hub = require('./ws-hub');

const sessions = new Map(); // sessionId -> { transport, server, openedAt }

/* 会话建立/关闭日志默认关（每次 MCP 客户端重连都打太吵），DEBUG=mcp 时打开 */
const DEBUG_MCP = /(^|,)mcp(,|$)/.test(process.env.DEBUG || '');
const log = (...a) => { if (DEBUG_MCP) console.log(...a); };

function mountMcpSse(app) {
  /* 把活跃会话数交给 ws-hub：前端页面（重新）接入时用它补发 connected，
   * 保证页面刷新后「MCP 已连接」的横条依然在 */
  hub.setMcpSessions(() => sessions.size);

  app.get('/mcp/sse', async (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    /* 不要在这里 flushHeaders：SSEServerTransport 会在 start() 里 writeHead 设置
       Content-Type: text/event-stream，提前 flush 会导致头被锁死、缺少该字段 */

    const server = buildMcpServer();
    const transport = new SSEServerTransport('/mcp/messages', res);
    sessions.set(transport.sessionId, { transport, server, openedAt: Date.now() });

    log(`[mcp] SSE 会话建立 ${transport.sessionId}（当前 ${sessions.size} 个）`);
    hub.broadcast({ type: 'mcp', event: 'connected', sessions: sessions.size, ts: Date.now() });

    res.on('close', () => {
      sessions.delete(transport.sessionId);
      log(`[mcp] SSE 会话关闭 ${transport.sessionId}（剩余 ${sessions.size} 个）`);
      try { server.close(); } catch (e) { /* ignore */ }
      hub.broadcast({ type: 'mcp', event: 'disconnected', sessions: sessions.size, ts: Date.now() });
    });

    try {
      await server.connect(transport);
    } catch (e) {
      sessions.delete(transport.sessionId);
      console.error('[mcp] SSE 初始化失败:', e.message);
      try { res.end(); } catch (err) { /* ignore */ }
    }
  });

  app.post('/mcp/messages', async (req, res) => {
    const sid = String(req.query.sessionId || '');
    const s = sessions.get(sid);
    if (!s) return res.status(404).json({ error: 'unknown mcp session: ' + sid });
    try {
      await s.transport.handlePostMessage(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  app.get('/mcp/health', (req, res) => {
    res.json({
      ok: true,
      sessions: [...sessions.values()].map((s) => ({ openedAt: s.openedAt })),
      frontends: hub.listFrontends(),
    });
  });
}

module.exports = { mountMcpSse };
