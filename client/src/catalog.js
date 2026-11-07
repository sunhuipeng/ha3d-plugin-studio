/* 家具项目（kind: 'catalog'）前端共用的小工具：分类兜底表 + 条目 id 生成 + 条目默认值。
 * 真实分类枚举以 GET /catalog-types 为准（studio 服务端优先向 ha-3d-home 的
 * /api/catalog 取，它的 types 才是唯一出处）；这里的表只是 home 不可达时的兜底。 */
export const FALLBACK_CATALOG_TYPES = [
  { type: 'sofa', name: '沙发/座椅' },
  { type: 'bed', name: '床品' },
  { type: 'table', name: '桌几' },
  { type: 'cabinet', name: '柜架' },
  { type: 'kitchen', name: '厨餐' },
  { type: 'bath', name: '卫浴' },
  { type: 'deco', name: '装饰' },
  { type: 'other', name: '其他' },
];

/* home 侧条目 id 的字符集：字母/数字开头，字母/数字/_ . -，≤64（冒号是 home 的命名空间分隔符，禁用） */
const ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function slugOf(file) {
  const base = String(file || '').replace(/\.[^.]+$/, '').toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_').replace(/^[^a-z0-9]+/, '').slice(0, 48);
  return base || 'item';
}

export function uniqueItemId(base, taken) {
  let id = ITEM_ID_RE.test(base) ? base : slugOf(base);
  if (!taken.has(id)) return id;
  for (let i = 2; i < 1000; i++) if (!taken.has(id + '_' + i)) return id + '_' + i;
  return id + '_' + Date.now().toString(36);
}

/* 文件名 → 显示名：去掉后缀、下划线/连字符转空格，首字母大写 */
export function prettyName(file) {
  const base = String(file || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : '未命名家具';
}

/* 新条目：尺寸取实测包围盒（米），没有就按 0.8×0.8×0.6 兜底 */
export function newItemFromModel(file, size, taken) {
  const w = size && size.w > 0 ? Math.round(size.w * 100) / 100 : 0.8;
  const d = size && size.d > 0 ? Math.round(size.d * 100) / 100 : 0.8;
  const h = size && size.h > 0 ? Math.round(size.h * 100) / 100 : 0.6;
  return {
    id: uniqueItemId(slugOf(file), taken),
    name: prettyName(file),
    type: 'other',
    w, d, h,
    color: '#9aa7b8',
    model: file,
  };
}

/* 项目里的条目归一（与 server/catalog-schema.js 的 itemDef 同口径，只补不改） */
export function normalizeItem(it) {
  const o = it && typeof it === 'object' ? it : {};
  o.id = String(o.id || '');
  o.name = String(o.name || '');
  o.type = String(o.type || 'other').toLowerCase();
  ['w', 'd', 'h'].forEach((k) => {
    const n = Number(o[k]);
    o[k] = isFinite(n) && n > 0 ? n : (k === 'h' ? 0.6 : 0.8);
  });
  o.color = String(o.color || '#9aa7b8');
  o.model = String(o.model || '');
  return o;
}
