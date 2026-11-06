/* MCP 工具公共助手（被 tools-*.js 各域模块共用）
 *
 * 目录结构：
 *   mcp/helpers.js         ← 本文件：输出格式 / 项目 id 解析 / 分项输出 / glb 解析 / 活动横条
 *   mcp/tools-config.js    get_project / get_code / write_code
 *   mcp/tools-preview.js   set_style / set_option / click / label / reload / view / screenshot / set_entity / get_runtime
 *   mcp/tools-projects.js  list_projects / where / single_window / open_project
 *   mcp/tools-lock.js      lock_config / unlock_config / get_lock（前端只读锁，服务端只中继）
 *   mcp/tools-models.js    upload / get / list / split / delete / rename / fix_model_materials
 *   mcp/tools-publish.js   export_project / publish_project
 *   ../mcp-tools.js        装配入口（buildMcpServer）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { modelsDir, readProject, safeId, listModels } = require('../config');
const { normalizeOptionType } = require('../option-schema');
const { normalizeFieldType, normalizeEnumValues, splitList } = require('../field-schema');
const hub = require('../ws-hub');

/* ---- 工具返回值 ---- */
const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });
const fail = (s) => ({ content: [{ type: 'text', text: String(s) }], isError: true });

/* 未指定 projectId 时：若只有一个项目有前端打开，自动选中；多个则报错让调用方指定 */
function resolveProjectId(pid) {
  if (pid) return pid;
  const open = hub.listFrontends().filter((f) => f.alive && f.projectId);
  const ids = [...new Set(open.map((f) => f.projectId))];
  if (ids.length === 0) {
    throw Object.assign(new Error('当前没有前端页面打开任何项目，请先在浏览器打开项目编辑页'), { code: 'NO_FRONTEND' });
  }
  if (ids.length > 1) {
    throw Object.assign(new Error('同时打开了多个项目，请用 projectId 指定：' + ids.join(', ')), { code: 'AMBIGUOUS_PROJECT' });
  }
  return ids[0];
}

/* 解析 + 校验项目 id（全部工具统一入口：省略 pid 自动选中 + 防目录穿越的 safeId 校验） */
function requirePid(projectId) {
  const pid = resolveProjectId(projectId);
  if (!safeId(pid)) throw new Error('项目 id 不合法');
  return pid;
}

/* 中继报错统一翻译：「前端不支持工具」几乎都是页面跑着旧构建 → 提示刷新 */
const friendlyRelayError = (e, hint) => (/不支持工具/.test(e.message) ? hint : e.message);

const SCREEN_VIEWS = ['iso', 'front', 'back', 'left', 'right', 'top', 'low', 'detail'];

/* models/ 目录清单（带文件大小）；config.listModels 只给文件名，这里补 size */
function modelsWithSize(pid) {
  try {
    return listModels(pid).map((file) => ({
      file,
      size: fs.statSync(path.join(modelsDir(pid), file)).size,
    }));
  } catch (e) { return []; }
}

/* 代码里引用某个模型文件的位置（删/改名后要提醒调用方去改代码，不能静默留死引用） */
function codeRefLines(pid, fileName) {
  try {
    const code = String(readProject(pid).customJs || '');
    if (!code || !fileName) return [];
    const out = [];
    code.split('\n').forEach((line, i) => {
      if (line.includes(fileName)) out.push({ line: i + 1, text: line.trim().slice(0, 140) });
    });
    return out;
  } catch (e) { return []; }
}

/* ---- 分项输出（一站式与分项工具共用，保证字段口径一致） ---- */
function settingsOut(p) {
  return {
    id: p.plugin?.id || '',
    name: p.plugin?.name || '',
    kind: p.plugin?.kind || 'device',
    type: p.plugin?.type || '',
    version: p.plugin?.version || '',
    description: p.plugin?.description || '',
    entityId: p.plugin?.entityId || '',
  };
}
function fieldsOut(p) {
  return (p.fields || []).filter((f) => f && f.key).map((f) => {
    const valueType = normalizeFieldType(f.valueType);
    const out = {
      key: f.key,
      label: f.label || f.key,
      domains: splitList(f.domains),
      placeholder: f.placeholder || '',
      tip: f.tip || '',
      entityId: f.entityId || '',
      /* 值类型与枚举值只是给人 / AI 读的说明，引擎渲染不用它们 */
      valueType,
    };
    if (valueType === 'enum') out.enumValues = normalizeEnumValues(f.enumValues);
    return out;
  });
}
function stylesOut(p) {
  return (p.styles || []).map((s) => ({
    id: s.id,
    name: s.name || s.id,
    desc: s.desc || '',
    z: s.z,
    icon: s.icon || '',
    options: (s.options || []).map((o) => ({
      key: o.key, label: o.label || o.key, type: normalizeOptionType(o.type),
      def: o.def, min: o.min, max: o.max, step: o.step, choices: o.choices,
    })),
  }));
}
function modelsOut(pid) {
  return modelsWithSize(pid).map((m) => ({
    ...m,
    url: `/api/projects/${pid}/models/${encodeURIComponent(m.file)}`,
  }));
}

/* 项目配置全貌（不含代码）：开工前用它建上下文 */
function projectConfig(p, pid) {
  return {
    projectId: pid,
    name: p.name,
    createdAt: p.createdAt || '',
    updatedAt: p.updatedAt || '',
    /* 用户在「提示词」面板写的开发要求（空 = 没写）。AI 改代码前应先读这一段 */
    aiPrompt: p.aiPrompt || '',
    /* 设置：插件元信息 */
    settings: settingsOut(p),
    styles: stylesOut(p),
    fields: fieldsOut(p),
    models: modelsOut(pid),
    code: {
      source: 'customJs',
      lines: String(p.customJs || '').split('\n').length,
    },
  };
}

/* 解析 GLB 二进制头 + JSON chunk，提取结构摘要（网格 / 节点 / 材质 / 动画 / 包围盒）。
 * 供 AI 拿到导出路径后快速了解模型构成，不必再自己写解析脚本。 */
function glbSummary(buf) {
  if (!buf || buf.length < 12 || buf.readUInt32LE(0) !== 0x46546c67) return { format: 'not-glb' };
  const out = { format: 'glb', version: buf.readUInt32LE(4) };
  let off = 12, json = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a) {
      try { json = JSON.parse(buf.slice(off + 8, off + 8 + len).toString('utf8')); } catch (e) { /* 损坏就跳过 */ }
      break;
    }
    off += 8 + len;
  }
  if (json) {
    out.meshes = (json.meshes || []).length;
    out.nodes = (json.nodes || []).length;
    out.materials = (json.materials || []).length;
    out.animations = (json.animations || []).length;
    out.textures = (json.textures || []).length;
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    let hasPos = false;
    for (const m of json.meshes || []) {
      for (const p of m.primitives || []) {
        const a = (json.accessors || [])[(p.attributes || {}).POSITION];
        if (!a || !a.min || !a.max) continue;
        hasPos = true;
        for (let i = 0; i < 3; i++) {
          mn[i] = Math.min(mn[i], a.min[i]);
          mx[i] = Math.max(mx[i], a.max[i]);
        }
      }
    }
    if (hasPos) {
      out.bbox = {
        min: mn.map((v) => Math.round(v * 1000) / 1000),
        max: mx.map((v) => Math.round(v * 1000) / 1000),
        size: mx.map((v, i) => Math.round((v - mn[i]) * 1000) / 1000),   // [宽(x) 高(y) 厚(z)]，米
      };
      out.bboxNote = 'POSITION accessor 的 min/max（未叠加节点变换），size 单位为米';
    }
    /* 逐 mesh 概要：AI 常需要「这个模型由哪几块组成、各多大」（门框/门扇/把手…） */
    const meshes = json.meshes || [];
    if (meshes.length) {
      out.meshList = meshes.slice(0, 20).map((m, mi) => {
        let verts = 0, tris = 0;
        const bmn = [Infinity, Infinity, Infinity];
        const bmx = [-Infinity, -Infinity, -Infinity];
        for (const p of m.primitives || []) {
          const pos = (json.accessors || [])[(p.attributes || {}).POSITION];
          if (pos) {
            verts += pos.count || 0;
            if (pos.min && pos.max) for (let i = 0; i < 3; i++) {
              bmn[i] = Math.min(bmn[i], pos.min[i]);
              bmx[i] = Math.max(bmx[i], pos.max[i]);
            }
          }
          const idx = (json.accessors || [])[p.indices];
          if (idx) tris += Math.round((idx.count || 0) / 3);
        }
        const row = {
          index: mi,
          name: m.name || '',
          primitives: (m.primitives || []).length,
          verts,
          tris,
        };
        if (Number.isFinite(bmn[0])) {
          row.size = bmx.map((v, i) => Math.round((v - bmn[i]) * 1000) / 1000);
          row.min = bmn.map((v) => Math.round(v * 1000) / 1000);
          row.max = bmx.map((v) => Math.round(v * 1000) / 1000);
        }
        return row;
      });
      if (meshes.length > 20) out.meshListNote = `只列前 20 个，共 ${meshes.length} 个 mesh，其余请用本地脚本解析`;
    }
    /* 顶层节点名：studio_split_model 的 node 参数就用这里面的名字 */
    const nodes = json.nodes || [];
    if (nodes.length) {
      const child = new Set();
      nodes.forEach((n) => (n.children || []).forEach((c) => child.add(c)));
      const roots = [];
      nodes.forEach((n, i) => { if (!child.has(i)) roots.push(i); });
      out.nodeList = roots.slice(0, 30).map((i) => ({
        index: i,
        name: nodes[i].name || '',
        mesh: nodes[i].mesh == null ? null : nodes[i].mesh,
        children: (nodes[i].children || []).length,
      }));
      if (roots.length > 30) out.nodeListNote = `只列前 30 个顶层节点，共 ${roots.length} 个`;
    }
  }
  return out;
}

/* 让每一次工具调用都在前端横条上留下痕迹：
 *   activity → 前端显示「MCP 正在执行：<工具名>」
 *   idle     → 执行完切回「MCP 已连接，等待指令…」（连接还在，横条不收起）
 * 统一在这里包一层；同时兜底 catch（handler 忘写 try/catch 也不会把 MCP 会话打崩）。
 * 只支持 (name, desc, shape, handler) 四参形态——MCP SDK 还有无 desc 的三参重载，
 * 传错位时 shape 会拿到函数，这里显式断言防静默错位。 */
function wrapToolActivity(server) {
  const rawTool = server.tool.bind(server);
  server.tool = (name, desc, shape, cb) => {
    if (typeof cb !== 'function' || typeof shape !== 'object' || shape == null) {
      throw new Error(`工具 ${name} 注册参数不对：统一用 (name, desc, shape, handler) 四参形态`);
    }
    rawTool(name, desc, shape, async (...args) => {
      hub.broadcast({ type: 'mcp', event: 'activity', tool: name, ts: Date.now() });
      try {
        return await cb(...args);
      } catch (e) {
        return fail(e.message);
      } finally {
        hub.broadcast({ type: 'mcp', event: 'idle', tool: name, ts: Date.now() });
      }
    });
  };
}

module.exports = {
  text, fail,
  resolveProjectId, requirePid, friendlyRelayError,
  SCREEN_VIEWS, modelsWithSize, codeRefLines,
  settingsOut, fieldsOut, stylesOut, modelsOut, projectConfig,
  glbSummary, wrapToolActivity,
};
