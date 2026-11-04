/* 配置快照：把「当前这一版」的属性（settings）、字段（fields）、样式（styles）
 * 原样复制一份存进 project.snapshot。
 *
 * 为什么需要它：plugin.js 里的造型 / 状态判断 / 参数读取是按**某一版配置**写死的。
 * 用户在面板上改了配置（加了个参数、改了枚举值、换了个样式…），代码不会自己跟着变，
 * 于是「配置对了、画面没变」。发布 / 导出前拿快照对账，漂移就提醒重新让 AI 生成。
 *
 * 存储形态（project.json 里的 snapshot 字段）：
 *   {
 *     at:      '2026-11-04T...',       记录时间
 *     label:   '首版落地灯',             备注（可空）
 *     version: '1.0.6',                记录时的插件版本（只做参考，不参与对比）
 *     code:    { lines, bytes, hash }, 记录时的代码指纹（只做参考，不参与对比）
 *     config:  { settings, styles, fields }  ← 真正参与对比的三块
 *   }
 *
 * 对比口径：
 *   · settings 按固定键比（id/name/kind/type/description/entityId），**version 不比** ——
 *     发布 bump 会改它，那不是配置漂移
 *   · styles 按 id 匹配、options 按 key 匹配（顺序无关），另外单独比一次样式顺序
 *     （首个样式 = 默认造型，顺序变了等于默认造型变了）
 *   · fields 按 key 匹配；domains / enumValues 排序后再比（集合语义，顺序不算改动）
 *   · 数值型字段（z/min/max/step）统一转数字，def 统一转字符串（"0.3" 与 0.3 视为相同）
 */
'use strict';

const crypto = require('crypto');
const { normalizeOptionType } = require('./option-schema');
const { normalizeFieldType, normalizeEnumValues, splitList } = require('./field-schema');
const { readProject, writeProject } = require('./config');

/* 参与对比的键 */
const SETTING_KEYS = ['id', 'name', 'kind', 'type', 'description', 'entityId'];
const STYLE_KEYS = ['name', 'desc', 'z', 'icon'];
const OPTION_KEYS = ['label', 'type', 'def', 'min', 'max', 'step', 'choices'];
const FIELD_KEYS = ['label', 'domains', 'placeholder', 'tip', 'entityId', 'valueType', 'enumValues'];

const str = (v) => (v == null ? '' : String(v)).trim();
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const list = splitList;

/* ---- 归一：同一份配置无论写得多随意，序列化结果一致 ---- */
function settingsNorm(p) {
  const pl = (p && p.plugin) || {};
  return {
    id: str(pl.id || (p && p.id)),
    name: str(pl.name || (p && p.name)),
    kind: str(pl.kind || 'device'),
    type: str(pl.type),
    description: str(pl.description),
    entityId: str(pl.entityId),
  };
}

function stylesNorm(p) {
  return ((p && p.styles) || []).map((s) => ({
    id: str(s.id),
    name: str(s.name || s.id),
    desc: str(s.desc),
    z: num(s.z),
    icon: str(s.icon),
    options: ((s.options) || []).filter((o) => o && typeof o === 'object').map((o) => ({
      key: str(o.key),
      label: str(o.label || o.key),
      type: normalizeOptionType(o.type),
      def: str(o.def),
      min: num(o.min),
      max: num(o.max),
      step: num(o.step),
      choices: Array.isArray(o.choices) ? o.choices.map(str) : [],
    })),
  }));
}

function fieldsNorm(p) {
  return ((p && p.fields) || []).filter((f) => f && f.key).map((f) => {
    const valueType = normalizeFieldType(f.valueType);
    return {
      key: str(f.key),
      label: str(f.label || f.key),
      domains: list(f.domains).sort(),
      placeholder: str(f.placeholder),
      tip: str(f.tip),
      entityId: str(f.entityId),
      valueType,
      /* 非枚举类不比较枚举值（面板里会把它们当无用残留） */
      enumValues: valueType === 'enum' ? normalizeEnumValues(f.enumValues).sort() : [],
    };
  });
}

function configOf(p) {
  return { settings: settingsNorm(p), styles: stylesNorm(p), fields: fieldsNorm(p) };
}

function codeFingerprint(code) {
  const s = String(code || '');
  return {
    lines: s.split('\n').length,
    bytes: Buffer.byteLength(s),
    hash: crypto.createHash('sha1').update(s).digest('hex'),
  };
}

/* 建快照对象（不落盘，调用方写进 proj.snapshot 再 writeProject） */
function takeSnapshot(p, label) {
  return {
    at: new Date().toISOString(),
    label: str(label).slice(0, 120),
    version: str(p.plugin && p.plugin.version),
    code: codeFingerprint(p.customJs),
    config: configOf(p),
  };
}

/* ---- 对比 ---- */
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* 差异值截断：icon 那种长 SVG 别把返回撑爆 */
function brief(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.length > 120 ? v.slice(0, 117) + '…' : v;
  if (Array.isArray(v)) return v.length > 10 ? v.slice(0, 10).concat(['…']) : v;
  return v;
}

function diffSettings(a, b, out) {
  for (const k of SETTING_KEYS) {
    if (!eq(a[k], b[k])) {
      out.push({ scope: 'settings', target: '插件属性', field: k, from: brief(a[k]), to: brief(b[k]) });
    }
  }
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

function diffStyles(a, b, out) {
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
    for (const k of STYLE_KEYS) {
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

/* 一行一条人话，给 UI 弹窗 / MCP 提示直接用 */
function summarize(changes, limit = 12) {
  return changes.slice(0, limit).map((c) => {
    if (c.kind === 'added') return `${c.target}：新增`;
    if (c.kind === 'removed') return `${c.target}：删除`;
    if (c.kind === 'order') return `${c.target}：${fmtVal(c.from)} → ${fmtVal(c.to)}`;
    return `${c.target} ${c.field}：${fmtVal(c.from)} → ${fmtVal(c.to)}`;
  });
}

/* 项目当前配置 vs 快照。没记录过快照时 hasSnapshot=false、stale=false（没有基准就不拦） */
function diffSnapshot(p) {
  const snap = p && p.snapshot && p.snapshot.config ? p.snapshot : null;
  const cur = configOf(p);
  if (!snap) {
    return {
      hasSnapshot: false,
      stale: false,
      changeCount: 0,
      scopes: { settings: 0, styles: 0, fields: 0 },
      changes: [],
      summary: [],
      snapshot: null,
      codeChanged: false,
      hint: '还没有配置快照：记录一次后，之后每次改配置都会和它对比（发布/导出会提醒重新生成）',
    };
  }
  const changes = [];
  diffSettings(snap.config.settings || {}, cur.settings, changes);
  diffStyles(snap.config.styles || [], cur.styles, changes);
  diffFields(snap.config.fields || [], cur.fields, changes);

  const scopes = { settings: 0, styles: 0, fields: 0 };
  for (const c of changes) scopes[c.scope] += 1;

  const fp = codeFingerprint(p.customJs);
  const snapCode = snap.code || {};
  return {
    hasSnapshot: true,
    stale: changes.length > 0,
    changeCount: changes.length,
    scopes,
    changes,
    summary: summarize(changes),
    snapshot: {
      at: snap.at || '',
      label: snap.label || '',
      version: snap.version || '',
      codeLines: snapCode.lines || 0,
      codeHash8: snapCode.hash ? String(snapCode.hash).slice(0, 8) : '',
      nowCodeHash8: fp.hash.slice(0, 8),
    },
    codeChanged: !!(snapCode.hash && snapCode.hash !== fp.hash),
    hint: changes.length
      ? `配置在快照之后改了 ${changes.length} 处（属性 ${scopes.settings} / 样式 ${scopes.styles} / 字段 ${scopes.fields}）：plugin.js 还是按旧配置写的，需要让 AI 重新生成，完成后用 studio_snapshot 记录新快照`
      : '配置与快照一致：代码是按当前这份配置写的，可以发布',
  };
}

/* 「首次记录」时的前情提示：已有旧快照被覆盖时，把差异一起报出来 */
function briefSnapshot(p) {
  const d = diffSnapshot(p);
  return {
    hasSnapshot: d.hasSnapshot,
    at: d.snapshot ? d.snapshot.at : '',
    label: d.snapshot ? d.snapshot.label : '',
    version: d.snapshot ? d.snapshot.version : '',
    stale: d.stale,
    changeCount: d.changeCount,
    scopes: d.scopes,
    summary: d.summary,
  };
}

/* 漂移信息精简输出：REST（GET/导出响应头、导出接口返回）与 MCP（get_project/export/publish）
 * 共用同一份字段口径，保证「配置改没改过」在各处看到的一致 */
function driftOut(d) {
  return {
    hasSnapshot: d.hasSnapshot,
    stale: d.stale,
    changeCount: d.changeCount,
    scopes: d.scopes,
    summary: d.summary,
    changes: d.changes,
    hint: d.hint,
  };
}

/* 记录快照并落盘（REST PUT /snapshot 与 MCP studio_snapshot 的 recorded 分支共用）。
 * 返回 { before, snapshot, proj }：before 是覆盖前的漂移情况（调用方据此报 replaced / 变更明细） */
function recordSnapshot(projectId, label) {
  const proj = readProject(projectId);
  const before = diffSnapshot(proj);
  proj.snapshot = takeSnapshot(proj, label);
  writeProject(projectId, proj);
  return { before, snapshot: proj.snapshot, proj };
}

module.exports = {
  takeSnapshot,
  diffSnapshot,
  briefSnapshot,
  driftOut,
  recordSnapshot,
};
