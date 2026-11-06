/* 全部 API 路由（Express Router） */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  safeId, safeFile, ensureDir, modelsDir, PROJECTS_DIR,
  readProject, writeProject, getConfig, saveConfig, remoteTarget, listModels,
  listProjectSummaries,
} = require('./config');
const { buildAll, validate } = require('./generator');
const JSZip = require('jszip');
const { prepareExportZip, buildProjectZip } = require('./plugin-pkg');
const { fixGlbMaterials } = require('./fixglb');
const { splitGlb, splitGlbOne } = require('./split-glb');
const api = express.Router();

/* 删除: 优先 rmSync；部分环境（如 WorkBuddy 沙箱）拦截 rm，降级 rename 到 .deleted-* 隐藏目录 */
function safeRemove(targetPath) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    try {
      const parent = path.dirname(targetPath);
      const hidden = path.join(parent, '.deleted-' + Date.now() + '-' + path.basename(targetPath));
      fs.renameSync(targetPath, hidden);
      return { ok: true, degraded: true };
    } catch (e2) {
      return { ok: false, error: e2.message };
    }
  }
}

/* ---- 元信息 ---- */
api.get('/target', (req, res) => {
  res.json({ ...remoteTarget() });
});

api.put('/target', (req, res) => {
  const host = String(req.body.host || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/.test(host)) return res.status(400).json({ error: '主机地址需以 http:// 或 https:// 开头' });
  const cfg = getConfig();
  cfg.remote = { host, key: String(req.body.key || '').trim() };
  saveConfig(cfg);
  res.json({ ok: true, ...remoteTarget() });
});

/* ---- 项目 CRUD ---- */
api.get('/projects', (req, res) => {
  /* 基础列表来自 config.listProjectSummaries（与 MCP studio_list_projects 同一份），这里补前端卡片要的字段 */
  const items = listProjectSummaries().map((it) => {
    let hasCustomJs = false;
    try { hasCustomJs = String(readProject(it.id).customJs || '').trim() !== ''; } catch (e) { /* skip */ }
    return { id: it.id, name: it.name, updatedAt: it.updatedAt, models: it.models, pluginId: it.pluginId, hasCustomJs, kind: it.kind, type: it.type };
  });
  res.json({ items });
});

api.post('/projects', (req, res) => {
  const id = 'p' + crypto.randomBytes(4).toString('hex');
  const proj = {
    id,
    name: String(req.body.name || '未命名插件').slice(0, 60),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    plugin: { id, name: req.body.name || '未命名插件', kind: 'device', type: 'switch', version: '1.0.0', description: '' },
    styles: [{ id: 'default', name: '默认造型', z: 0, icon: '', desc: '' }],
    fields: [],
    customJs: '',
  };
  writeProject(id, proj);
  res.json({ ok: true, project: proj });
});

/* 导入项目：上传「导出项目」生成的备份 zip（project.json + preview.png + models/），
 * 解包还原成一个新项目。id 冲突时自动换新 id（project.json 的 id 与 plugin.id 同步改写） */
api.post('/projects/import', express.raw({ type: () => true, limit: '256mb' }), async (req, res) => {
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

api.get('/projects/:id', (req, res) => {
  try { res.json(readProject(req.params.id)); }
  catch (e) { res.status(404).json({ error: 'project not found' }); }
});

api.put('/projects/:id', (req, res) => {
  const proj = req.body.project || req.body;
  if (!proj || proj.id !== req.params.id) return res.status(400).json({ error: 'project id mismatch' });
  writeProject(req.params.id, proj);
  res.json({ ok: true });
});

api.delete('/projects/:id', (req, res) => {
  const r = safeRemove(path.join(PROJECTS_DIR, safeId(req.params.id) || ''));
  if (!r.ok) return res.status(500).json({ error: '删除失败: ' + r.error });
  res.json({ ok: true });
});

/* 复制项目（含 models / refs 文件） */
api.post('/projects/:id/copy', (req, res) => {
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

/* ---- 部件 GLB ---- */
api.get('/projects/:id/models', (req, res) => res.json({ files: listModels(req.params.id) }));

/* 代理读取 ha-3d-home 的户型长宽（背景插件项目打开时自动同步构图参考）。
 * home 侧 /api/house/size 是免鉴权 GET，这里只要求配了地址；
 * home 不可达/无有效值时返回 ok:false，前端静默跳过 */
api.get('/home/house', async (req, res) => {
  const remote = remoteTarget();
  if (!remote.host) return res.json({ ok: false, error: '未配置 home 服务地址' });
  try {
    const r = await fetch(remote.host.replace(/\/+$/, '') + '/api/house/size', { signal: AbortSignal.timeout(4000) });
    const d = await r.json().catch(() => ({}));
    const w = Number(d.houseW);
    const h = Number(d.houseD);
    if (!r.ok || !(w > 0) || !(h > 0)) return res.json({ ok: false, error: 'home 返回无效的户型长宽' });
    res.json({ ok: true, houseW: w, houseD: h });
  } catch (e) {
    res.json({ ok: false, error: '无法连接 ha-3d-home: ' + (e && e.message || e) });
  }
});

/* ---- 项目预览图（启动页卡片用） ----
 * 编辑页每次渲染成功后把快照存到 data/projects/<id>/preview.png（代码为空/报错时存
 * 白底+网格的占位图），启动页直接 <img> 读，不做任何现场 3D 渲染。 */
api.get('/projects/:id/preview.png', (req, res) => {
  const p = path.join(PROJECTS_DIR, safeId(req.params.id) || '_', 'preview.png');
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'no preview' });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-cache');   // 配合 ?t=updatedAt 协商
  res.sendFile(p);
});

api.put('/projects/:id/preview.png', express.raw({ type: () => true, limit: '16mb' }), (req, res) => {
  const dir = path.join(PROJECTS_DIR, safeId(req.params.id) || '_');
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'project not found' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: '空文件' });
  fs.writeFileSync(path.join(dir, 'preview.png'), req.body);
  res.json({ ok: true });
});

/* 单个模型文件（3D 视口 / 缩略图加载用） */
api.get('/projects/:id/models/:file', (req, res) => {
  const file = safeFile(req.params.file);
  if (!file) return res.status(400).json({ error: '文件名不合法' });
  const p = path.join(modelsDir(req.params.id), file);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'model not found' });
  res.setHeader('Content-Type', 'model/gltf-binary');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(p);
});

api.put('/projects/:id/models/:file', express.raw({ type: () => true, limit: '128mb' }), (req, res) => {
  const file = safeFile(req.params.file);
  if (!file || !file.toLowerCase().endsWith('.glb')) return res.status(400).json({ error: '文件名不合法（仅支持 .glb）' });
  if (!req.body || !req.body.length) return res.status(400).json({ error: '空文件' });
  ensureDir(modelsDir(req.params.id));
  fs.writeFileSync(path.join(modelsDir(req.params.id), file), req.body);
  res.json({ ok: true, file, size: req.body.length });
});

api.delete('/projects/:id/models/:file', (req, res) => {
  const file = safeFile(req.params.file);
  if (file) safeRemove(path.join(modelsDir(req.params.id), file));
  res.json({ ok: true });
});

/* 拆分 GLB：默认全拆（每个顶层 node → 独立 .glb）；body 传 { node } 则只导出该节点。
   顶点均烘焙世界变换（新模型节点在原点），写入 models/ */
api.post('/projects/:id/models/:file/split', (req, res) => {
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
api.post('/projects/:id/models/:file/fix-materials', (req, res) => {
  const file = safeFile(req.params.file);
  if (!file || !file.toLowerCase().endsWith('.glb')) return res.status(400).json({ error: '文件名不合法（仅支持 .glb）' });
  const p = path.join(modelsDir(req.params.id), file);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'model not found' });
  try {
    const buf = fs.readFileSync(p);
    const r = fixGlbMaterials(buf);
    if (r.changed > 0) fs.writeFileSync(p, r.data);
    res.json({ ok: true, changed: r.changed, problems: r.problems, notes: r.notes,
      message: r.changed > 0 ? `已修复 ${r.changed} 处材质问题` : '材质健康，无需修复' });
  } catch (e) {
    res.status(400).json({ error: '修复失败: ' + e.message });
  }
});

/* ---- 生成 / 发布 ---- */
api.get('/projects/:id/build', (req, res) => {
  try {
    const proj = readProject(req.params.id);
    proj.models = listModels(req.params.id);   // 运行时注入：validate 的模型检查要用，不写回文件
    res.json({ ok: true, ...buildAll(proj, false), warnings: validate(proj) });
  } catch (e) { res.status(404).json({ error: 'project not found' }); }
});

/* ---- 远程安装接口约定（ha-3d-home 侧已实现：server/index.js + server/plugins.js） ----
 * POST {host}/api/plugins/install?id=<插件id，等于项目 id>&version=<v>
 * Headers:
 *   Content-Type: application/zip
 *   X-Install-Key: <设置里填的密钥>        ← 校验失败返回 401 { error }
 *   X-Plugin-Id / X-Plugin-Version
 * Body: zip 原始字节。包内结构（无顶层目录）:
 *   plugin.json   插件清单（id = 项目 id，含 version）
 *   plugin.js     注册代码
 *   models/*.glb  模型（可能没有）
 * 行为: 解压写入 custom/plugins/<id>/（已存在则整体替换 → 重复安装 = 覆盖升级），
 *      成功返回 200 { ok: true }；失败返回非 2xx + { error: '原因' }。
 * ------------------------------------------------------------------ */

/* 打包/发布共用逻辑在 plugin-pkg.js（prepareExportZip / publishProject，与 MCP 工具共享同一实现） */
const { publishProject } = require('./plugin-pkg');

/* 导出插件包：和远程安装（发布）同一份打包流程（prepareExportZip），直接下载到本地（不改版本号、不落盘）。
 * 配置有 error 级问题返回 400 + warnings */
api.get('/projects/:id/export', async (req, res) => {
  let r;
  try { r = await prepareExportZip(req.params.id); }
  catch (e) {
    if (e.code === 'NOT_FOUND') return res.status(404).json({ error: 'project not found' });
    if (e.code === 'INVALID') return res.status(400).json({ error: e.message, warnings: e.warnings });
    return res.status(500).json({ error: e.message });
  }
  const { proj, built, buf } = r;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${proj.id}-v${built.manifest.version}.zip"`);
  res.send(buf);
});

/* 导出项目：整个项目文件夹（project.json + custom.js + models/）原样打包下载，用于备份/迁移。
 * 不做校验、不注入配置、不动版本号，同样不落盘 */
api.get('/projects/:id/export-project', async (req, res) => {
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

api.post('/projects/:id/publish', async (req, res) => {
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

module.exports = { api };
