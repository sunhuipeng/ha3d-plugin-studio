/* MCP 工具公共助手（被 tools-*.js 各域模块共用）
 *
 * GLB 边界（2026-11-12 定）：服务端只做「拆分」与「修复材质」两类写操作；
 * GLB 的结构 / 顶点 / 包围盒 / 尺寸一律不在服务端解析、也不返回给 AI，
 * 由 MCP 把 .glb 下载到本机后，AI 自己在本地解析（见下方 GLB_PARSE）。详见 README「GLB 处理边界」。
 *
 * 目录结构：
 *   mcp/helpers.js         ← 本文件：输出格式 / 项目 id 解析 / 分项输出 / 活动横条
 *   mcp/tools-config.js    get_project / get_code / write_code
 *   mcp/tools-preview.js   set_style / set_option / click / label / reload / view / screenshot / set_entity / get_runtime
 *   mcp/tools-projects.js  list_projects / where / single_window / open_project
 *   mcp/tools-lock.js      lock_config / unlock_config / get_lock（前端只读锁，服务端只中继）
 *   mcp/tools-models.js    upload / get / list / split / delete / rename / fix_model_materials
 *   mcp/tools-publish.js   export_project / publish_project
 *   mcp/tools.js           装配入口（buildMcpServer）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { modelsDir, readProject, safeId, listModels } = require('../lib/config');
const { normalizeOptionType } = require('../lib/option-schema');
const { normalizeFieldType, normalizeEnumValues, splitList } = require('../lib/field-schema');
const hub = require('../lib/ws-hub');

/* 面向 AI 的「怎么解析 GLB」统一口径：只用 Python / Node.js 直读二进制容器，
 * 不引导使用 three.js、gltf-transform、trimesh 等第三方库（本机不一定装得上，
 * 装上了版本差异也会让解析结果不可复现）。所有工具描述 / hint 引用这一句，别各写一套。 */
const GLB_PARSE = '下载到本机后用 Python 或 Node.js 直接解析（GLB = 12 字节头 + JSON chunk + BIN chunk，'
  + '读 accessors 就能拿到节点树 / 包围盒 / 材质，零依赖即可，不要引入 three.js 等第三方库）';

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
  const out = {
    id: p.plugin?.id || '',
    name: p.plugin?.name || '',
    kind: p.plugin?.kind || 'device',
    type: p.plugin?.type || '',
    version: p.plugin?.version || '',
    description: p.plugin?.description || '',
    entityId: p.plugin?.entityId || '',
  };
  /* ftype 只在 type:'furniture' 时有意义（家具分类，取值 = home 的 catalog.json types），
   * 其他类型不输出这个键，免得 AI 以为它通用 */
  if (out.type === 'furniture' && p.plugin?.ftype) out.ftype = String(p.plugin.ftype);
  return out;
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
      /* 值类型 / 枚举值 / 字段属性只是给人 / AI 读的说明，引擎渲染不用它们 */
      valueType,
    };
    if (valueType === 'enum') out.enumValues = normalizeEnumValues(f.enumValues);
    /* attributes 是 YAML 原文（可能多行），原样带出去，AI 才能读到实体的属性结构 */
    if (f.attributes) out.attributes = String(f.attributes);
    return out;
  });
}
function stylesOut(p) {
  return (p.styles || []).map((s) => ({
    id: s.id,
    name: s.name || s.id,
    desc: s.desc || '',
    z: s.z,
    labelOffset: s.labelOffset,
    /* 背景刷新率（Hz，0=静态）：与 studio_sync_config 的 styles[].refresh 对齐，
     * 否则 get_project 读不到、AI 用「最终版清单」回写时会把动态背景降级成静态 */
    refresh: typeof s.refresh === 'number' ? s.refresh : undefined,
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

/* 家具项目（kind:'catalog'）的清单：get_project 里一并给出，避免 AI 面对家具包时读不到条目 */
function catalogOut(p) {
  const items = (p.catalog && Array.isArray(p.catalog.items)) ? p.catalog.items : [];
  return {
    packId: p.id || '',
    version: p.plugin?.version || '',
    description: p.plugin?.description || '',
    count: items.length,
    items: items.map((it) => ({ ...it })),
    note: '一条 = 一个 GLB 模型；导出家具包时写成 item.json 的 items[]。'
      + '发布到 home 后的条目 id 是 "<项目id>:<条目id>"。',
  };
}

/* 家具项目没有「插件代码 / 样式参数 / 实体 / 插件预览引擎」：
 * 插件专用工具若落到 furniture 项目上，中继会白等 30~90 秒才超时。
 * 这里早期挡掉并给出家具工具清单（catalog 工具自己用 requirePid，不走这个函数）。 */
function assertPluginProject(projectId) {
  const pid = requirePid(projectId);
  const proj = readProject(pid);
  if (proj.plugin && proj.plugin.kind === 'catalog') {
    throw new Error(`项目 ${pid} 是家具包（kind: catalog），没有插件代码 / 样式 / 实体 / 插件预览引擎。`
      + '家具项目请用：studio_list_catalog_items、studio_get_catalog_item、studio_set_catalog_item、'
      + 'studio_upload_catalog_model、studio_get_catalog_types、studio_select_catalog_item、'
      + 'studio_delete_catalog_items、studio_export_catalog、studio_publish_catalog；'
      + '视图 / 截图 / 模型文件操作用公共工具：studio_view、studio_screenshot、studio_list_models、'
      + 'studio_get_model、studio_split_model、studio_fix_model_materials');
  }
  return pid;
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
    /* 家具项目才有：左侧清单的全部条目（插件项目不出现这个字段） */
    ...(p.plugin?.kind === 'catalog' ? { catalog: catalogOut(p) } : {}),
    code: {
      source: 'customJs',
      lines: String(p.customJs || '').split('\n').length,
    },
  };
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
  GLB_PARSE,
  resolveProjectId, requirePid, assertPluginProject, friendlyRelayError,
  SCREEN_VIEWS, modelsWithSize, codeRefLines,
  settingsOut, fieldsOut, stylesOut, modelsOut, catalogOut, projectConfig,
  wrapToolActivity,
};
