/* ha3d-plugin-studio 服务入口: npm start → http://localhost:8098 */
'use strict';

const http = require('http');
const fs = require('fs');
const express = require('express');
const { PORT, CLIENT_DIST, PROJECTS_DIR, ensureDir, remoteTarget } = require('./config');
const { api } = require('./routes');
const { attach: attachHub } = require('./ws-hub');
const { mountMcpSse } = require('./mcp-sse');

const app = express();
app.use(express.json({ limit: '4mb' }));
/* 健康检查（docker healthcheck / 探活用，同 ha-3d-home 的 /api/health） */
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.use('/api', api);
mountMcpSse(app);

/* 静态资源 = Vue 构建产物 client/dist（npm run build 生成） */
const hasDist = fs.existsSync(`${CLIENT_DIST}/index.html`);
app.use((req, res, next) => {
  if (req.method === 'GET') res.setHeader('Cache-Control', 'no-cache');
  next();
});
if (hasDist) {
  app.use(express.static(CLIENT_DIST, { etag: true }));
} else {
  app.get('/', (req, res) => {
    res.status(503).type('text/plain; charset=utf-8').send(
      '前端还没构建。先执行一次：\n\n  npm run client:build\n\n然后刷新本页。\n'
    );
  });
}

const server = http.createServer(app);
attachHub(server);

ensureDir(PROJECTS_DIR);
server.listen(PORT, () => {
  console.log(`ha3d-plugin-studio → http://localhost:${PORT}`);
  console.log(`MCP(SSE) → http://localhost:${PORT}/mcp/sse`);
  console.log(`发布目标: ${remoteTarget().host}（远程安装到 ha-3d-home）`);
  if (!hasDist) console.warn('⚠ 未找到 client/dist，请先 npm run client:build');
});
