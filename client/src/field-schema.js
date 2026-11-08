/* 字段（fields）的「值类型」元信息
 * ⚠ 与 server/field-schema.js 同口径双实现，改 valueType / enumValues 规则必须两处同步
 *
 * 这些属性不参与任何渲染 / 状态判定，纯粹是给人（面板、提示词）和 AI（MCP studio_get_project）
 * 读的说明：这个字段绑的实体，值长什么样、可选值有哪些、属性有哪些。
 *
 *   valueType    'number' 数值类 | 'text' 字符类 | 'enum' 枚举类
 *   enumValues   string[]，仅 enum 用（如 ['on', 'off'] / ['heat', 'cool', 'fan_only']）
 *   attributes   string，实体 attributes 的 YAML 原文（如 `temperature: 26`）
 *
 * 归一化口径：
 *   · 没写 / 写了不认识的值 → 'text'（最宽松，不误导）
 *   · enumValues 允许存成 "on,off" 字符串（老数据 / 手改 JSON）→ 拆成数组、去空、去重
 *   · 非 enum 类型的 enumValues 保留但不展示（切回 enum 时值还在，不会白填一遍）
 *   · attributes 统一成 LF 换行、去行尾空格与首尾空行的字符串（对象按 JSON 文本收）
 */
import { normalizeAttrsYaml } from './attrs-yaml';

export const FIELD_TYPE_VALUES = ['number', 'text', 'enum'];

/** 下拉选项（面板用） */
export const FIELD_TYPES = [
  { value: 'number', label: '数值类' },
  { value: 'text', label: '字符类' },
  { value: 'enum', label: '枚举类' },
];

/** 单个 valueType 归一化 */
export function normalizeFieldType(type) {
  const raw = String(type == null ? '' : type).toLowerCase();
  return FIELD_TYPE_VALUES.includes(raw) ? raw : 'text';
}

/** 枚举值数组归一化：接受数组 / 逗号分隔字符串，去空、去重、转字符串 */
export function normalizeEnumValues(list) {
  const arr = Array.isArray(list)
    ? list
    : String(list == null ? '' : list).split(/[\s,，]+/);
  const out = [];
  for (const v of arr) {
    const s = String(v == null ? '' : v).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** 单条字段归一化（原地改，返回同一个对象） */
export function normalizeField(f) {
  if (!f || typeof f !== 'object') return f;
  f.valueType = normalizeFieldType(f.valueType);
  f.enumValues = normalizeEnumValues(f.enumValues);
  f.attributes = normalizeAttrsYaml(f.attributes);
  return f;
}

/** 给界面 / 提示词看的中文类型名 */
export function fieldTypeLabel(type) {
  const hit = FIELD_TYPES.find((t) => t.value === normalizeFieldType(type));
  return hit ? hit.label : '字符类';
}

/* ---------------- 常用枚举值（面板上一键点选，省得手打） ----------------
 * 按实体域分组，取「这个域的状态机最常见的那几个值」；不在表里的域回落到通用组。
 * 只是候选，用户可以照着自己的插件写自己的值，不限制。 */
const COMMON_TAGS_BY_DOMAIN = {
  cover: ['open', 'closed', 'opening', 'closing', 'stopped'],
  climate: ['off', 'heat', 'cool', 'auto', 'dry', 'fan_only'],
  media_player: ['playing', 'paused', 'idle', 'off', 'on'],
  vacuum: ['cleaning', 'docked', 'returning', 'paused', 'error', 'idle'],
  light: ['on', 'off'],
  switch: ['on', 'off'],
  fan: ['on', 'off'],
  binary_sensor: ['on', 'off'],
  lock: ['locked', 'unlocked', 'jammed', 'open'],
  water_heater: ['off', 'eco', 'performance', 'high_demand'],
};
const COMMON_TAGS_FALLBACK = ['on', 'off', 'unknown', 'unavailable', 'idle'];

/** 这个字段适合点选的常用值（按 domains 挑一组，最多 8 个） */
export function suggestEnumTags(f) {
  const f2 = f || {};
  const domains = Array.isArray(f2.domains) ? f2.domains : String(f2.domains || '').split(/[\s,，]+/);
  const picked = [];
  for (const d of domains) {
    const list = COMMON_TAGS_BY_DOMAIN[String(d)];
    if (list) list.forEach((v) => { if (!picked.includes(v)) picked.push(v); });
  }
  if (!picked.length) picked.push(...COMMON_TAGS_FALLBACK);
  /* 常见的两个「兜底状态」任何域都可能出现，补在末尾 */
  for (const v of ['unknown', 'unavailable']) if (!picked.includes(v)) picked.push(v);
  return picked.slice(0, 8);
}
