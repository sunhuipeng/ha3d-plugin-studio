'use strict';
/* 域 3：项目 CRUD + 预览图。
 * 同 ha-3d-home 的拆域口径：本文件自带 Router，index.js 挂载。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const JSZip = require('jszip');
const {
  safeId, safeRemove, PROJECTS_DIR, modelsDir,
  readProject, writeProject, listProjectSummaries,
} = require('../lib/config');
const { newCatalogProject, normalizeCatalog } = require('../lib/catalog-schema');

module.exports = function projectRoutes() {
  const r = express.Router();

  /* 项目列表：基础信息来自 config.listProjectSummaries（与 MCP studio_list_projects 同一份），
   * 这里补前端卡片要的字段（hasCustomJs 等） */
  r.get('/projects', (req, res) => {
    const items = listProjectSummaries().map((it) => {
      let hasCustomJs = false;
      try { hasCustomJs = String(readProject(it.id).customJs || '').trim() !== ''; } catch (e) { /* skip */ }
      return {
        id: it.id, name: it.name, updatedAt: it.updatedAt, models: it.models,
        pluginId: it.pluginId, hasCustomJs, kind: it.kind, type: it.type,
        /* 家具项目：卡片角标显示件数 */
        items: it.items || 0,
      };
    });
    res.json({ items });
  });

  /* 新建项目：kind 在这里定死（device / background / catalog），之后不允许改
   * —— 两类项目的数据结构与编辑页完全不同，中途切换只会丢配置。 */
  r.post('/projects', (req, res) => {
    const id = 'p' + crypto.randomBytes(4).toString('hex');
    const kind = String(req.body.kind || 'device').trim().toLowerCase();
    if (kind !== 'device' && kind !== 'background' && kind !== 'catalog') {
      return res.status(400).json({ error: 'kind 只能是 device（设备/门窗）、background（背景）或 catalog（家具包）' });
    }
    const name = String(req.body.name || '').slice(0, 60);
    let proj;
    if (kind === 'catalog') {
      proj = newCatalogProject(id, name || '未命名家具包');
    } else {
      proj = {
        id,
        name: name || '未命名插件',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        plugin: {
          id, name: name || '未命名插件', kind,
          type: kind === 'background' ? 'bg' : 'switch',
          version: '1.0.0', description: '',
        },
        styles: [{ id: 'default', name: '默认造型', z: 0, icon: '', desc: '' }],
        fields: [],
        customJs: '',
      };
    }
    writeProject(id, proj);
    res.json({ ok: true, project: proj });
  });

  /* 导入项目：上传「导出项目」生成的备份 zip（project.json + preview.png + models/），
   * 解包还原成一个新项目。id 冲突时自动换新 id（project.json 的 id 与 plugin.id 同步改写） */
  r.post('/projects/import', express.raw({ type: () => true, limit: '256mb' }), async (req, res) => {
    try {
      const zip = await JSZip.loadAsync(req.body);
      const projFile = zip.file('project.json');
      if (!projFile) return res.status(400).json({ error: 'zip 里没有 project.json（只认「导出项目」生成的备份包）' });
      const proj = JSON.parse(await projFile.async('string'));
      /* 新 id：与现有项目不冲突 */
      let id = typeof proj.id === 'string' && proj.id ? proj.id : '';
      if (!id || fs.existsSync(path.join(PROJECTS_DIR, safeId(id)))) {
        id = 'p' + crypto.randomBytes(4).toString('hex');
        while (fs.existsSync(path.join(PROJECTS_DIR, id))) id = 'p' + crypto.randomBytes(4).toString('hex');
      }
      proj.id = id;
      if (proj.plugin && typeof proj.plugin === 'object') proj.plugin.id = id;
      proj.updatedAt = new Date().toISOString();
      writeProject(id, proj);
      /* 其余文件（preview.png / models/*）原样落盘 */
      for (const name of Object.keys(zip.files)) {
        if (name === 'project.json' || name === 'backups' || name.startsWith('backups/') || name.endsWith('/')) continue;
        const dest = path.join(PROJECTS_DIR, id, name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, await zip.file(name).async('nodebuffer'));
      }
      res.json({ ok: true, id, name: proj.name });
    } catch (e) {
      res.status(500).json({ error: '导入失败: ' + e.message });
    }
  });

  r.get('/projects/:id', (req, res) => {
    try { res.json(readProject(req.params.id)); }
    catch (e) { res.status(404).json({ error: 'project not found' }); }
  });

  /* 保存项目：kind 一律以磁盘为准（创建后不可改），变更请求直接 409。
   * 家具项目（catalog）落盘前归一 items（补默认值）。 */
  r.put('/projects/:id', (req, res) => {
    const proj = req.body.project || req.body;
    if (!proj || proj.id !== req.params.id) return res.status(400).json({ error: 'project id mismatch' });

    let prev = null;
    try { prev = readProject(req.params.id); } catch (e) { /* 不存在就当作首次写入 */ }
    if (prev && prev.plugin && proj.plugin) {
      const kPrev = String(prev.plugin.kind || '');
      const kNext = String(proj.plugin.kind || '') || kPrev;
      if (kPrev && kNext !== kPrev) {
        return res.status(409).json({
          error: `项目类型（kind）创建后不可更改：当前是 ${kPrev}，不能改成 ${kNext}`,
        });
      }
      if (kPrev) proj.plugin.kind = kPrev;
    }
    if (proj.plugin && proj.plugin.kind === 'catalog') normalizeCatalog(proj);

    writeProject(req.params.id, proj);
    res.json({ ok: true });
  });

  r.delete('/projects/:id', (req, res) => {
    const ret = safeRemove(path.join(PROJECTS_DIR, safeId(req.params.id) || ''));
    if (!ret.ok) return res.status(500).json({ error: '删除失败: ' + ret.error });
    res.json({ ok: true });
  });

  /* 复制项目（含 models / refs 文件） */
  r.post('/projects/:id/copy', (req, res) => {
    let src;
    try { src = readProject(req.params.id); }
    catch (e) { return res.status(404).json({ error: 'project not found' }); }
    const id = 'p' + crypto.randomBytes(4).toString('hex');
    const copy = JSON.parse(JSON.stringify(src));
    copy.id = id;
    copy.name = String(req.body.name || (src.name + ' 副本')).slice(0, 60);
    if (copy.plugin) {
      copy.plugin.id = id;            // 插件 id 恒等于项目 id（副本也是）
      copy.plugin.name = copy.name;   // 插件名称 = 项目名称
    }
    copy.createdAt = new Date().toISOString();
    writeProject(id, copy);
    /* 模型文件一并复制（新项目目录与源项目同构，不需要先建目录） */
    const srcModels = modelsDir(req.params.id);
    if (fs.existsSync(srcModels)) fs.cpSync(srcModels, modelsDir(id), { recursive: true });
    res.json({ ok: true, project: copy });
  });

  /* ---- 项目预览图（启动页卡片用） ----
   * 编辑页每次渲染成功后把快照存到 data/projects/<id>/preview.png（代码为空/报错时存
   * 白底+网格的占位图），启动页直接 <img> 读，不做任何现场 3D 渲染。 */
  r.get('/projects/:id/preview.png', (req, res) => {
    const p = path.join(PROJECTS_DIR, safeId(req.params.id) || '_', 'preview.png');
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'no preview' });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache');   // 配合 ?t=updatedAt 协商
    res.sendFile(p);
  });

  r.put('/projects/:id/preview.png', express.raw({ type: () => true, limit: '16mb' }), (req, res) => {
    const dir = path.join(PROJECTS_DIR, safeId(req.params.id) || '_');
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'project not found' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: '空文件' });
    fs.writeFileSync(path.join(dir, 'preview.png'), req.body);
    res.json({ ok: true });
  });

  return r;
};
