/* 运行期日志缓冲（供 MCP studio_get_runtime 读取）
 *
 * 为什么需要：引擎里大量地方是 `try { ... } catch (e) { console.warn(...) }` ——
 * 插件的 update / plan2d / stateText / 动画帧报错都不会抛出，只在浏览器控制台里
 * 一闪而过。AI 通过 MCP 改代码时看不到这些，只能靠截图猜「为什么没变化」。
 *
 * 做法：在应用启动时挂一次钩子，把 console.warn / console.error / window.onerror /
 * unhandledrejection 收进环形缓冲，MCP 侧按需读取（可只取 error、可清空）。
 * 只影响 observability，不改变任何原有行为：原始 console 输出照样打印。
 */
'use strict';

const MAX = 120;
const buf = [];
let inited = false;
let seq = 0;
/* 页面可能在不同项目间切换：每条日志记下当时的项目，读取时按当前项目过滤，
 * 免得切项目后把上一个项目的报错当成自己的。 */
let projectGetter = null;
export function setRuntimeProjectGetter(fn) { projectGetter = typeof fn === 'function' ? fn : null; }
function currentProject() {
  try { return (projectGetter && projectGetter()) || ''; } catch (e) { return ''; }
}

/* 把任意值压成一行可读文本（带循环引用保护，深度限制 3 层） */
function toText(v, depth) {
  const d = depth || 0;
  if (v == null) return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Error) return (v.name || 'Error') + ': ' + v.message;
  if (d >= 3) return '[object]';
  if (Array.isArray(v)) return '[' + v.slice(0, 8).map((x) => toText(x, d + 1)).join(', ') + ']';
  if (typeof v === 'object') {
    const keys = Object.keys(v).slice(0, 12);
    return '{' + keys.map((k) => k + ': ' + toText(v[k], d + 1)).join(', ') + '}';
  }
  return String(v);
}

/* stack 只留前 4 行，够定位（studio 里都是单文件插件，行号很关键） */
function stackOf(e) {
  const s = e && e.stack ? String(e.stack) : '';
  if (!s) return '';
  return s.split('\n').slice(0, 4).join('\n');
}

export function pushRuntimeLog(level, args, extra) {
  const list = Array.prototype.slice.call(args || []);
  const first = list.find((x) => x instanceof Error) || null;
  const entry = {
    seq: ++seq,
    t: Date.now(),
    level: level || 'log',
    project: currentProject(),
    text: list.map((x) => toText(x)).join(' ').slice(0, 600),
    stack: first ? stackOf(first) : (extra && extra.stack ? String(extra.stack).split('\n').slice(0, 4).join('\n') : ''),
  };
  if (extra && extra.source) entry.source = extra.source;
  buf.push(entry);
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
  return entry;
}

export function readRuntimeLog(opts) {
  const o = opts || {};
  const level = o.level && o.level !== 'all' ? o.level : '';
  const limit = Math.max(1, Math.min(MAX, Number(o.limit) || 40));
  const since = Number(o.since) || 0;
  /* project 指定时只取该项目的日志；没标注项目的（钩子挂上前产生的）也算进来 */
  const proj = o.project == null ? '' : String(o.project);
  let items = buf.filter((e) => (!level || e.level === level)
    && e.t >= since
    && (!proj || !e.project || e.project === proj));
  if (items.length > limit) items = items.slice(items.length - limit);
  return items.map((e) => ({
    level: e.level,
    ago: Math.round((Date.now() - e.t) / 1000) + 's',
    project: e.project || undefined,
    text: e.text,
    stack: e.stack || undefined,
    source: e.source || undefined,
  }));
}

export function clearRuntimeLog() {
  const n = buf.length;
  buf.length = 0;
  return n;
}

export function runtimeLogStats(opts) {
  const proj = opts && opts.project != null ? String(opts.project) : '';
  const list = proj ? buf.filter((e) => !e.project || e.project === proj) : buf;
  return {
    total: list.length,
    errors: list.filter((e) => e.level === 'error').length,
    warns: list.filter((e) => e.level === 'warn').length,
    capacity: MAX,
  };
}

/* 挂全局钩子（幂等，重复调用无副作用） */
export function initRuntimeLog() {
  if (inited || typeof window === 'undefined') return;
  inited = true;

  const ce = console.error;
  const cw = console.warn;
  console.error = function (...a) {
    try { pushRuntimeLog('error', a); } catch (e) { /* 日志自身不许再抛 */ }
    return ce.apply(console, a);
  };
  console.warn = function (...a) {
    try { pushRuntimeLog('warn', a); } catch (e) { /* ignore */ }
    return cw.apply(console, a);
  };

  window.addEventListener('error', (ev) => {
    /* 资源加载失败（img/script）没有 message，单独标出来 */
    const msg = ev && ev.message ? ev.message : ('资源加载失败: ' + ((ev && ev.target && (ev.target.src || ev.target.href)) || '未知'));
    pushRuntimeLog('error', [msg], { source: 'window.onerror', stack: ev && ev.error && ev.error.stack });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev && ev.reason;
    pushRuntimeLog('error', [r], { source: 'unhandledrejection', stack: r && r.stack });
  });
}
