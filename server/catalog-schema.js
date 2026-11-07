/*
 * 家具项目（kind: "catalog"）的数据形状 + 校验 + 清单构建。
 *
 * 一个家具项目 = 一个「家具包」：项目里导入多个 GLB，每个模型在 catalog.items 里有一条
 * 描述（名称 / 分类 / 尺寸 / 兜底色 / 2D 图标）。导出时按 ha-3d-home 的家具包格式打包：
 *   item.json（kind + id(=项目id) + items 数组）+ 各条引用的 .glb 平铺
 *
 * 只放纯函数（不碰磁盘），便于 config / routes / catalog-pkg 三处共用同一套口径。
 */
'use strict';

/* 家具分类：唯一出处是 ha-3d-home 的 assets/catalog.json 的 types。
 * studio 不能读那个文件，所以这里是一份兜底副本；配置了 home 地址时前端会走
 * GET /api/catalog-types 取 home 的真实枚举覆盖它（见 routes.js / 前端 CatalogEditor）。 */
const FALLBACK_TYPES = ['sofa', 'bed', 'table', 'cabinet', 'kitchen', 'bath', 'deco', 'other'];

/* type 中文说明（前端下拉显示用，与 home 文档里的分类含义一致） */
const TYPE_LABELS = {
  sofa: '沙发/座椅', bed: '床品', table: '桌几', cabinet: '柜架',
  kitchen: '厨餐', bath: '卫浴', deco: '装饰', other: '其他',
};

/* 包内条目 id 的字符集：与 home 的 ITEM_ID_RE 一致（字母/数字开头，字母/数字/_ . -，≤64） */
const ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const DEF_COLOR = '#9aa7b8';

function num(v, def) {
  const n = Number(v);
  return isFinite(n) ? n : def;
}
function str(v) {
  return v == null ? '' : String(v).trim();
}

/* 文件名 → 合法条目 id（小写、非字母数字转下划线、去掉后缀） */
function slugOf(file) {
  return String(file || '')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 48) || 'item';
}
/* 在 taken(Set) 里挑一个不重的 id */
function uniqueId(base, taken) {
  let id = ITEM_ID_RE.test(base) ? base : slugOf(base);
  if (!taken.has(id)) return id;
  for (let i = 2; i < 1000; i++) {
    const next = id + '_' + i;
    if (!taken.has(next)) return next;
  }
  return id + '_' + Date.now().toString(36);
}

/* 单条家具：缺字段给安全默认值（不校验，校验在 validateCatalog） */
function itemDef(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const w = num(r.w, 0.8);
  const d = num(r.d, 0.8);
  const h = num(r.h, 0.6);
  const it = {
    id: str(r.id),
    name: str(r.name),
    type: str(r.type).toLowerCase() || 'other',
    w: w > 0 ? w : 0.8,
    d: d > 0 ? d : 0.8,
    h: h > 0 ? h : 0.6,
    color: str(r.color) || DEF_COLOR,
    model: str(r.model),
  };
  const icon = str(r.icon);
  if (icon) it.icon = icon;
  const scale = num(r.scale, 1);
  if (scale > 0 && scale !== 1) it.scale = scale;
  return it;
}

/* 项目 → 规范化的 catalog（幂等；只在 kind==='catalog' 时调） */
function normalizeCatalog(proj) {
  if (!proj || typeof proj !== 'object') return proj;
  const c = (proj.catalog && typeof proj.catalog === 'object') ? proj.catalog : {};
  c.items = (Array.isArray(c.items) ? c.items : []).filter((x) => x && typeof x === 'object').map(itemDef);
  proj.catalog = c;
  proj.plugin ||= {};
  if (!proj.plugin.version) proj.plugin.version = '1.0.0';
  return proj;
}

/* 新建家具项目的初始结构（id/name 由调用方给） */
function newCatalogProject(id, name) {
  return {
    id,
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    plugin: { id, name, kind: 'catalog', version: '1.0.0', description: '' },
    catalog: { items: [] },
  };
}

/* 校验 → [{ level, msg }]（与 generator.validate 同一形状，前端/接口直接展示） */
function validateCatalog(proj, models, types) {
  const w = [];
  const list = Array.isArray(types) && types.length ? types : FALLBACK_TYPES;
  const items = (proj && proj.catalog && Array.isArray(proj.catalog.items)) ? proj.catalog.items : [];
  const modelSet = new Set(Array.isArray(models) ? models : []);
  if (!str(proj && proj.name)) w.push({ level: 'error', msg: '项目名称不能为空' });
  if (!items.length) w.push({ level: 'error', msg: '还没有家具：先导入 GLB 模型' });

  const seen = new Set();
  items.forEach((it, i) => {
    const label = '第 ' + (i + 1) + ' 件' + (it.name ? '「' + it.name + '」' : '');
    if (!ITEM_ID_RE.test(str(it.id))) w.push({ level: 'error', msg: label + '的 id 不合法：' + (it.id || '(空)') });
    else if (seen.has(it.id)) w.push({ level: 'error', msg: label + '的 id 与前面的重复：' + it.id });
    else seen.add(it.id);
    if (!str(it.name)) w.push({ level: 'error', msg: label + '缺少名称' });
    if (list.indexOf(str(it.type)) < 0) w.push({ level: 'error', msg: label + '的分类不在支持列表：' + (it.type || '(空)') });
    if (!(num(it.w, 0) > 0) || !(num(it.d, 0) > 0)) w.push({ level: 'error', msg: label + '的宽 / 深必须大于 0' });
    if (!str(it.model)) w.push({ level: 'error', msg: label + '还没有指定模型文件' });
    else if (!modelSet.has(it.model)) w.push({ level: 'error', msg: label + '的模型文件不存在：' + it.model });
  });

  /* 导入了但没用上的模型：只是提醒，不阻止导出（另一件家具可能马上要用） */
  const used = new Set(items.map((it) => str(it.model)).filter(Boolean));
  const unused = Array.from(modelSet).filter((m) => !used.has(m));
  if (unused.length) w.push({ level: 'warn', msg: '有 ' + unused.length + ' 个模型没被任何家具引用：' + unused.join('、') });
  return w;
}

function bumpVersion(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : '1.0.1';
}

/* 项目 → ha-3d-home 的家具包清单（item.json 内容）
 * 只输出被条目引用的模型；顺序与 items 一致。 */
function buildCatalogManifest(proj, bump) {
  const p = proj.plugin || {};
  const version = bump ? bumpVersion(p.version) : String(p.version || '1.0.0');
  const items = ((proj.catalog && proj.catalog.items) || []).map((it) => {
    const out = {
      id: it.id, name: it.name, type: it.type,
      w: it.w, d: it.d, h: it.h, color: it.color,
    };
    if (it.icon) out.icon = it.icon;
    if (it.scale) out.scale = it.scale;
    out.model = it.model;
    return out;
  });
  const mf = {
    kind: 'catalog',
    id: proj.id,
    name: proj.name || proj.id,
    version,
    items,
  };
  if (p.description) mf.description = p.description;
  return mf;
}

module.exports = {
  FALLBACK_TYPES, TYPE_LABELS, ITEM_ID_RE, DEF_COLOR,
  slugOf, uniqueId, itemDef, normalizeCatalog, newCatalogProject,
  validateCatalog, bumpVersion, buildCatalogManifest,
};
