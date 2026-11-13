'use strict';
/* 域 5：生成 / 导出 / 发布 —— 插件包与家具包（kind: catalog）是两套产物，各走各的端点。
 * 同 ha-3d-home 的拆域口径（对应 home 的 install.js 位置）：本文件自带 Router，index.js 挂载。 */
const express = require('express');
const { safeId, readProject, listModels } = require('../lib/config');
const { buildAll, validate } = require('../lib/generator');
const { prepareExportZip, buildProjectZip, publishProject } = require('../lib/plugin-pkg');
const { prepareCatalogExport, publishCatalog: publishCatalogPkg } = require('../lib/catalog-pkg');

module.exports = function publishRoutes() {
  const r = express.Router();

  /* 生成结果预览（不落盘）：返回构建产物 + 校验 warnings */
  r.get('/projects/:id/build', (req, res) => {
    try {
      const proj = readProject(req.params.id);
      proj.models = listModels(req.params.id);   // 运行时注入：validate 的模型检查要用，不写回文件
      res.json({ ok: true, ...buildAll(proj, false), warnings: validate(proj) });
    } catch (e) { res.status(404).json({ error: 'project not found' }); }
  });

  /* 导出插件包：和远程安装（发布）同一份打包流程（prepareExportZip），直接下载到本地（不改版本号、不落盘）。
   * 配置有 error 级问题返回 400 + warnings */
  r.get('/projects/:id/export', async (req, res) => {
    let out;
    try { out = await prepareExportZip(req.params.id); }
    catch (e) {
      if (e.code === 'NOT_FOUND') return res.status(404).json({ error: 'project not found' });
      if (e.code === 'INVALID') return res.status(400).json({ error: e.message, warnings: e.warnings });
      return res.status(500).json({ error: e.message });
    }
    const { proj, built, buf } = out;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${proj.id}-v${built.manifest.version}.zip"`);
    res.send(buf);
  });

  /* 导出项目：整个项目文件夹（project.json + custom.js + models/）原样打包下载，用于备份/迁移。
   * 不做校验、不注入配置、不动版本号，同样不落盘 */
  r.get('/projects/:id/export-project', async (req, res) => {
    let buf;
    try { buf = await buildProjectZip(req.params.id); }
    catch (e) {
      if (e.code === 'NOT_FOUND') return res.status(404).json({ error: 'project not found' });
      return res.status(500).json({ error: e.message });
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeId(req.params.id)}-project.zip"`);
    res.send(buf);
  });

  /* 发布插件包（远程安装到 ha-3d-home）。
   * 远程安装接口约定（ha-3d-home 侧已实现：server/index.js + server/plugins.js）：
   *   POST {host}/api/plugins/install?id=<插件id，等于项目 id>&version=<v>
   *   Headers:
   *     Content-Type: application/zip
   *     X-Install-Key: <设置里填的密钥>        ← 校验失败返回 401 { error }
   *     X-Plugin-Id / X-Plugin-Version
   *   Body: zip 原始字节。包内结构（无顶层目录）:
   *     plugin.json   插件清单（id = 项目 id，含 version）
   *     plugin.js     注册代码
   *     models/*.glb  模型（可能没有）
   *   行为: 解压写入 custom/plugins/<id>/（已存在则整体替换 → 重复安装 = 覆盖升级），
   *         成功返回 200 { ok: true }；失败返回非 2xx + { error: '原因' }。
   * 打包/发布共用逻辑在 plugin-pkg.js（prepareExportZip / publishProject，与 MCP 工具共享同一实现） */
  r.post('/projects/:id/publish', async (req, res) => {
    const pid = req.params.id;
    if (!safeId(pid)) return res.status(400).json({ error: 'project id invalid' });
    try {
      const { manifest, copied, remote } = await publishProject(pid, !!req.body.bump);
      res.json({ ok: true, host: remote.host, pluginId: manifest.id, manifest, copied });
    } catch (e) {
      if (e.code === 'NOT_FOUND') return res.status(404).json({ error: 'project not found' });
      if (e.code === 'INVALID') return res.status(400).json({ error: e.message, warnings: e.warnings });
      res.status(502).json({ error: e.message });
    }
  });

  /* ---- 家具包（kind: catalog）：导出 / 发布 ----
   * 产物是 ha-3d-home 的家具包格式（item.json + 多个平铺 glb），与插件包完全是两套东西：
   * 走独立端点，插件端点在遇到 catalog 项目时直接 400 指路。 */
  r.get('/projects/:id/export-catalog', async (req, res) => {
    let out;
    try { out = await prepareCatalogExport(req.params.id, {}); }
    catch (e) {
      if (e.code === 'NOT_FOUND') return res.status(404).json({ error: 'project not found' });
      if (e.code === 'INVALID') return res.status(400).json({ error: e.message, warnings: e.warnings });
      return res.status(500).json({ error: e.message });
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeId(req.params.id) || 'catalog'}-v${out.manifest.version}.zip"`);
    res.send(out.buf);
  });

  r.post('/projects/:id/publish-catalog', async (req, res) => {
    const pid = req.params.id;
    if (!safeId(pid)) return res.status(400).json({ error: 'project id invalid' });
    try {
      const { manifest, copied, remote } = await publishCatalogPkg(pid, !!(req.body && req.body.bump));
      res.json({ ok: true, host: remote.host, manifest, copied, count: manifest.items.length });
    } catch (e) {
      if (e.code === 'NOT_FOUND') return res.status(404).json({ error: 'project not found' });
      if (e.code === 'INVALID') return res.status(400).json({ error: e.message, warnings: e.warnings });
      res.status(502).json({ error: e.message });
    }
  });

  return r;
};
