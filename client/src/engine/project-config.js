/* 项目配置 → 插件定义（规则：**配置以项目为准**，代码里写死的不作依据）
 *
 * 背景：AI 生成的 plugin.js 常把 styles / options 写死在源码里（生成那一刻的快照）。
 * 如果拿它当渲染依据，面板/卡片里改参数就永远看不到效果：
 *   · 项目样式 id 与代码样式 id 常常对不上（default vs floor）
 *   · 代码样式没声明某个 option 时，值传进去会被 mergeOptions 整条丢掉
 *
 * 所以注册时用项目的 styles / fields 覆盖代码里的同名字段：
 *   · 样式：以项目条目为准（id / name / z / labelOffset / options 全部取项目），
 *     代码里同 id 的条目只用来补函数（背景插件的 style.apply 是渲染主体）
 *   · 字段：项目有就整份用项目的
 *   · 项目完全没配（空数组）时保留代码里的，避免空项目预览不出东西
 *
 * 与 server/inject-config.js 保持同一口径（那边把配置快照注进发布产物）。
 * ⚠ 双实现同步：改合并规则必须两处同步（见 server/inject-config.js 头注释）。
 */
import { normalizeOptions } from '../option-schema';

const shortId = (id) => String(id == null ? '' : id).split(':').pop();

/** 把项目样式条目归一成插件 def.styles 的形状（不带函数） */
export function styleOut(s) {
  const out = {
    id: s.id,
    name: s.name || s.id,
    options: normalizeOptions(s.options).map((o) => Object.assign({}, o)),
  };
  if (s.desc != null) out.desc = s.desc;
  if (s.icon != null) out.icon = s.icon;
  if (s.z != null) out.z = s.z;
  if (s.labelOffset != null) out.labelOffset = s.labelOffset;
  return out;
}

/** 就地改造一个插件定义：项目 styles / fields 覆盖代码里的 */
export function applyProjectConfig(def, cfg) {
  if (!def) return def;
  const c = cfg || {};

  const projStyles = (Array.isArray(c.styles) ? c.styles : []).filter((s) => s && s.id);
  if (projStyles.length) {
    const codeStyles = (Array.isArray(def.styles) ? def.styles : []).filter((s) => s && s.id);
    const byId = {};
    codeStyles.forEach((s) => { byId[shortId(s.id)] = s; });
    def.styles = projStyles.map((ps) => {
      const src = byId[shortId(ps.id)] || null;
      /* 配置字段全部以项目为准；src 只贡献函数等非配置属性 */
      const out = Object.assign({}, src || {}, styleOut(ps));
      /* 背景插件：代码里没有同 id 的条目时，借用第一个样式的渲染函数（apply 是主体） */
      if (!src && def.kind === 'background' && codeStyles[0]) {
        ['apply', 'preview', 'build'].forEach((k) => {
          if (typeof codeStyles[0][k] === 'function') out[k] = codeStyles[0][k];
        });
      }
      return out;
    });
  }

  const projFields = (Array.isArray(c.fields) ? c.fields : []).filter((f) => f && f.key);
  if (projFields.length) def.fields = projFields.map((f) => Object.assign({}, f));

  return def;
}
