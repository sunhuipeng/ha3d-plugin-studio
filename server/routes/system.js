'use strict';
/* 域 1：系统 —— 健康检查（docker healthcheck / 探活 / MCP 弹窗状态检测）。
 * 同 ha-3d-home 的 server/system.js 口径。 */
const express = require('express');

module.exports = function systemRoutes() {
  const r = express.Router();

  r.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

  return r;
};
