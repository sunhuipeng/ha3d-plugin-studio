/* options schema 的控件类型（服务端口径，与 client/src/option-schema.js 一致；
 * ⚠ 双实现同步：白名单或归一化规则改动必须两处同步）
 *
 * 只认 5 种：range / number / select / checkbox / text
 *   · 没写 type、或写了不认识的值 → 'text'
 *   · 历史写法 'bool' → 'checkbox'
 *
 * 「类型 → 字段」对照表：某类型 option 只允许拥有表内列出的键
 *   （range → min/max/step；number → step；select → choices；其余无特有键），
 *   与客户端共用同一份口径（UI 显隐 / 数据清理 / diff 忽略都按它走）。
 *
 * 用在两处：MCP 读配置时输出干净的 type（stylesOut）、发布前校验（validate）。
 */
'use strict';

const OPTION_TYPE_VALUES = ['range', 'number', 'select', 'checkbox', 'text'];

const OPTION_TYPE_FIELDS = {
  range: ['min', 'max', 'step'],
  number: ['step'],
  select: ['choices'],
  checkbox: [],
  text: [],
};

const OPTION_TYPE_ONLY_KEYS = ['min', 'max', 'step', 'choices'];

function normalizeOptionType(type) {
  const raw = String(type == null ? '' : type).toLowerCase();
  if (raw === 'bool') return 'checkbox';
  return OPTION_TYPE_VALUES.includes(raw) ? raw : 'text';
}

function optionOwns(type, key) {
  const owned = OPTION_TYPE_FIELDS[normalizeOptionType(type)];
  return !!owned && owned.includes(key);
}

function stripExtraOptionKeys(o, type) {
  if (!o || typeof o !== 'object') return o;
  for (const k of OPTION_TYPE_ONLY_KEYS) {
    if (!optionOwns(type, k) && o[k] !== undefined) delete o[k];
  }
  return o;
}

module.exports = {
  OPTION_TYPE_VALUES,
  OPTION_TYPE_FIELDS,
  OPTION_TYPE_ONLY_KEYS,
  normalizeOptionType,
  optionOwns,
  stripExtraOptionKeys,
};
