/* 发布 / 导出时把项目配置注进 plugin.js
 *
 * 为什么需要：home 侧引擎只认代码注册的 def.styles，而 AI 生成的代码里 styles / options
 * 是生成那一刻写死的快照。studio 预览侧由引擎在 register 时用项目配置覆盖（见
 * client/src/engine/project-config.js），但安装到 home 的那份 plugin.js 必须自带配置，
 * 否则线上看到的还是旧值。
 *
 * 做法：不解析代码文本，直接包一层 IIFE —— 执行原代码期间把 PluginEngine.register
 * 换成「先合并配置、再交给真 register」，原代码一个字都不用动。
 *   · home：插件是 <script> 加载，PluginEngine 是全局对象；
 *   · studio 预览：new Function('PluginEngine', code) 注入同名参数。
 * 两种环境都取 typeof PluginEngine 拿到的那个对象，所以都不需要额外改动。
 *
 * 合并口径与前端完全一致：styles / fields 以项目为准，代码里同 id 的条目只提供函数
 * （背景插件的 style.apply 是渲染主体）。
 * ⚠ 双实现同步：本文件与 client/src/engine/project-config.js 是同口径的两份实现，
 * 改合并规则必须两处同步。
 */
'use strict';

/* 样式条目：只搬配置字段，函数没法序列化（背景的函数从代码条目里继承） */
function styleOut(s) {
  const out = { id: s.id, name: s.name || s.id, options: Array.isArray(s.options) ? s.options : [] };
  if (s.desc != null) out.desc = s.desc;
  if (s.icon != null) out.icon = s.icon;
  if (s.z != null) out.z = s.z;
  if (s.labelOffset != null) out.labelOffset = s.labelOffset;
  return out;
}

/* 配置快照（JSON 安全：把 < 转成 \u003c，避免出现 </script> 提前截断内联脚本） */
function snapshot(cfg) {
  const c = cfg || {};
  const styles = (Array.isArray(c.styles) ? c.styles : []).filter((s) => s && s.id).map(styleOut);
  const fields = (Array.isArray(c.fields) ? c.fields : []).filter((f) => f && f.key)
    .map((f) => Object.assign({}, f));
  return { styles, fields };
}

const RUNTIME = `  var __CFG__ = __CFG_JSON__;
  function __shortId(v) { return String(v == null ? '' : v).split(':').pop(); }
  /* 与 client/src/engine/project-config.js 同口径：项目配置覆盖代码里的同名字段 */
  function __applyCfg(def) {
    if (!def) return def;
    var cfg = __CFG__ || {};
    if (cfg.styles && cfg.styles.length) {
      var codeStyles = (def.styles || []).filter(function (s) { return s && s.id; });
      var byId = {};
      codeStyles.forEach(function (s) { byId[__shortId(s.id)] = s; });
      def.styles = cfg.styles.map(function (ps) {
        var src = byId[__shortId(ps.id)] || null;
        var out = {};
        if (src) { for (var k in src) out[k] = src[k]; }
        out.id = ps.id;
        out.name = ps.name || ps.id;
        out.options = (ps.options || []).map(function (o) { return Object.assign({}, o); });
        if (ps.desc != null) out.desc = ps.desc; else delete out.desc;
        if (ps.icon != null) out.icon = ps.icon; else delete out.icon;
        if (ps.z != null) out.z = ps.z; else delete out.z;
        if (ps.labelOffset != null) out.labelOffset = ps.labelOffset; else delete out.labelOffset;
        /* 背景插件：代码里没有同 id 条目时，借用第一个样式的渲染函数 */
        if (!src && def.kind === 'background' && codeStyles[0]) {
          ['apply', 'preview', 'build'].forEach(function (fn) {
            if (typeof codeStyles[0][fn] === 'function') out[fn] = codeStyles[0][fn];
          });
        }
        return out;
      });
    }
    if (cfg.fields && cfg.fields.length) {
      def.fields = cfg.fields.map(function (f) { return Object.assign({}, f); });
    }
    return def;
  }
  var __origRegister = __PE__ && __PE__.register;
  if (__origRegister) {
    __PE__.register = function (def) { return __origRegister.call(__PE__, __applyCfg(def)); };
  }
  try {
`;

const FOOTER = `  } finally {
    if (__origRegister) __PE__.register = __origRegister;
  }
})(typeof PluginEngine !== 'undefined' ? PluginEngine : null);
`;

/**
 * @param {string} code  项目里的 customJs
 * @param {object} cfg   { styles, fields }（项目配置）
 * @returns {string}     带配置注入的 plugin.js 源码
 */
function injectProjectConfig(code, cfg) {
  const src = String(code == null ? '' : code);
  if (!src.trim()) return src;
  const snap = snapshot(cfg);
  if (!snap.styles.length && !snap.fields.length) return src;

  const json = JSON.stringify(snap).replace(/</g, '\\u003c');
  const head = '/* 本文件由 ha3d-plugin-studio 生成：项目配置（styles / fields）以快照注入，'
    + '覆盖代码里的同名常量。改参数请在 studio 里改，不要在这里手改这一段。 */\n'
    + ';(function (__PE__) {\n' + RUNTIME.replace('__CFG_JSON__', json) + '\n';

  return head + src + '\n' + FOOTER;
}

module.exports = { injectProjectConfig };
