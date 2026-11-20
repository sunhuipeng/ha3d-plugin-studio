/* options schema 的控件类型（唯一白名单 + 归一化规则；
 * ⚠ 与 server/option-schema.js 同口径双实现，改白名单或规则必须两处同步）
 *
 * 只认 5 种：
 *   range    滑块 + 数字框（要 min / max / step）
 *   number   数字框（可选 step）
 *   select   下拉（配 choices: [{ value, label }]，value 是实际存的值）
 *   checkbox 复选框（tip 作为勾选框右侧文字）
 *   text     文本框
 *
 * 「类型 → 字段」对照表（唯一一份，UI 显隐 / 数据清理 / diff 对比都读它）：
 *   某类型的 option 只允许拥有表里列出的键，其余的一律视为脏数据
 *   （存档残留、切类型忘了清、乱填的值），归一化时剔除、对比时忽略。
 *   def / label / tip / key 是所有类型共有的，不在表内。
 *
 * 归一化口径（与 ha-3d-home 的 PluginEngine 完全一致）：
 *   · 没写 type、或写了不认识的值 → 'text'（渲染层不再靠 v-else 猜）
 *   · 历史写法 'bool' → 'checkbox'（老项目配置继续可用，不必手改数据）
 *
 * 调用点：store.normalize() 在项目打开时统一跑一遍，之后面板 / 预览 / 导出拿到的
 * type 一定是这 5 个之一；其它地方如果直接吃到外部数据，也可以再调一次 normalizeOptions。
 */

export const OPTION_TYPE_VALUES = ['range', 'number', 'select', 'checkbox', 'text'];

/** 类型特有字段对照表：type → 它独有的键（共有键 key/label/def/tip 不在表内） */
export const OPTION_TYPE_FIELDS = {
  range: ['min', 'max', 'step'],
  number: ['step'],
  select: ['choices'],
  checkbox: [],
  text: [],
};

/** 所有「类型特有」键的全集（归一化/清理时按此遍历） */
export const OPTION_TYPE_ONLY_KEYS = ['min', 'max', 'step', 'choices'];

/** 单个 type 值归一化 */
export function normalizeOptionType(type) {
  const raw = String(type == null ? '' : type).toLowerCase();
  if (raw === 'bool') return 'checkbox';
  return OPTION_TYPE_VALUES.includes(raw) ? raw : 'text';
}

/** 该类型是否拥有某字段（面板显隐 / diff 是否比较都读这张表） */
export function optionOwns(type, key) {
  const owned = OPTION_TYPE_FIELDS[normalizeOptionType(type)];
  return !!owned && owned.includes(key);
}

/** 就地删掉 option 上不属于该类型的键（切类型 / 打开项目清脏数据用，返回原对象） */
export function stripExtraOptionKeys(o, type) {
  if (!o || typeof o !== 'object') return o;
  for (const k of OPTION_TYPE_ONLY_KEYS) {
    if (!optionOwns(type, k) && o[k] !== undefined) delete o[k];
  }
  return o;
}

/** 单条 option 归一化（返回新对象；类型合法且没有脏键时原样返回，省一次拷贝） */
export function normalizeOption(o) {
  if (!o || typeof o !== 'object') return o;
  const type = normalizeOptionType(o.type);
  const hasExtra = OPTION_TYPE_ONLY_KEYS.some((k) => o[k] !== undefined && !optionOwns(type, k));
  if (type === o.type && !hasExtra) return o;
  const out = Object.assign({}, o, { type });
  return stripExtraOptionKeys(out, type);
}

/** options 数组归一化 */
export function normalizeOptions(list) {
  return (Array.isArray(list) ? list : []).map(normalizeOption);
}
