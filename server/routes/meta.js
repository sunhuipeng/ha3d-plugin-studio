'use strict';
/* 域 2：元信息 —— 发布目标 / MCP 接入配置 / ha-3d-home 元信息代理（户型长宽、家具分类枚举）。
 * 同 ha-3d-home 的 server/config.js / system.js 拆域口径：本文件自带 Router，index.js 挂载。 */
const express = require('express');
const { getConfig, saveConfig, remoteTarget, PORT } = require('../lib/config');
const { resolveCatalogTypes } = require('../lib/catalog-types');

module.exports = function metaRoutes() {
  const r = express.Router();

  /* 发布目标：读 */
  r.get('/target', (req, res) => {
    res.json({ ...remoteTarget() });
  });

  /* 发布目标：写（主机地址 + 安装密钥） */
  r.put('/target', (req, res) => {
    const host = String(req.body.host || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/.+/.test(host)) return res.status(400).json({ error: '主机地址需以 http:// 或 https:// 开头' });
    const cfg = getConfig();
    cfg.remote = { host, key: String(req.body.key || '').trim() };
    saveConfig(cfg);
    res.json({ ok: true, ...remoteTarget() });
  });

  /* MCP 接入配置：启动页「MCP 接入」弹窗直接展示 / 复制这份 JSON。
   * 地址在服务端拼装——端口一律用启动端口 PORT（不写死在客户端），主机名取请求 Host
   * （即浏览器地址栏里的主机名）：
   *   · dev=1（Vite 开发页，只有 /api 被代理）：Host 的端口是前端端口，换成本服务端口 PORT；
   *   · 生产直连：Host 自带真实访问端口（docker 端口映射也正确），原样使用。 */
  r.get('/mcp-config', (req, res) => {
    const host = String(req.headers.host || '');
    const hostname = host.replace(/:\d+$/, '') || 'localhost';
    const dev = req.query.dev === '1';
    const base = dev || !/:\d+$/.test(host) ? `${hostname}:${PORT}` : host;
    const url = `${req.protocol}://${base}/mcp/sse`;
    res.json({
      ok: true,
      port: PORT,
      url,
      config: { mcpServers: { 'ha3d-plugin-studio': { type: 'sse', url } } },
    });
  });

  /* 代理读取 ha-3d-home 的户型长宽（背景插件项目打开时自动同步构图参考）。
   * home 侧 /api/house/size 是免鉴权 GET，这里只要求配了地址；
   * home 不可达/无有效值时返回 ok:false，前端静默跳过 */
  r.get('/home/house', async (req, res) => {
    const remote = remoteTarget();
    if (!remote.host) return res.json({ ok: false, error: '未配置 home 服务地址' });
    try {
      const resp = await fetch(remote.host.replace(/\/+$/, '') + '/api/house/size', { signal: AbortSignal.timeout(4000) });
      const d = await resp.json().catch(() => ({}));
      const w = Number(d.houseW);
      const h = Number(d.houseD);
      if (!resp.ok || !(w > 0) || !(h > 0)) return res.json({ ok: false, error: 'home 返回无效的户型长宽' });
      res.json({ ok: true, houseW: w, houseD: h });
    } catch (e) {
      res.json({ ok: false, error: '无法连接 ha-3d-home: ' + (e && e.message || e) });
    }
  });

  /* 家具分类枚举：优先取 ha-3d-home 的 GET /api/catalog（它的 types 是唯一出处），
   * home 不可达时回落本机兜底表 —— 保证家具编辑页的分类下拉永远可用，且能跟 home 对齐。 */
  r.get('/catalog-types', async (req, res) => {
    const t = await resolveCatalogTypes();
    res.json({ ok: true, source: t.source, host: t.host, types: t.types, ...(t.error ? { warn: t.error } : {}) });
  });

  return r;
};
