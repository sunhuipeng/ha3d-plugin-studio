/*
 * 家具包（kind: 'catalog'）专用 MCP 工具集
 *
 * 服务端存的就是一份静态 GLB 文件集合 + project.json 里的 catalog.items 清单。
 * 插件编辑页那套工具（write_code / sync_config / set_option / click…）对家具项目没有意义，
 * 家具编辑页的核心是「清单 + 每个 GLB 的属性」。这里补齐四类能力：
 *   1. studio_list_catalog_items   列出当前页全部家具（纯列举：只返回 items 数组，每项含全量属性 + modelFile，无任何写副作用）
 *   2. studio_get_catalog_item     单件家具详情：全量属性 + 模型文件信息（含 model.url 下载地址；纯读，不下载）
 *   3. studio_set_catalog_item     全量属性覆盖：单件整条替换 或 整张清单替换（merge=true 才增量合并）
 *   4. studio_upload_catalog_model 上传本机 GLB（可多个）+ 同时写好右侧属性配置
 *   附：studio_get_catalog_types / studio_delete_catalog_items
 *
 * GLB 边界（2026-11-12 定）：服务端不解析 GLB 的顶点 / 结构 / 包围盒 / 尺寸，也不返回这些明细。
 *   · 服务端只保留两类写操作：拆分（tools-models.js / split-glb.js）、修复材质（fixglb.js）；
 *   · 详细数据一律「AI 按返回的 url 拼 MCP 服务器地址下载 → 用 Python / Node.js 自己解析」（见 H.GLB_PARSE），
 *     尺寸经 item.w/d/h 传入；
 *   · AI 按描述生成的新 glb 也是先落成本机 .glb 文件，再用 studio_upload_catalog_model 上传。
 *
 * 所有写操作：落盘 project.json → 通过 ws 通知编辑页刷新内存清单（what:'catalog'），
 * 避免前端旧内存下一次自动保存把 MCP 刚写的数据覆盖掉。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const {
  readProject, writeProject, modelsDir, ensureDir, listModels, safeFile,
} = require('../lib/config');
const {
  itemDef, ITEM_ID_RE, buildCatalogManifest, validateCatalog, slugOf, uniqueId,
} = require('../lib/catalog-schema');
const { resolveCatalogTypes, fallbackTypes } = require('../lib/catalog-types');
const { prepareCatalogExport, publishCatalog } = require('../lib/catalog-pkg');
const hub = require('../lib/ws-hub');
const H = require('./helpers');

/* 一条家具的全部属性（右侧面板逐项）：全部可选，具体校验在 handler 里做，
 * 这样 AI 把 "2.11" 写成字符串也能被 itemDef 归一，而不是被 zod 直接拒掉。 */
const itemShape = z.object({
  id: z.any().optional().describe('条目 id（包内唯一；发布到 home 后变成 "<项目id>:<条目id>"）'),
  name: z.any().optional().describe('家具名称'),
  type: z.any().optional().describe('分类，必须命中 studio_get_catalog_types 的枚举；不确定填 other'),
  w: z.any().optional().describe('宽（米，X，2D 占位用；自己下载 glb 后用 Python 或 Node.js 解析包围盒再填）'),
  d: z.any().optional().describe('深（米，Z，2D 占位用；自己下载 glb 后用 Python 或 Node.js 解析包围盒再填）'),
  h: z.any().optional().describe('高（米，Y，仅 3D 摆放参考；自己下载 glb 后用 Python 或 Node.js 解析包围盒再填）'),
  color: z.any().optional().describe('兜底色 #rrggbb（没有模型时的 2D 方块颜色）'),
  model: z.any().optional().describe('GLB 纯文件名（必须存在于项目 models/）；只填文件名，不要填 URL / 路径，前端按这个文件名拼模型地址'),
  icon: z.any().optional().describe('2D 平面图标：64×64 SVG 图元字符串，可省'),
  scale: z.any().optional().describe('模型缩放系数（>0，缺省 1）'),
}).passthrough();

const ITEM_FIELDS = [
  ['id', '条目 id，包内唯一，字母数字开头；发布后 home 里的完整 id = <项目id>:<条目id>'],
  ['name', '显示名称'],
  ['type', '分类：决定它在 home 家具库进哪个页签，必须命中分类枚举'],
  ['w', '宽（米，X）'],
  ['d', '深（米，Z）'],
  ['h', '高（米，Y）'],
  ['color', '兜底色（#rrggbb）'],
  ['model', '模型文件名（项目 models/ 里的 .glb）'],
  ['icon', '2D 平面图标 SVG 图元（可选）'],
  ['scale', '模型缩放（可选，缺省 1）'],
];

/* ---------------- 公共助手 ---------------- */

function requireCatalog(projectId) {
  const pid = H.requirePid(projectId);
  const proj = readProject(pid);
  if (!proj.plugin || proj.plugin.kind !== 'catalog') {
    throw new Error(`项目 ${pid} 的 kind 是 ${(proj.plugin || {}).kind || '?'}，不是家具包（catalog）。`
      + '家具专用工具只服务 kind: catalog 的项目；插件项目请用 studio_get_project / studio_write_code 等');
  }
  return { pid, proj };
}

async function typesAndModels(pid) {
  const r = await resolveCatalogTypes(1500);
  const types = r.types.map((t) => t.type);
  const models = listModels(pid);
  return { types, typeDefs: r.types, source: r.source, host: r.host, models };
}

function modelFileInfo(pid, file) {
  const name = String(file || '');
  const abs = path.join(modelsDir(pid), path.basename(name));
  const exists = !!name && fs.existsSync(abs);
  const row = {
    file: name,
    exists,
    url: `/api/projects/${pid}/models/${encodeURIComponent(name)}`,
  };
  if (exists) {
    const st = fs.statSync(abs);
    row.size = st.size;
    row.updatedAt = st.mtime.toISOString();
  }
  return row;
}

/* 只返回清单属性 + 模型「文件」信息（是否存在 / 大小 / 时间 / URL），不解析 GLB 内容 */
function itemOut(pid, it) {
  return { ...it, modelFile: modelFileInfo(pid, it.model) };
}

/* 全量校验：strict=false 时「分类越界 / 模型文件不存在」降级成警告（方便先写配置后传模型） */
function checkItems(items, models, types, strict) {
  const errors = [];
  const warnings = [];
  const modelSet = new Set(models);
  const seen = new Set();
  items.forEach((it, i) => {
    const label = `第 ${i + 1} 件「${it.id || '(无 id)'}」`;
    if (!ITEM_ID_RE.test(String(it.id || ''))) errors.push(`${label} id 不合法（字母数字开头，仅字母数字/_ . -，≤64）`);
    else if (seen.has(it.id)) errors.push(`${label} id 与前面的重复：${it.id}`);
    else seen.add(it.id);
    if (!String(it.name || '').trim()) errors.push(`${label} 缺少名称`);
    if (!(Number(it.w) > 0) || !(Number(it.d) > 0)) errors.push(`${label} 宽 / 深必须大于 0（当前 ${it.w} / ${it.d}）`);
    if (!(Number(it.h) > 0)) errors.push(`${label} 高必须大于 0`);
    if (types.indexOf(String(it.type)) < 0) {
      (strict ? errors : warnings).push(`${label} 分类「${it.type}」不在枚举内（可用：${types.join(', ')}）`);
    }
    if (!String(it.model || '').trim()) errors.push(`${label} 没有指定模型文件`);
    else if (!modelSet.has(it.model)) {
      (strict ? errors : warnings).push(`${label} 模型文件不存在：${it.model}（现有：${models.join(', ') || '无'}）`);
    }
  });
  const used = new Set(items.map((it) => it.model).filter(Boolean));
  const unused = models.filter((m) => !used.has(m));
  if (unused.length) warnings.push(`有 ${unused.length} 个模型没被任何家具引用：${unused.join('、')}`);
  return { errors, warnings, unused };
}

/* 检查数值类字段（itemDef 会把非法值悄悄换成默认值，这里提前挡掉，避免静默出错） */
function checkNumeric(raw, label) {
  if (!raw || typeof raw !== 'object') return [];
  const out = [];
  ['w', 'd', 'h', 'scale'].forEach((k) => {
    if (raw[k] === undefined || raw[k] === null || raw[k] === '') return;
    const n = Number(raw[k]);
    if (!isFinite(n)) out.push(`${label} 的 ${k} 不是数值：${JSON.stringify(raw[k])}`);
    else if (k !== 'scale' && n <= 0) out.push(`${label} 的 ${k} 必须大于 0：${n}`);
    else if (k === 'scale' && n <= 0) out.push(`${label} 的 scale 必须大于 0：${n}`);
  });
  return out;
}

function saveAndNotify(pid, proj, files) {
  writeProject(pid, proj);
  const notified = hub.notify(pid, {
    type: 'refresh', what: 'catalog', files: files || [], bump: !!(files && files.length),
  });
  return notified;
}

function prettyName(file) {
  const base = String(file || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : '未命名家具';
}

/* 与前端 CatalogEditor.safeGlbName 同口径的 ASCII 化。
 * 家具包里同名模型**直接覆盖**，不生成 _2 后缀：同一个名字就是同一个模型，
 * 重传即更新（见 upload 工具里「找已有条目」的逻辑）。 */
function asciiGlbName(name) {
  const base = String(name || '').replace(/\.glb$/i, '');
  let s = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[^A-Za-z0-9]+/, '').slice(0, 40);
  if (!s) s = 'model_' + Date.now().toString(36);
  return s + '.glb';
}

function packageOut(pid, proj, typeDefs, source) {
  return {
    projectId: pid,
    packId: proj.id,
    projectName: proj.name || '',
    version: (proj.plugin || {}).version || '',
    description: (proj.plugin || {}).description || '',
    types: typeDefs,
    typesSource: source,
  };
}

function manifestOf(proj) {
  try { return buildCatalogManifest(proj, false); }
  catch (e) { return { error: e.message }; }
}

/* ---------------- 工具注册 ---------------- */

function register(server) {
  /* 1. 列出当前页全部家具（纯读，不落盘） ----------------------------- */
  server.tool(
    'studio_list_catalog_items',
    '列出家具包编辑页左侧「家具清单」的全部条目（一件家具一条），**返回值就是一个数组，没有其它顶层字段**。'
    + '数组每项 = 该家具的全量属性（id/name/type/w/d/h/color/model…）+ modelFile（对应 glb 是否存在/大小/时间/URL）——'
    + '「家具 + 它的 glb 文件信息」都在这一条里，不再另返 models / 分类枚举 / 校验 / manifest 预览。'
    + '要分类用 studio_get_catalog_types、要看 models/ 目录全量文件用 studio_list_models（含未被任何家具引用的孤儿模型）、'
    + '校验结果由写操作（set_catalog_item / upload_catalog_model）返回。'
    + '本工具是纯列举：不写任何文件、不下载模型。每项的 modelFile.url 是完整路径，拼上 MCP 服务器地址即可下载；'
    + '想解析模型内容就下载到本机，用 Python 或 Node.js 直接读（GLB = 12 字节头 + JSON chunk + BIN chunk，读 accessors 即可），'
    + '零依赖即可，不要引入 three.js 等第三方库。'
    + '服务端不解析 GLB 内容（顶点/节点/尺寸/材质明细一律不返回）',
    {
      projectId: z.string().optional().describe('项目 id；省略时自动使用唯一已打开的项目'),
    },
    async ({ projectId }) => {
      try {
        const { pid, proj } = requireCatalog(projectId);
        const items = (proj.catalog && Array.isArray(proj.catalog.items)) ? proj.catalog.items : [];
        return H.text(items.map((it) => itemOut(pid, it)));
      } catch (e) { return H.fail(e.message); }
    },
  );

  /* 2. 单件详情 ------------------------------------------------------ */
  server.tool(
    'studio_get_catalog_item',
    '读取一件家具的详细信息：右侧面板的全量属性配置（名称/分类/宽深高/兜底色/模型文件/图标/缩放/id）、'
    + '模型文件基本信息（是否存在/大小/时间/url）、分类枚举与校验结果。'
    + '**model.url 是完整路径**（如 /api/projects/<id>/models/xxx.glb）——'
    + '拼上你连接的 MCP 服务器地址即可直接下载这个 glb，不必再调一次 studio_get_model；'
    + 'model.url 不含 http:// 主机与端口，MCP 不写本机文件。'
    + '注意：item.model 只是纯文件名，别把 model.url 回填进 item.model（前端会按文件名拼地址，写成 URL 会 404）。'
    + '本工具是纯读：不写文件、不下载模型。服务端不解析 GLB 内容——想拿节点树/顶点/包围盒 w·d·h/材质贴图，'
    + '按 model.url 下载到本机，用 Python 或 Node.js 自己解析（读 12 字节头 + JSON chunk + BIN chunk 里的 accessors，'
    + '零依赖即可，不要引入 three.js 等第三方库）；量出的尺寸用 studio_set_catalog_item 写回 w/d/h，'
    + '或让用户在编辑页点「按模型实测」（前端本地算）',
    {
      projectId: z.string().optional().describe('项目 id；省略时自动使用唯一已打开的项目'),
      itemId: z.string().describe('条目 id（见 studio_list_catalog_items 返回的数组元素的 id）'),
    },
    async ({ projectId, itemId }) => {
      try {
        const { pid, proj } = requireCatalog(projectId);
        const { types, typeDefs, source, models } = await typesAndModels(pid);
        const items = (proj.catalog && Array.isArray(proj.catalog.items)) ? proj.catalog.items : [];
        const it = items.find((x) => x && x.id === itemId);
        if (!it) {
          throw new Error(`找不到条目「${itemId}」。现有 ${items.length} 件：${items.map((x) => x.id).join(', ') || '（空清单）'}`
            + '（可用 studio_list_catalog_items 查全部）');
        }
        const info = modelFileInfo(pid, it.model);
        const row = {
          ok: true,
          ...packageOut(pid, proj, typeDefs, source),
          itemId: it.id,
          publishedId: `${pid}:${it.id}`,
          item: { ...it },
          fields: ITEM_FIELDS.map(([key, desc]) => ({ key, value: it[key] === undefined ? null : it[key], desc })),
          model: info,
          validation: checkItems([it], models, types, true),
        };

        if (info.exists) {
          row.hint = `服务端不解析 GLB 内容：model.url 是完整路径（${info.url}），拼上 MCP 服务器地址下载到本机，`
            + '用 Python 或 Node.js 自己读节点树/顶点/包围盒/材质明细（零依赖即可，不要引入 three.js 等第三方库）；'
            + '量出的 w/d/h 可用 studio_set_catalog_item 写回';
        } else {
          row.warning = `模型文件「${it.model}」不在项目里：预览会加载失败，导出家具包也会被拦下`;
          row.hint = 'model.url 是按 item.model 文件名拼出的路径，文件不存在时下载会 404；请先用 studio_upload_catalog_model 上传模型';
        }
        return H.text(row);
      } catch (e) { return H.fail(e.message); }
    },
  );

  /* 3. 全量属性覆盖 -------------------------------------------------- */
  server.tool(
    'studio_set_catalog_item',
    '全量覆盖家具属性配置（对应编辑页右侧面板）。两种模式二选一：'
    + '① 传 itemId + item → 这一件整条替换（默认 merge=false：item 里没给的字段回到默认值 / 被丢弃，id 不传则沿用 itemId）；'
    + '② 传 items 数组 → 整张清单替换（没列出来的家具就是删掉了）。'
    + 'merge=true 才是增量合并（只改给出的字段）。校验：id 合法且唯一、name 非空、w/d/h>0、分类命中枚举、模型文件存在；'
    + 'strict=false 时分类/模型不存在只警告。可选 meta 覆盖包级名称/版本/说明。'
    + '写完落盘并通知编辑页刷新；返回 before/after、diff、校验结果与 item.json 预览',
    {
      projectId: z.string().optional().describe('项目 id；省略时自动使用唯一已打开的项目'),
      itemId: z.string().optional().describe('要覆盖的条目 id（单件模式必填）'),
      item: itemShape.optional().describe('单件模式的最终版完整属性（全量覆盖，未给字段回默认值）'),
      items: z.array(itemShape).optional().describe('整张清单模式的最终版条目数组（全量替换）'),
      merge: z.boolean().optional().describe('默认 false = 全量覆盖；true = 在当前条目基础上只合并给出的字段'),
      strict: z.boolean().optional().describe('默认 true：分类越界 / 模型不存在直接拒绝；false 降级为警告'),
      meta: z.object({
        name: z.string().optional().describe('家具包名称（也写进 item.json 的 name）'),
        version: z.string().optional().describe('版本号，如 1.0.2'),
        description: z.string().optional().describe('包说明'),
      }).optional().describe('包级属性覆盖（可选）'),
    },
    async ({ projectId, itemId, item, items, merge, strict, meta }) => {
      try {
        const { pid, proj } = requireCatalog(projectId);
        const { types, typeDefs, source, models } = await typesAndModels(pid);
        const before = (proj.catalog && Array.isArray(proj.catalog.items)) ? proj.catalog.items : [];
        const wholeList = Array.isArray(items);
        if (!wholeList && !item) return H.fail('请传 item（单件全量覆盖）或 items（整张清单覆盖）');
        if (!wholeList && !itemId) return H.fail('单件模式必须传 itemId（整张清单模式传 items）');

        /* 数值字段提前校验：itemDef 会把非法值换成默认值，不能让它静默通过 */
        const numericErrors = wholeList
          ? items.flatMap((raw, i) => checkNumeric(raw, `items[${i}]`))
          : checkNumeric(item, 'item');
        if (numericErrors.length) return H.fail(numericErrors.join('；'));

        let after;
        let beforeItem = null;
        let afterItem = null;
        if (wholeList) {
          after = items.map((raw) => itemDef(raw));
        } else {
          const idx = before.findIndex((x) => x && x.id === itemId);
          if (idx < 0) {
            return H.fail(`找不到条目「${itemId}」。现有 ${before.length} 件：${before.map((x) => x.id).join(', ') || '（空清单）'}`);
          }
          beforeItem = { ...before[idx] };
          const merged = merge ? { ...before[idx], ...item } : item;
          /* 全量覆盖时 id 允许省略（沿用 itemId），其余字段一律以传入的为准 */
          const raw = { ...merged, id: (merged && merged.id) || itemId };
          afterItem = itemDef(raw);
          after = before.map((x, i) => (i === idx ? afterItem : x));
        }

        const check = checkItems(after, models, types, strict !== false);
        if (check.errors.length) {
          return H.fail('属性校验没过，未写入：\n- ' + check.errors.join('\n- ')
            + '\n（可用 studio_get_catalog_types 查分类、studio_upload_catalog_model 补模型）');
        }

        proj.catalog ||= {};
        proj.catalog.items = after;
        if (meta) {
          if (typeof meta.name === 'string' && meta.name.trim()) {
            proj.name = meta.name.trim().slice(0, 60);
            if (proj.plugin) proj.plugin.name = proj.name;
          }
          if (typeof meta.version === 'string' && meta.version.trim()) proj.plugin.version = meta.version.trim();
          if (typeof meta.description === 'string') proj.plugin.description = meta.description;
        }
        const notified = saveAndNotify(pid, proj, []);
        const issues = validateCatalog(proj, models, types);
        return H.text({
          ok: true,
          ...packageOut(pid, proj, typeDefs, source),
          mode: wholeList ? 'whole-list' : (merge ? 'merge' : 'full-overwrite'),
          count: after.length,
          ...(beforeItem ? { before: beforeItem, after: afterItem } : {}),
          diff: {
            beforeCount: before.length,
            afterCount: after.length,
            added: after.filter((x) => !before.some((b) => b.id === x.id)).map((x) => x.id),
            removed: before.filter((b) => !after.some((x) => x.id === b.id)).map((x) => x.id),
            changed: after.filter((x) => {
              const b = before.find((y) => y.id === x.id);
              return b && JSON.stringify(b) !== JSON.stringify(x);
            }).map((x) => x.id),
          },
          items: after.map((it) => itemOut(pid, it, false)),
          validation: { errors: check.errors, warnings: check.warnings, issues },
          manifestPreview: manifestOf(proj),
          notified,
          hint: notified
            ? '已落盘并通知编辑页刷新清单（未打开页面也没关系，数据已在 project.json）'
            : '已落盘；当前没有打开的编辑页连接，下次打开项目即可看到新配置',
        });
      } catch (e) { return H.fail(e.message); }
    },
  );

  /* 4. 上传 GLB + 属性配置 ------------------------------------------- */
  server.tool(
    'studio_upload_catalog_model',
    '把本机 GLB 家具模型上传到当前家具包项目（支持一次多个），并同时写好右侧的属性配置。'
    + '单文件用 filePath + item；多文件用 filePaths + items（按顺序一一对应）。'
    + 'item 里没给的属性自动补：名称取文件名、分类 other、颜色 #9aa7b8、w/d/h 默认 0.8×0.8×0.6。'
    + '**服务端不解析 GLB**：真实尺寸请先用 studio_get_model 拿到 url、拼上 MCP 服务器地址把 glb 下载到本机，'
    + '再用 Python 或 Node.js 自己解析包围盒（宽 X / 深 Z / 高 Y，零依赖即可，不要引入 three.js 等第三方库），'
    + '量出来后经 item.w/d/h 传入；也可上传后用 studio_set_catalog_item 补写，'
    + '或让用户在编辑页点「按模型实测」（前端本地算）。'
    + 'model 一律强制为实际落盘的文件名。文件名会 ASCII 化（服务端只收 [A-Za-z0-9._-]）。'
    + '**同一个家具包里同名模型直接覆盖**（不加 _2 后缀）：已有条目引用这个模型就更新那一条而不是新建重复家具；'
    + '同一次批量里出现同名，也视为同一个模型，最后一个文件覆盖前面的。'
    + '返回上传清单、生成/更新的条目、校验结果与 item.json 预览。'
    + 'AI 按描述生成 / 修改好的 glb 也走这里上传：先落成本机 .glb 文件，再传 filePath',
    {
      projectId: z.string().optional().describe('项目 id；省略时自动使用唯一已打开的项目'),
      filePath: z.string().optional().describe('单个本机 GLB 的绝对路径'),
      filePaths: z.array(z.string()).optional().describe('多个本机 GLB 的绝对路径（批量）'),
      name: z.string().optional().describe('落盘文件名（仅单文件有效；省略则按源文件名 ASCII 化）'),
      item: itemShape.optional().describe('单文件的最终版属性配置（全量；没给的字段按规则自动补）'),
      items: z.array(itemShape).optional().describe('批量时逐件的属性配置，顺序对应 filePaths'),
      strict: z.boolean().optional().describe('默认 true：分类越界直接拒绝；false 降级为警告'),
    },
    async ({ projectId, filePath, filePaths, name, item, items, strict }) => {
      try {
        const { pid, proj } = requireCatalog(projectId);
        const sources = Array.isArray(filePaths) && filePaths.length
          ? filePaths
          : (filePath ? [filePath] : []);
        if (!sources.length) return H.fail('请传 filePath（单个）或 filePaths（多个）');
        if (filePaths && filePath) return H.fail('filePath 与 filePaths 只传一个');
        if (name && sources.length > 1) return H.fail('name 只用于单文件上传；多文件请用各自的源文件名');
        if (items && items.length > sources.length) return H.fail('items 条数不能超过上传文件数');

        /* 先把所有源文件读进来 + 验一遍，避免传了一半才发现某个文件坏掉 */
        const staged = sources.map((raw, i) => {
          const abs = path.resolve(String(raw || ''));
          if (!fs.existsSync(abs)) throw new Error(`第 ${i + 1} 个文件不存在：${abs}`);
          if (!fs.statSync(abs).isFile()) throw new Error(`第 ${i + 1} 个不是文件：${abs}`);
          if (path.extname(abs).toLowerCase() !== '.glb') throw new Error(`第 ${i + 1} 个不是 .glb：${abs}`);
          const buf = fs.readFileSync(abs);
          if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) {
            throw new Error(`第 ${i + 1} 个文件不是有效 GLB（magic 不符）：${abs}`);
          }
          const cfg = (i === 0 && sources.length === 1 && item) ? item
            : (Array.isArray(items) ? (items[i] || {}) : {});
          const numericErrors = checkNumeric(cfg, `第 ${i + 1} 件的属性`);
          if (numericErrors.length) throw new Error(numericErrors.join('；'));
          return { abs, buf, cfg, sourceName: path.basename(abs) };
        });

        const { types, typeDefs, source: typeSource } = await typesAndModels(pid);
        const current = (proj.catalog && Array.isArray(proj.catalog.items)) ? proj.catalog.items.slice() : [];
        const dir = modelsDir(pid);
        ensureDir(dir);
        const uploaded = [];
        const touched = [];
        const seenInCall = new Set();

        for (const s of staged) {
          /* 同名直接覆盖：目标名固定，不加 _2 后缀 */
          const target = asciiGlbName(name && sources.length === 1 ? name : s.sourceName);
          if (!safeFile(target) || !/\.glb$/i.test(target)) {
            throw new Error(`落盘文件名不合法：${target}（请用字母数字开头，仅 A-Za-z0-9._-）`);
          }
          const existed = fs.existsSync(path.join(dir, target));
          fs.writeFileSync(path.join(dir, target), s.buf);

          /* 服务端不实测尺寸：w/d/h 由调用方下载 glb 后用 Python / Node.js 解析包围盒传入，没传就用默认值 */
          const defaultSize = { w: 0.8, d: 0.8, h: 0.6 };
          const takenIds = new Set(current.map((x) => x && x.id));
          /* 定位目标条目：同名模型 = 同一件家具。
           * 优先按模型文件找（重传 / 批量里同名都落到这一条），其次按显式 id；
           * 都没有才新建。这样不会出现两条家具共用一个 GLB 的重复数据。 */
          const explicitId = s.cfg.id != null && String(s.cfg.id).trim() ? String(s.cfg.id).trim() : '';
          const byModel = current.find((x) => x && x.model === target);
          const byId = explicitId ? current.find((x) => x && x.id === explicitId) : null;
          const baseItem = byModel || byId;
          const id = baseItem ? baseItem.id : (explicitId || uniqueId(slugOf(target), takenIds));
          const pick = (k, fallback) => (s.cfg[k] != null && String(s.cfg[k]).trim() !== '' ? s.cfg[k] : fallback);
          const raw = {
            id,
            name: pick('name', (baseItem && baseItem.name) || prettyName(s.sourceName)),
            type: String(pick('type', (baseItem && baseItem.type) || 'other')).trim().toLowerCase(),
            w: pick('w', defaultSize.w),
            d: pick('d', defaultSize.d),
            h: pick('h', defaultSize.h),
            color: pick('color', (baseItem && baseItem.color) || '#9aa7b8'),
            model: target,                 // 强制指向本次上传的文件，忽略调用方给的 model
            ...(s.cfg.icon != null && String(s.cfg.icon).trim() ? { icon: String(s.cfg.icon) } : {}),
            ...(s.cfg.scale != null ? { scale: s.cfg.scale } : {}),
          };
          const it = itemDef(raw);
          const idx = current.findIndex((x) => x && x.id === it.id);
          if (idx >= 0) current[idx] = it;
          else current.push(it);

          uploaded.push({
            from: s.abs, file: target, bytes: s.buf.length,
            url: `/api/projects/${pid}/models/${encodeURIComponent(target)}`,
            overwritten: existed || seenInCall.has(target.toLowerCase()),
          });
          seenInCall.add(target.toLowerCase());
          touched.push({
            action: idx >= 0 ? 'updated' : 'created',
            ...(explicitId && explicitId !== id ? { idIgnored: explicitId, reason: '同名模型已有条目，按模型复用条目 id' } : {}),
            item: { ...it },
          });
        }

        const modelsAfter = listModels(pid);
        const check = checkItems(current, modelsAfter, types, strict !== false);
        if (check.errors.length) {
          /* 配置有问题：模型已经落盘了，但清单不写，避免留下半套数据 */
          return H.fail('属性校验没过，模型文件已上传但清单未改动：\n- ' + check.errors.join('\n- ')
            + '\n（修好分类/尺寸后重调一次，或用 studio_set_catalog_item 改）');
        }

        proj.catalog ||= {};
        proj.catalog.items = current;
        const notified = saveAndNotify(pid, proj, uploaded.map((u) => u.file));
        const issues = validateCatalog(proj, modelsAfter, types);
        return H.text({
          ok: true,
          ...packageOut(pid, proj, typeDefs, typeSource),
          uploaded,
          touched,
          count: current.length,
          models: H.modelsOut(pid),
          items: current.map((it) => itemOut(pid, it)),
          validation: { errors: check.errors, warnings: check.warnings, issues },
          manifestPreview: manifestOf(proj),
          notified,
          hint: '模型与属性都已落盘；同名模型直接覆盖（重传即更新原条目，不会多出一件家具），编辑页会自动刷新清单与 3D 预览。'
            + '尺寸是调用方传入或默认值（服务端不实测）：需要真实尺寸就下载 glb 后用 Python / Node.js 自己解析包围盒，'
            + '再用 studio_set_catalog_item 写回；分类可用 studio_get_catalog_types 查',
        });
      } catch (e) { return H.fail(e.message); }
    },
  );

  /* 附 1：分类枚举 --------------------------------------------------- */
  server.tool(
    'studio_get_catalog_types',
    '读取「现在已有的家具类型」——即家具编辑页右侧「分类」下拉里的全部可选项。'
    + '唯一出处是 ha-3d-home 的 assets/catalog.json 的 types（studio 通过 home 的 /api/catalog 取，'
    + 'home 不可达时用本地兜底表），返回 type / 中文名 / 下拉 label。'
    + '若指定了家具包项目，还统计当前清单里每个分类用了几件、哪些分类还没用过。'
    + 'studio_upload_catalog_model / studio_set_catalog_item 的 type 必须命中这里的值',
    { projectId: z.string().optional().describe('家具包项目 id（省略则自动选当前打开的项目；只为查枚举时也可不传）') },
    async ({ projectId }) => {
      try {
        const r = await resolveCatalogTypes(2500);
        let projectIdOut = '';
        let usage = null;
        try {
          const { pid, proj } = requireCatalog(projectId);
          projectIdOut = pid;
          const items = (proj.catalog && Array.isArray(proj.catalog.items)) ? proj.catalog.items : [];
          const counts = {};
          items.forEach((it) => { const k = String(it.type || 'other'); counts[k] = (counts[k] || 0) + 1; });
          usage = {
            projectName: proj.name || '',
            itemCount: items.length,
            usedTypes: Object.keys(counts).sort((a, b) => counts[b] - counts[a])
              .map((t) => ({ type: t, count: counts[t], known: r.types.some((x) => x.type === t) })),
            unusedTypes: r.types.filter((t) => !counts[t.type]).map((t) => t.type),
            unknownTypes: Object.keys(counts).filter((t) => !r.types.some((x) => x.type === t)),
          };
        } catch (e) { /* 没打开家具项目 / 不是 catalog 项目：只返回枚举本身 */ }
        const dropdown = r.types.map((t) => ({
          type: t.type, name: t.name, label: `${t.name}（${t.type}）`,
          ...(usage ? { count: usage.usedTypes.find((u) => u.type === t.type)?.count || 0 } : {}),
        }));
        return H.text({
          ok: true,
          source: r.source,
          host: r.host,
          ...(r.error ? { warn: r.error } : {}),
          projectId: projectIdOut,
          count: r.types.length,
          types: r.types,
          dropdown,
          ...(usage ? { usage } : {}),
          fallback: fallbackTypes(),
          hint: r.source === 'home'
            ? '来自 ha-3d-home：与 home 家具库页签、编辑页分类下拉完全一致'
            : 'home 暂不可达，用本地兜底表；两边仍一致（兜底表就是 home 的默认值）',
        });
      } catch (e) { return H.fail(e.message); }
    },
  );

  /* 附 2：删除家具（条目 + 模型文件 + 清单同步） ------------------------ */
  server.tool(
    'studio_delete_catalog_items',
    '家具包专用：按条目 id 批量删除家具（itemIds 数组）。**一次把三件事做完**——'
    + '① 从 project.json 的 catalog.items 移除这些条目并落盘；'
    + '② 默认连它们引用的 .glb 一起从 models/ 删掉（deleteModel:false 可只删条目、保留模型）；'
    + '③ 通知家具编辑页刷新清单与模型缓存。'
    + '「还有别的家具在用同一个模型」时不会删那个文件（避免弄坏其它条目），会在 keptModels 里说明。'
    + '插件项目请用 studio_delete_models（只删文件、报代码引用）。'
    + 'dryRun=true 只返回删除计划、不删文件也不改配置。'
    + '删一件也用本工具：itemIds 传单个 id 即可；deleteModel:false 就是「只从清单移除、保留模型」，deleteModel:true（默认）才连 .glb 一起删',
    {
      projectId: z.string().optional().describe('项目 id；省略时自动使用唯一已打开的项目'),
      itemIds: z.array(z.string()).describe('要删除的家具条目 id 数组（见 studio_list_catalog_items 返回的数组元素的 id）'),
      deleteModel: z.boolean().optional().describe('默认 true：连模型文件一起删；false = 只删条目、保留 .glb'),
      dryRun: z.boolean().optional().describe('默认 false；true 只返回计划，不落盘'),
    },
    async ({ projectId, itemIds, deleteModel, dryRun }) => {
      try {
        const { pid, proj } = requireCatalog(projectId);
        const items = (proj.catalog && Array.isArray(proj.catalog.items)) ? proj.catalog.items : [];
        const ids = [...new Set((Array.isArray(itemIds) ? itemIds : []).map((x) => String(x || '')).filter(Boolean))];
        if (!ids.length) return H.fail('itemIds 不能为空：传要删除的家具条目 id 数组');

        const removed = [];
        const missing = [];
        for (const id of ids) {
          const it = items.find((x) => x && x.id === id);
          if (it) removed.push({ ...it }); else missing.push(id);
        }
        if (!removed.length) {
          return H.fail(`找不到任何条目：${missing.join(', ')}。现有：${items.map((x) => x.id).join(', ') || '（空清单）'}`);
        }
        const remaining = items.filter((x) => !(x && ids.includes(x.id)));

        /* 只删「已无其它条目引用」的模型；同名模型被多件家具共用时保留文件 */
        const wantModel = deleteModel !== false;
        const names = [...new Set(removed.map((x) => path.basename(String(x.model || ''))).filter(Boolean))];
        const modelPlan = names.map((file) => {
          const abs = path.join(modelsDir(pid), file);
          const exists = fs.existsSync(abs);
          const usedBy = remaining.filter((x) => x && path.basename(String(x.model || '')) === file).map((x) => x.id);
          return {
            file, exists, usedBy,
            willDelete: wantModel && exists && usedBy.length === 0,
            reason: !wantModel ? 'deleteModel=false' : !exists ? '文件不存在' : usedBy.length ? `仍被 ${usedBy.join(', ')} 引用` : '',
          };
        });

        if (dryRun) {
          return H.text({
            ok: true, dryRun: true, projectId: pid,
            removed, missing, modelPlan,
            remainingItemCount: remaining.length,
            hint: '这是预演：没有删任何文件、也没有改 project.json；去掉 dryRun 才会真正执行',
          });
        }

        const deletedModels = [];
        for (const m of modelPlan) {
          if (!m.willDelete) continue;
          fs.unlinkSync(path.join(modelsDir(pid), m.file));
          deletedModels.push(m.file);
        }
        proj.catalog ||= {};
        proj.catalog.items = remaining;
        const notified = saveAndNotify(pid, proj, deletedModels);
        return H.text({
          ok: true, projectId: pid,
          removed, missing, deletedModels,
          keptModels: modelPlan.filter((m) => !m.willDelete),
          count: remaining.length,
          items: remaining.map((it) => itemOut(pid, it)),
          notified,
          hint: deletedModels.length
            ? '条目、模型文件与 project.json 清单已同步更新，编辑页会自动刷新'
            : '条目已从清单移除；模型文件按计划保留（见 keptModels）',
        });
      } catch (e) { return H.fail(e.message); }
    },
  );

  /* 附 3：导出家具包 ------------------------------------------------- */
  server.tool(
    'studio_export_catalog',
    '把家具包项目导出成 ha-3d-home 能导入的 zip：item.json（kind/id/items 数组）+ 被引用 .glb 平铺在包根。'
    + '返回 zipBase64 + 清单全文 + 打包进去的模型与校验警告；**MCP 不写本机文件**，要落盘请自行把 zipBase64 解码保存。'
    + '不发布、不改版本号；有 error 级问题（空清单/分类越界/模型缺失）时拒绝导出',
    {
      projectId: z.string().optional().describe('项目 id；省略时自动使用唯一已打开的项目'),
      bump: z.boolean().optional().describe('导出清单里的版本号 +1（只影响本次导出，不写回项目）'),
    },
    async ({ projectId, bump }) => {
      try {
        const { pid } = requireCatalog(projectId);
        const { types } = await typesAndModels(pid);
        const { manifest, buf, copied, warnings } = await prepareCatalogExport(pid, { bump: !!bump, types });
        return H.text({
          ok: true, projectId: pid, bytes: buf.length, fileName: `${pid}-catalog.zip`,
          zipBase64: buf.toString('base64'),
          manifest, copied, warnings,
          hint: 'zip 里 item.json 与各 .glb 平铺；把 zipBase64 解码保存成 .zip 后，可直接在 home 右上角「导入插件/包」上传，或用 studio_publish_catalog 远程发布',
        });
      } catch (e) { return H.fail(e.message); }
    },
  );

  /* 附 4：发布到 ha-3d-home ------------------------------------------ */
  server.tool(
    'studio_publish_catalog',
    '发布家具包到 ha-3d-home：打包 item.json + glb → POST 远程安装接口 → home 按 kind 分流装到 custom/models/<项目id>/，'
    + '成功后版本号写回项目。等价于家具编辑页的「发布到 ha-3d-home」按钮',
    {
      projectId: z.string().optional().describe('项目 id；省略时自动使用唯一已打开的项目'),
      bump: z.boolean().optional().describe('发布前版本号 +1（建议 true）'),
    },
    async ({ projectId, bump }) => {
      try {
        const { pid } = requireCatalog(projectId);
        const { manifest, copied, remote } = await publishCatalog(pid, !!bump);
        const notified = hub.notify(pid, { type: 'refresh', what: 'catalog' });
        return H.text({
          ok: true, projectId: pid, host: remote.host,
          version: manifest.version, count: manifest.items.length, copied,
          installPath: `custom/models/${manifest.id}/`, notified,
          hint: `已发布 ${manifest.items.length} 件家具到 ${remote.host}；home 家具库里条目 id 形如 ${manifest.id}:<条目id>`,
        });
      } catch (e) { return H.fail(e.message); }
    },
  );

  /* 附 5：点击左侧清单（UI 中继，不落盘） --------------------------------
   * 选中只是 UI 状态，不该走 saveAndNotify 的「数据变更」广播；
   * 借 ws-hub 的请求/响应中继，交给 CatalogEditor 注册的预览门面执行。
   * 与 studio_view / studio_screenshot 共用同一个 selectItem 门面方法。 */
  server.tool(
    'studio_select_catalog_item',
    '**切换当前预览的家具**：选中家具编辑页左侧清单的某一条，把它的 GLB 加载进中间 3D 预览（等价于在页面上点击该清单项）。'
    + '清单里有多件家具时用它指定「现在预览哪一件」。'
    + '会等模型真正加载完成才返回，返回当前条目 id / 名称 / 模型文件、实测包围盒尺寸与相机状态；'
    + '之后可用 studio_view 摆机位、studio_screenshot 截图，或直接在后两者里带 itemId 一步完成。'
    + '只改页面 UI 状态，不写 project.json（想改属性用 studio_set_catalog_item）',
    {
      projectId: z.string().optional(),
      itemId: z.string().describe('条目 id（见 studio_list_catalog_items 返回的数组元素的 id）'),
    },
    async ({ projectId, itemId }) => {
      try {
        const { pid } = requireCatalog(projectId);
        return H.text(await hub.call(pid, 'catalog_select', { itemId }, 60000));
      } catch (e) { return H.fail(e.message); }
    },
  );

  /* 附 6：从服务器重新加载清单 ---------------------------------------- */
  server.tool(
    'studio_refresh_catalog',
    '让家具包编辑页重新从服务器加载家具清单：重拉 project.json 覆盖浏览器内存里的 items[]，'
    + '取消挂着的防抖保存、刷新模型列表并重载 3D 预览。'
    + '用于手工改过服务端数据、想丢弃页面未保存的改动、或怀疑页面清单与磁盘不一致时。'
    + '不修改服务器数据；与写操作后的自动刷新共用前端同一段逻辑，返回刷新后的清单条数与服务端磁盘清单',
    { projectId: z.string().optional() },
    async ({ projectId }) => {
      try {
        const { pid, proj } = requireCatalog(projectId);
        const diskItems = (proj.catalog && Array.isArray(proj.catalog.items)) ? proj.catalog.items : [];
        let front = null;
        let warning = '';
        try {
          front = await hub.call(pid, 'catalog_refresh', {}, 30000);
        } catch (e) {
          /* 没有前端在线也要给出服务端真身，不把工具变成纯报错 */
          warning = `前端未刷新：${e.message}（服务端清单未改动，页面打开 / 连上后会自动加载最新数据）`;
          hub.notify(pid, { type: 'refresh', what: 'catalog' });
        }
        return H.text({
          ok: true, projectId: pid,
          diskItemCount: diskItems.length,
          diskItems,
          frontend: front || null,
          ...(warning ? { warning } : {}),
          hint: front
            ? '已重新从服务器加载清单并覆盖页面内存；3D 预览与模型列表已同步刷新'
            : '服务端清单已读取；打开家具编辑页后即为最新数据',
        });
      } catch (e) { return H.fail(e.message); }
    },
  );

  /* 附 7：当前预览的是哪件 -------------------------------------------- */
  server.tool(
    'studio_get_catalog_selection',
    '查询家具编辑页「当前正在预览的是哪件模型」：返回当前选中条目的 id / 名称 / 模型文件名 / 实测尺寸 / 相机状态，'
    + '以及服务端 project.json 里这一条的完整属性（分类 / 宽深高 / 兜底色 / 缩放）与整张清单概览。'
    + '多轮对话里先调它定位目标，再调 studio_set_catalog_item（单件模式）/ studio_view / studio_screenshot 时带上 itemId，避免改错件。'
    + '纯查询、不修改任何数据；需要家具编辑页在线',
    { projectId: z.string().optional() },
    async ({ projectId }) => {
      try {
        const { pid, proj } = requireCatalog(projectId);
        let front = null;
        let warning = '';
        try {
          front = await hub.call(pid, 'catalog_current', {}, 15000);
        } catch (e) {
          warning = `读不到前端预览状态：${e.message}（服务端清单仍可读，打开家具编辑页后即可知道当前预览件）`;
        }
        const items = (proj.catalog && Array.isArray(proj.catalog.items)) ? proj.catalog.items : [];
        const itemId = String((front && front.itemId) || '');
        const diskItem = items.find((x) => x && x.id === itemId) || null;
        return H.text({
          ok: true, projectId: pid,
          selectedItemId: itemId,
          selectedName: (front && front.label) || '',
          selectedModel: (front && front.modelFile) || '',
          preview: front,
          item: diskItem,
          diskItemCount: items.length,
          items: items.map((x) => ({ id: x.id, name: x.name || x.id, type: x.type, model: x.model })),
          ...(warning ? { warning } : {}),
          hint: itemId
            ? `当前预览「${itemId}」；要改它就在后续工具里带 itemId: "${itemId}"`
            : (warning ? warning : '当前没有选中任何家具（清单可能是空的）；可用 studio_select_catalog_item 选中一件'),
        });
      } catch (e) { return H.fail(e.message); }
    },
  );
}

module.exports = { register };
