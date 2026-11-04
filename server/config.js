/* 路径常量 / 配置 / 项目数据读写 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/* 端口与数据目录支持环境变量覆盖（Docker 部署用，对齐 ha-3d-home 的约定）：
 *   PORT                  监听端口，默认 8098
 *   HA3D_STUDIO_DATA_DIR  数据目录（projects/ + config.json），默认 <项目根>/data；容器里指向挂载卷 /data */
const PORT = Number(process.env.PORT) || 8098;
const CLIENT_DIST = path.join(ROOT, 'client', 'dist');
const DATA_DIR = process.env.HA3D_STUDIO_DATA_DIR
  ? path.resolve(process.env.HA3D_STUDIO_DATA_DIR)
  : path.join(ROOT, 'data');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const safeId = (s) => (/^[a-z][a-z0-9_]{1,39}$/.test(String(s || '')) ? s : null);
const safeFile = (s) => {
  const base = path.basename(String(s || ''));
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(base) ? base : null;
};
const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });

const projectDir = (id) => path.join(PROJECTS_DIR, id);
const projectFile = (id) => path.join(projectDir(id), 'project.json');
const modelsDir = (id) => path.join(projectDir(id), 'models');

const readProject = (id) => JSON.parse(fs.readFileSync(projectFile(id), 'utf8'));
const writeProject = (id, proj) => {
  ensureDir(projectDir(id));
  proj.updatedAt = new Date().toISOString();
  fs.writeFileSync(projectFile(id), JSON.stringify(proj, null, 2));
};

function getConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { return {}; }
}
const saveConfig = (cfg) => { ensureDir(DATA_DIR); fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); };
/* 远程发布目标: ha-3d-home 的主机地址 + 安装密钥（存 config.json 的 remote 字段）。
 * 发布时服务端把插件打包成 zip，POST 到 {host}/api/plugins/install 远程安装（home 侧已实现）。 */
const DEFAULT_REMOTE_HOST = 'http://localhost:8077';
const remoteTarget = () => {
  const cfg = getConfig();
  return {
    host: (cfg.remote && cfg.remote.host) || DEFAULT_REMOTE_HOST,
    key: (cfg.remote && cfg.remote.key) || '',
  };
};

function listModels(id) {
  try { return fs.readdirSync(modelsDir(id)).filter((f) => f.toLowerCase().endsWith('.glb')); } catch (e) { return []; }
}

/* 项目列表基础信息（REST GET /projects 与 MCP studio_list_projects 共用，按最近更新排序）。
 * 返回磁盘目录 id + 项目元信息；调用方在基础上补各自需要的字段（如 hasCustomJs / kind） */
function listProjectSummaries() {
  const items = [];
  for (const d of fs.readdirSync(PROJECTS_DIR)) {
    if (d.startsWith('.')) continue;
    try {
      const pr = readProject(d);
      items.push({
        id: pr.id,
        dirId: d,
        name: pr.name,
        updatedAt: pr.updatedAt || '',
        pluginId: (pr.plugin && pr.plugin.id) || '',
        kind: (pr.plugin && pr.plugin.kind) || '',
        type: (pr.plugin && pr.plugin.type) || '',
        models: listModels(d).length,
      });
    } catch (e) { /* 跳过损坏的项目目录 */ }
  }
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

module.exports = {
  ROOT, PORT, CLIENT_DIST, DATA_DIR, PROJECTS_DIR,
  safeId, safeFile, ensureDir,
  modelsDir,
  readProject, writeProject, getConfig, saveConfig, remoteTarget,
  listModels, listProjectSummaries,
};
