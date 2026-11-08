/* 字段属性（attributes）的 YAML 文本
 *
 * 定位：字段（fields）上除了「值类型 valueType / 枚举值 enumValues」之外的第三块元信息，
 * 描述这个实体在 HA 里的 attributes 长什么样（friendly_name / unit_of_measurement /
 * temperature / current_position …）。它不参与任何渲染判定，纯粹是给人（面板）和 AI
 * （MCP studio_get_project）读的说明；预览时顺手当模拟实体的初值，让插件读 attributes
 * 的分支也能跑起来。
 *
 * 存储形态：**原文 YAML 字符串**（不是对象）。理由：
 *   · 保留作者写的顺序、注释、缩进，AI 改完再写回来不会被打乱；
 *   · 解析失败时原文不丢，面板能就地报错让人改；
 *   · 项目 JSON 里手写 / 复制粘贴都直观。
 *
 * 兼容：老数据 / API 传对象时按 JSON 文本收（JSON 是 YAML 1.2 的子集，解析器照样吃）。
 */
import { parseDocument } from 'yaml';

/* YAML 文本归一化：统一换行、去掉行尾空格与首尾空行（其它原样保留） */
export function normalizeAttrsYaml(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    try { return JSON.stringify(v, null, 2); } catch (e) { return ''; }
  }
  return String(v)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/** 解析结果缓存用的键（文本没变就不重复解析） */
const cache = new Map();

/**
 * 解析属性 YAML。
 * @returns {{ok:boolean, value:object, keys:string[], empty:boolean, error:string}}
 *   ok=false 时 value 为空对象，error 带行号（面板直接显示）
 */
export function parseAttrsYaml(text) {
  const src = normalizeAttrsYaml(text);
  if (!src) return { ok: true, value: {}, keys: [], empty: true, error: '' };

  const hit = cache.get(src);
  if (hit) return hit;

  const out = parse(src);
  /* 缓存别无限长：属性文本通常几十行，留最近 200 条就够 */
  if (cache.size > 200) cache.clear();
  cache.set(src, out);
  return out;
}

function parse(src) {
  const doc = parseDocument(src);
  const err = doc.errors && doc.errors[0];
  if (err) {
    const lp = err.linePos && err.linePos[0];
    const at = lp ? `第 ${lp.line} 行第 ${lp.col} 列：` : '';
    return { ok: false, value: {}, keys: [], empty: false, error: at + err.message };
  }
  let value;
  try {
    value = doc.toJS();
  } catch (e) {
    return { ok: false, value: {}, keys: [], empty: false, error: String(e.message || e) };
  }
  if (value == null) return { ok: true, value: {}, keys: [], empty: true, error: '' };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false, value: {}, keys: [], empty: false,
      error: '顶层要写成 key: value 形式（不能是数组或单个值）',
    };
  }
  return { ok: true, value, keys: Object.keys(value), empty: false, error: '' };
}

/** 面板 / 提示词用的一句话摘要：`3 个属性：friendly_name、temperature、hvac_action` */
export function attrsSummary(text) {
  const r = parseAttrsYaml(text);
  if (r.empty) return '';
  if (!r.ok) return '';
  const head = r.keys.slice(0, 4).join('、');
  return `${r.keys.length} 个属性：${head}${r.keys.length > 4 ? ' …' : ''}`;
}
