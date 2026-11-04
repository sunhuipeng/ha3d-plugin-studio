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
 * 归一化口径（与 ha-3d-home 的 PluginEngine 完全一致）：
 *   · 没写 type、或写了不认识的值 → 'text'（渲染层不再靠 v-else 猜）
 *   · 历史写法 'bool' → 'checkbox'（老项目配置继续可用，不必手改数据）
 *
 * 调用点：store.normalize() 在项目打开时统一跑一遍，之后面板 / 预览 / 导出拿到的
 * type 一定是这 5 个之一；其它地方如果直接吃到外部数据，也可以再调一次 normalizeOptions。
 */

export const OPTION_TYPE_VALUES = ['range', 'number', 'select', 'checkbox', 'text'];

/** 单个 type 值归一化 */
export function normalizeOptionType(type) {
  const raw = String(type == null ? '' : type).toLowerCase();
  if (raw === 'bool') return 'checkbox';
  return OPTION_TYPE_VALUES.includes(raw) ? raw : 'text';
}

/** 单条 option 归一化（返回新对象；类型本来就合法时原样返回，省一次拷贝） */
export function normalizeOption(o) {
  if (!o || typeof o !== 'object') return o;
  const type = normalizeOptionType(o.type);
  return type === o.type ? o : Object.assign({}, o, { type });
}

/** options 数组归一化 */
export function normalizeOptions(list) {
  return (Array.isArray(list) ? list : []).map(normalizeOption);
}
