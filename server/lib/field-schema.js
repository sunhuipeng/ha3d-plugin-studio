/* 字段（fields）值类型的服务端归一化（与 client/src/field-schema.js 同口径；
 * ⚠ 双实现同步：valueType / enumValues 判定规则改动必须两处同步）
 *
 * valueType: 'number' 数值类 | 'text' 字符类 | 'enum' 枚举类
 * enumValues: string[]，仅 enum 有意义
 *
 * 服务端用它做两件事：
 *   1. mcp-tools 输出 fields 前把类型说清楚（AI 读到的永远是 number/text/enum 三者之一）
 *   2. generator 发布校验时提示「枚举类没填枚举值」这类问题
 */

const FIELD_TYPE_VALUES = ['number', 'text', 'enum'];

/* 列表字段归一化：数组原样收，字符串按空白/中英文逗号拆（domains / enumValues 两处共用） */
function splitList(v) {
  return (Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\s,，]+/))
    .map((s) => String(s == null ? '' : s).trim())
    .filter(Boolean);
}

function normalizeFieldType(type) {
  const raw = String(type == null ? '' : type).toLowerCase();
  return FIELD_TYPE_VALUES.includes(raw) ? raw : 'text';
}

function normalizeEnumValues(list) {
  const out = [];
  for (const s of splitList(list)) {
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

module.exports = { FIELD_TYPE_VALUES, splitList, normalizeFieldType, normalizeEnumValues };
