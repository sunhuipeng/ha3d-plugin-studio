/* 静态枚举与纯判定：不依赖 Vue / Pinia，供 stores、引擎和面板共用。
 * 从原 store.js 顶部搬出，保持导出名与取值一字不变。 */

/* 设备类插件（kind:'device'）可选的 type：
 *   DEVICE_TYPES —— HA 实体域（灯/开关/空调…）
 *   WALL_TYPES   —— 贴墙设备：门 / 窗。它们**没有独立的 kind**，就是 type 不同的设备类，
 *                   只是数据放在 home 的 floors.doors/windows 里、默认不显示 3D 标签。
 * OPENING_TYPES 是旧名字（面板与脚本仍在用），等价于 WALL_TYPES。 */
export const DEVICE_TYPES = ['light', 'switch', 'sensor', 'climate', 'water_heater', 'cover', 'fan', 'media_player', 'vacuum', 'camera', 'other'];
export const WALL_TYPES = ['door', 'window'];
export const OPENING_TYPES = WALL_TYPES;
export const MODEL_TYPES = DEVICE_TYPES.concat(WALL_TYPES);
export const isWallType = (t) => t === 'door' || t === 'window';
export const OPTION_TYPES = [
  { value: 'range', label: 'range 滑条' },
  { value: 'number', label: 'number 数字' },
  { value: 'checkbox', label: 'checkbox 复选' },
  { value: 'select', label: 'select 下拉' },
  { value: 'text', label: 'text 文本（缺省）' },
];
/* 字段 domains 多选可用的实体域（HA 常用） */
export const ENTITY_DOMAINS = [
  'sensor', 'binary_sensor', 'switch', 'light', 'climate', 'cover', 'fan',
  'humidifier', 'water_heater', 'lock', 'media_player', 'number', 'select',
  'button', 'vacuum', 'camera',
];
