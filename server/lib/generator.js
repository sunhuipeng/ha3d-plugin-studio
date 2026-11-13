/* 插件代码打包 + 发布校验。
 * plugin.js 一律就是项目里那份 customJs（AI 生成 / 手写），导出/发布原样打包、不包任何注入层。
 * styles/fields/options 以**项目配置**为准（AI 代码里写死的常量不作依据）：
 * 预览侧由引擎在 register 时合并（client/src/engine/project-config.js）；
 * 预览接口 /build 与打包产物返回同一份原始代码，代码面板里看到的就是打包出来的那份。 */
'use strict';

const { safeId } = require('./config');
const { FALLBACK_TYPES } = require('./catalog-schema');
const { normalizeOptionType } = require('./option-schema');
const { FIELD_TYPE_VALUES, normalizeFieldType, normalizeEnumValues } = require('./field-schema');

function modelListOf(proj) {
  return (Array.isArray(proj.models) ? proj.models : []).filter(Boolean);
}

/* plugin.js = 项目里的 customJs 原文（可能为空 = 还没有代码），不包任何注入层 */
function buildPluginJS(proj) {
  return String(proj.customJs == null ? '' : proj.customJs);
}

function buildManifest(proj, bump) {
  const p = proj.plugin || {};
  let version = String(p.version || '1.0.0');
  if (bump) {
    const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (m) version = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
    else version = '1.0.1';
  }
  /* id 一律 = 项目 id：安装端按它定位/替换插件目录，重复安装永远覆盖同一份，
   * 不再单独维护 projectId 字段（插件 id 输入框只用于展示，写入时以项目 id 为准）
   * kind 只有两类：device（设备 + 门/窗 + 家具，靠 type 区分）与 background。
   * 老项目里残留的 kind:'opening' 在导出时归一成 device（home 侧已废除 opening） */
  const kind = p.kind === 'opening' ? 'device' : (p.kind || 'device');
  const mf = { id: proj.id, name: p.name || proj.id, version, kind };
  if (kind !== 'background') {
    mf.type = p.type || 'other';
    /* ftype = 家具分类，只对 type:'furniture' 生效（home 端 register 只小写 trim、不校验枚举；
     * 枚举外的值归入「其他」）。非家具类型一律不写，避免 manifest 里留个没用的键 */
    const ftype = String(p.ftype || '').trim().toLowerCase();
    if (mf.type === 'furniture' && ftype) mf.ftype = ftype;
  }
  if (p.description) mf.description = p.description;
  return mf;
}

const buildAll = (proj, bump) => ({
  manifest: buildManifest(proj, bump),
  js: buildPluginJS(proj),
});

function validate(proj) {
  const w = [];
  const p = proj.plugin || {};
  if (!safeId(proj.id)) w.push({ level: 'error', msg: '项目 id 不合法（应为小写字母开头的字母/数字/下划线）' });
  if (!p.name) w.push({ level: 'error', msg: '插件名称不能为空' });
  if (p.kind !== 'background' && !p.type) w.push({ level: 'error', msg: '设备类插件（含门/窗、家具）必须选择 type' });
  /* ftype 只对家具生效：非家具写了会被 manifest 忽略，枚举外的值 home 会归入「其他」。
   * 两条都只 warn —— 不影响能否发布，但要让人知道为什么面板上分类没生效 */
  const ftype = String(p.ftype || '').trim().toLowerCase();
  if (ftype && p.type !== 'furniture') {
    w.push({ level: 'warn', msg: `ftype 只对 type:'furniture' 生效，当前 type=${p.type || '空'}，导出时会忽略 ftype` });
  } else if (ftype && !FALLBACK_TYPES.includes(ftype)) {
    w.push({ level: 'warn', msg: `ftype「${ftype}」不在家具分类枚举内（${FALLBACK_TYPES.join(' / ')}），home 会归入「其他」` });
  }
  /* 参数(options)按样式校验 */
  const styles = (proj.styles && proj.styles.length ? proj.styles : [{ id: 'default' }]);
  for (const s of styles) {
    const label = `样式「${s.name || s.id || 'default'}」`;
    const keys = new Set();
    for (const o of s.options || []) {
      if (!o.key) w.push({ level: 'error', msg: `${label}的参数(options)存在空 key` });
      else if (keys.has(o.key)) w.push({ level: 'error', msg: `${label}参数 key 重复: ${o.key}` });
      else keys.add(o.key);
      /* type 只认 range / number / select / checkbox / text；不写按 text，历史 bool 自动转 checkbox。
       * 写了但归一化后变了（不认识 / 旧写法）就提醒一句，保存后会被归一化更新 */
      if (o.type != null && String(o.type) !== '' && normalizeOptionType(o.type) !== String(o.type)) {
        w.push({ level: 'warn', msg: `${label}参数「${o.key || '?'}」type=${o.type} 已按 ${normalizeOptionType(o.type)} 处理（保存后自动更新）` });
      }
    }
  }
  const fkeys = new Set();
  for (const f of proj.fields || []) {
    if (!f.key) w.push({ level: 'error', msg: '字段(fields)存在空 key' });
    else if (fkeys.has(f.key)) w.push({ level: 'error', msg: `字段 key 重复: ${f.key}` });
    else fkeys.add(f.key);
    /* 字段类型 / 枚举值只是说明性元信息（不参与渲染），但写错了 AI 会理解偏，发布前提醒一下 */
    const rawVt = String(f.valueType == null ? '' : f.valueType).toLowerCase();
    if (rawVt && !FIELD_TYPE_VALUES.includes(rawVt)) {
      w.push({ level: 'warn', msg: `字段「${f.key || '?'}」的字段类型 ${f.valueType} 不认识，将按字符类处理` });
    }
    if (normalizeFieldType(f.valueType) === 'enum' && !normalizeEnumValues(f.enumValues).length) {
      w.push({ level: 'warn', msg: `字段「${f.key || '?'}」是枚举类但没填枚举值` });
    }
  }
  if (!modelListOf(proj).length) w.push({ level: 'warn', msg: '该项目 models 目录还没有 GLB 模型' });
  if (!proj.styles || !proj.styles.length) w.push({ level: 'warn', msg: '没有定义样式' });
  return w;
}

module.exports = { buildAll, validate };
