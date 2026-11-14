'use strict';
/* 项目「新建 / 复制」的唯一实现。
 *
 * 共用方：
 *   - REST 路由 server/routes/projects.js（POST /api/projects、POST /api/projects/:id/copy）
 *   - MCP 工具 server/mcp/tools-projects.js（studio_create_project、studio_copy_project）
 *
 * 两边必须走同一份，否则默认结构、plugin.id 口径、models/ 复制行为会各自漂移。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PROJECTS_DIR, modelsDir, readProject, writeProject } = require('./config');
const { newCatalogProject } = require('./catalog-schema');

const KINDS = ['device', 'background', 'catalog'];

/* 项目 id 由服务端生成，不与已有目录撞名 */
function freshId() {
  let id = 'p' + crypto.randomBytes(4).toString('hex');
  while (fs.existsSync(path.join(PROJECTS_DIR, id))) id = 'p' + crypto.randomBytes(4).toString('hex');
  return id;
}

/* kind 在创建时定死，之后不允许改：device/background 与 catalog 的数据结构、编辑页完全不同 */
function createProject({ name = '', kind = 'device' } = {}) {
  const k = String(kind || 'device').trim().toLowerCase();
  if (!KINDS.includes(k)) {
    throw new Error('kind 只能是 device（设备/门窗）、background（背景）或 catalog（家具包）');
  }
  const id = freshId();
  const n = String(name || '').slice(0, 60);
  const proj = k === 'catalog' ? newCatalogProject(id, n || '未命名家具包') : {
    id,
    name: n || '未命名插件',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    plugin: {
      id,
      name: n || '未命名插件',
      kind: k,
      type: k === 'background' ? 'bg' : 'switch',
      version: '1.0.0',
      description: '',
    },
    styles: [{ id: 'default', name: '默认造型', z: 0, icon: '', desc: '' }],
    fields: [],
    customJs: '',
  };
  writeProject(id, proj);
  return proj;
}

/* 深拷贝整份配置 + models/ 目录；插件 id / name 恒等于项目 id / name */
function copyProject({ sourceId, name } = {}) {
  const src = readProject(sourceId);       // 源项目不存在会抛 ENOENT
  const id = freshId();
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = id;
  copy.name = String(name || (src.name + ' 副本')).slice(0, 60);
  if (copy.plugin && typeof copy.plugin === 'object') {
    copy.plugin.id = id;
    copy.plugin.name = copy.name;
  }
  copy.createdAt = new Date().toISOString();
  writeProject(id, copy);
  const srcModels = modelsDir(sourceId);
  if (fs.existsSync(srcModels)) fs.cpSync(srcModels, modelsDir(id), { recursive: true });
  return copy;
}

module.exports = { createProject, copyProject, KINDS };
