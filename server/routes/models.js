'use strict';
/* 域 4：部件 GLB —— 上传 / 下载 / 删除 / 拆分 / 修材质。
 * 同 ha-3d-home 的拆域口径：本文件自带 Router，index.js 挂载。 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const { safeFile, safeRemove, ensureDir, modelsDir, listModels } = require('../lib/config');
const { splitGlb, splitGlbOne } = require('../lib/split-glb');
const { fixGlbMaterials } = require('../lib/fixglb');

module.exports = function modelRoutes() {
  const r = express.Router();

  r.get('/projects/:id/models', (req, res) => {
    res.json({ files: listModels(req.params.id) });
  });

  /* 单个模型文件（3D 视口 / 缩略图加载用） */
  r.get('/projects/:id/models/:file', (req, res) => {
    const file = safeFile(req.params.file);
    if (!file) return res.status(400).json({ error: '文件名不合法' });
    const p = path.join(modelsDir(req.params.id), file);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'model not found' });
    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(p);
  });

  r.put('/projects/:id/models/:file', express.raw({ type: () => true, limit: '128mb' }), (req, res) => {
    const file = safeFile(req.params.file);
    if (!file || !file.toLowerCase().endsWith('.glb')) return res.status(400).json({ error: '文件名不合法（仅支持 .glb）' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: '空文件' });
    ensureDir(modelsDir(req.params.id));
    fs.writeFileSync(path.join(modelsDir(req.params.id), file), req.body);
    res.json({ ok: true, file, size: req.body.length });
  });

  r.delete('/projects/:id/models/:file', (req, res) => {
    const file = safeFile(req.params.file);
    if (file) safeRemove(path.join(modelsDir(req.params.id), file));
    res.json({ ok: true });
  });

  /* 拆分 GLB：默认全拆（每个顶层 node → 独立 .glb）；body 传 { node } 则只导出该节点。
     顶点均烘焙世界变换（新模型节点在原点），写入 models/ */
  r.post('/projects/:id/models/:file/split', (req, res) => {
    const file = safeFile(req.params.file);
    if (!file || !file.toLowerCase().endsWith('.glb')) return res.status(400).json({ error: '文件名不合法（仅支持 .glb）' });
    const p = path.join(modelsDir(req.params.id), file);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'model not found' });
    try {
      const base = file.replace(/\.glb$/i, '');
      const buf = fs.readFileSync(p);
      const node = req.body && typeof req.body.node === 'string' ? req.body.node.trim() : '';
      const dir = modelsDir(req.params.id);
      ensureDir(dir);

      if (node) {
        const one = splitGlbOne(buf, base, node);
        for (const f of one) fs.writeFileSync(path.join(dir, f.file), f.data);
        return res.json({
          ok: true,
          single: true,
          node: one[0].node,
          files: one.map((x) => ({ file: x.file, node: x.node, size: x.data.length })),
          message: `已把节点「${one[0].node}」导出为独立模型`,
        });
      }

      const parts = splitGlb(buf, base);
      for (const part of parts) fs.writeFileSync(path.join(dir, part.file), part.data);
      res.json({
        ok: true,
        files: parts.map((x) => ({ file: x.file, node: x.node, size: x.data.length })),
        message: `已拆分为 ${parts.length} 个独立模型`,
      });
    } catch (e) {
      res.status(400).json({ error: '拆分失败: ' + e.message });
    }
  });

  /* 修复 GLB 材质（过暗/metallic 偏高/压暗扩展）。原地改写、**不留备份**：
   * 修法幂等（修过的不会再动），模型源文件由用户自己保管（git / 素材库） */
  r.post('/projects/:id/models/:file/fix-materials', (req, res) => {
    const file = safeFile(req.params.file);
    if (!file || !file.toLowerCase().endsWith('.glb')) return res.status(400).json({ error: '文件名不合法（仅支持 .glb）' });
    const p = path.join(modelsDir(req.params.id), file);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'model not found' });
    try {
      const buf = fs.readFileSync(p);
      const ret = fixGlbMaterials(buf);
      if (ret.changed > 0) fs.writeFileSync(p, ret.data);
      res.json({ ok: true, changed: ret.changed, problems: ret.problems, notes: ret.notes,
        message: ret.changed > 0 ? `已修复 ${ret.changed} 处材质问题` : '材质健康，无需修复' });
    } catch (e) {
      res.status(400).json({ error: '修复失败: ' + e.message });
    }
  });

  return r;
};
