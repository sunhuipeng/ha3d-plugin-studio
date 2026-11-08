/* 配置漂移对比（客户端）：当前引擎内存的 styles/fields vs 代码加载时的基线
 * （基线在 engine/project-config.js 的 applyProjectConfig 里、合并项目 JSON 前深拷贝，挂在 def._baseline）。
 *
 * 口径（与旧 server/config-snapshot.js 的 styles/fields 部分一致，该模块已删除）：
 *   · styles 按 id 匹配、options 按 key 匹配（顺序无关），另外单独比默认造型（首个样式）与共有样式顺序
 *   · fields 按 key 匹配；domains / enumValues 排序后再比（集合语义，顺序不算改动）
 *   · 数值统一转数字比，def 统一转字符串比（"0.3" 与 0.3 视为相同）
 */
import { normalizeOptionType, optionOwns } from './option-schema';
import { normalizeFieldType, normalizeEnumValues } from './field-schema';
import { normalizeAttrsYaml } from './attrs-yaml';

const OPTION_KEYS = ['label', 'type', 'def', 'min', 'max', 'step', 'choices'];
const FIELD_KEYS = ['label', 'domains', 'placeholder', 'tip', 'entityId', 'valueType', 'enumValues', 'attributes'];

/* z / labelOffset 只有设备类插件（含门/窗）的样式才有；背景插件没有离地与标签的概念，
 * 其他类型忽略这两个字段的对比 —— 存档里残留的 z=0 之类不再报假差异。
 * 门的 z 恒 0（面板不给调），窗沿用 z；两者都参与对比，避免「窗抬高」这类改动漏报。 */
function styleKeysFor(pluginKind) {
  return pluginKind === 'device'
    ? ['name', 'desc', 'z', 'labelOffset']
    : ['name', 'desc'];
}

const str = (v) => (v == null ? '' : String(v)).trim();
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const splitList = (v) => (Array.isArray(v) ? v : String(v == null ? '' : v).split(/[\s,，]+/).filter(Boolean));

function stylesNorm(list) {
  return (Array.isArray(list) ? list : []).filter((s) => s && s.id).map((s) => ({
    id: str(s.id),
    name: str(s.name || s.id),
    desc: str(s.desc),
    z: num(s.z),
    labelOffset: str(s.labelOffset),
    icon: str(s.icon),
    options: ((s.options) || []).filter((o) => o && typeof o === 'object').map((o) => {
      const type = normalizeOptionType(o.type);
      return {
        key: str(o.key),
        label: str(o.label || o.key),
        type,
        def: str(o.def),
        /* 类型特有键：按「类型 → 字段」对照表归一 —— 不属于该类型的键（存档残留 /
         * 切类型没清的脏数据）两侧都置空，不产生差异；type 本身的变更照常报 */
        min: optionOwns(type, 'min') ? num(o.min) : null,
        max: optionOwns(type, 'max') ? num(o.max) : null,
        step: optionOwns(type, 'step') ? num(o.step) : null,
        choices: optionOwns(type, 'choices') ? (Array.isArray(o.choices) ? o.choices.map(str) : []) : [],
      };
    }),
  }));
}

function fieldsNorm(list) {
  return (Array.isArray(list) ? list : []).filter((f) => f && f.key).map((f) => {
    const valueType = normalizeFieldType(f.valueType);
    return {
      key: str(f.key),
      label: str(f.label || f.key),
      domains: splitList(f.domains).map(str).sort(),
      placeholder: str(f.placeholder),
      tip: str(f.tip),
      entityId: str(f.entityId),
      valueType,
      /* 非枚举类不比较枚举值（面板里会把它们当无用残留） */
      enumValues: valueType === 'enum' ? normalizeEnumValues(f.enumValues).sort() : [],
      /* 字段属性是 YAML 原文：只按归一化后的文本比（换行 / 行尾空格不算改动） */
      attributes: normalizeAttrsYaml(f.attributes),
    };
  });
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* 差异值截断：icon 那种长 SVG 别把提示撑爆 */
function brief(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.length > 120 ? v.slice(0, 117) + '…' : v;
  if (Array.isArray(v)) return v.length > 10 ? v.slice(0, 10).concat(['…']) : v;
  return v;
}

function diffOptions(A, B, out) {
  const ma = new Map(A.options.map((o) => [o.key, o]));
  const mb = new Map(B.options.map((o) => [o.key, o]));
  const keys = [...new Set([...ma.keys(), ...mb.keys()])];
  for (const key of keys) {
    const X = ma.get(key);
    const Y = mb.get(key);
    const target = `样式「${B.name}」`;
    const id = B.id;
    if (!X) {
      out.push({ scope: 'styles', id, target, field: `参数 ${Y.label}(${key})`, from: null, to: '（新增）', kind: 'added' });
      continue;
    }
    if (!Y) {
      out.push({ scope: 'styles', id, target, field: `参数 ${X.label}(${key})`, from: '（原参数）', to: null, kind: 'removed' });
      continue;
    }
    for (const k of OPTION_KEYS) {
      if (!eq(X[k], Y[k])) {
        out.push({ scope: 'styles', id, target, field: `参数 ${Y.label}(${key}).${k}`, from: brief(X[k]), to: brief(Y[k]) });
      }
    }
  }
}

function diffStyles(a, b, out, styleKeys) {
  const ma = new Map(a.map((s) => [s.id, s]));
  const mb = new Map(b.map((s) => [s.id, s]));
  /* 首个样式 = 默认造型：只比首位（新增样式追加到末尾不该被当成「顺序改了」） */
  if (a.length && b.length && a[0].id !== b[0].id) {
    out.push({
      scope: 'styles', target: '默认造型', field: '首个样式',
      from: `${a[0].name}(${a[0].id})`, to: `${b[0].name}(${b[0].id})`, kind: 'order',
    });
  }
  /* 共有样式的相对顺序（拖动排序） */
  const ca = a.map((s) => s.id).filter((id) => mb.has(id));
  const cb = b.map((s) => s.id).filter((id) => ma.has(id));
  if (!eq(ca, cb)) {
    out.push({ scope: 'styles', target: '样式顺序', field: '顺序', from: ca, to: cb, kind: 'order' });
  }
  for (const id of [...new Set([...ma.keys(), ...mb.keys()])]) {
    const X = ma.get(id);
    const Y = mb.get(id);
    if (!X) {
      out.push({ scope: 'styles', id, target: `样式「${Y.name}」`, field: '（整个样式）', from: null, to: '（新增）', kind: 'added' });
      continue;
    }
    if (!Y) {
      out.push({ scope: 'styles', id, target: `样式「${X.name}」`, field: '（整个样式）', from: '（原有样式）', to: null, kind: 'removed' });
      continue;
    }
    for (const k of styleKeys) {
      if (!eq(X[k], Y[k])) {
        out.push({ scope: 'styles', id, target: `样式「${Y.name}」`, field: k, from: brief(X[k]), to: brief(Y[k]) });
      }
    }
    diffOptions(X, Y, out);
  }
}

function diffFields(a, b, out) {
  const ma = new Map(a.map((f) => [f.key, f]));
  const mb = new Map(b.map((f) => [f.key, f]));
  for (const key of [...new Set([...ma.keys(), ...mb.keys()])]) {
    const X = ma.get(key);
    const Y = mb.get(key);
    if (!X) {
      out.push({ scope: 'fields', id: key, target: `字段「${Y.label}」`, field: '（整个字段）', from: null, to: '（新增）', kind: 'added' });
      continue;
    }
    if (!Y) {
      out.push({ scope: 'fields', id: key, target: `字段「${X.label}」`, field: '（整个字段）', from: '（原字段）', to: null, kind: 'removed' });
      continue;
    }
    for (const k of FIELD_KEYS) {
      if (!eq(X[k], Y[k])) {
        out.push({ scope: 'fields', id: key, target: `字段「${Y.label}」`, field: k, from: brief(X[k]), to: brief(Y[k]) });
      }
    }
  }
}

function fmtVal(v) {
  if (v == null) return '空';
  if (Array.isArray(v)) return v.length ? v.join('、') : '空';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/* 一行一条人话，给 UI 弹窗直接用 */
const WHOLE = ['（整个样式）', '（整个字段）'];
function summarize(changes, limit = 12) {
  return changes.slice(0, limit).map((c) => {
    const whole = WHOLE.includes(c.field);
    if (c.kind === 'added') return whole ? `${c.target}：新增` : `${c.target} ${c.field}：新增`;
    if (c.kind === 'removed') return whole ? `${c.target}：删除` : `${c.target} ${c.field}：删除`;
    if (c.kind === 'order') return `${c.target}：${fmtVal(c.from)} → ${fmtVal(c.to)}`;
    return `${c.target} ${c.field}：${fmtVal(c.from)} → ${fmtVal(c.to)}`;
  });
}

/** 基线 vs 当前内存 → { changes, scopes, changeCount, summary }
 *  pluginKind：设备类样式才比 z / labelOffset，其他类型忽略这两个字段 */
export function diffConfig(baseStyles, baseFields, curStyles, curFields, pluginKind) {
  const changes = [];
  diffStyles(stylesNorm(baseStyles), stylesNorm(curStyles), changes, styleKeysFor(pluginKind));
  diffFields(fieldsNorm(baseFields), fieldsNorm(curFields), changes);
  const scopes = { styles: 0, fields: 0 };
  for (const c of changes) scopes[c.scope] += 1;
  return { changes, scopes, changeCount: changes.length, summary: summarize(changes) };
}
