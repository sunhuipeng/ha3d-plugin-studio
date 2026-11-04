/* options schema 的控件类型（服务端口径，与 client/src/option-schema.js 一致；
 * ⚠ 双实现同步：白名单或归一化规则改动必须两处同步）
 *
 * 只认 5 种：range / number / select / checkbox / text
 *   · 没写 type、或写了不认识的值 → 'text'
 *   · 历史写法 'bool' → 'checkbox'
 *
 * 用在两处：MCP 读配置时输出干净的 type（stylesOut）、发布前校验（validate）。
 */
'use strict';

const OPTION_TYPE_VALUES = ['range', 'number', 'select', 'checkbox', 'text'];

function normalizeOptionType(type) {
  const raw = String(type == null ? '' : type).toLowerCase();
  if (raw === 'bool') return 'checkbox';
  return OPTION_TYPE_VALUES.includes(raw) ? raw : 'text';
}

module.exports = { OPTION_TYPE_VALUES, normalizeOptionType };
