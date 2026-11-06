/* 项目配置 ↔ 插件定义：加载时合并（2026-11 新架构）
 *
 * 口径（配置唯一事实源 = project.json）：
 *   · 项目 JSON 的 styles / fields 是**结构与数据的唯一来源**：有哪些样式/参数/字段、顺序、值，全按它；
 *   · AI 代码 register 的 def 只提供**渲染函数**（apply / model3d / plan2d 等）与同 id 参数兜底：
 *     代码里同 id 的条目被拿来当函数载体，数据与参数列表整条被 JSON 覆盖；
 *   · 项目里完全没配（styles / fields 为空）时，才用代码声明的结构兜底（新项目首次运行）。
 *
 * 因此删除样式/字段 = 从项目配置里删掉即可，不需要任何屏蔽标记：代码里即便还声明着同 id，
 * 也不会被并回来（用户约定：没配置就不生效）。AI 增删样式/字段后，用 studio_sync_config
 * 把最终版清单写进配置，画面与存档才一起变。
 *
 * 预览侧唯一的运行时合并（导出/发布产物是干净代码，不做注入）。
 */

const shortId = (id) => String(id == null ? '' : id).split(':').pop();

/* 样式上「用户可编辑、随存档恢复」的元信息（name 单独处理：缺省回落 id） */
const STYLE_META = ['icon', 'desc', 'z', 'labelOffset', 'refresh'];

/** 纯数据版样式条目：代码里没有同 id 的样式（面板新建 / AI 清单新增）直接用它 */
function savedStyleData(s) {
  const out = { id: s.id, name: s.name || s.id };
  STYLE_META.forEach((k) => { if (s[k] !== undefined) out[k] = s[k]; });
  out.options = (Array.isArray(s.options) ? s.options : [])
    .filter((o) => o && o.key).map((o) => Object.assign({}, o));
  return out;
}

/** 同 id 样式恢复：拿代码条目当函数载体，元信息 / 参数整条按存档覆盖 */
function restoreStyle(codeStyle, saved, def, firstCodeStyle) {
  let out;
  if (codeStyle) {
    out = codeStyle;   // 函数属性（apply / model3d / plan2d 等）由代码提供
    STYLE_META.forEach((k) => {
      if (saved[k] !== undefined) out[k] = saved[k]; else delete out[k];
    });
    out.name = saved.name || saved.id || out.name;
  } else {
    out = savedStyleData(saved);
    /* 背景插件：配置新增的样式没有自己的渲染函数，借第一个代码样式的 */
    if (def && def.kind === 'background' && firstCodeStyle) {
      ['apply', 'preview', 'build'].forEach((k) => {
        if (typeof firstCodeStyle[k] === 'function') out[k] = firstCodeStyle[k];
      });
    }
  }
  /* 参数的结构与顺序一律按存档；存档没写 options 时才用代码里声明的兜底 */
  if (Array.isArray(saved.options)) {
    out.options = saved.options.filter((o) => o && o.key).map((o) => Object.assign({}, o));
  } else if (codeStyle && Array.isArray(codeStyle.options)) {
    out.options = codeStyle.options.filter((o) => o && o.key);
  } else {
    out.options = [];
  }
  return out;
}

/** 代码执行（register）后按项目配置重建 def。就地改 def 并返回。 */
export function applyProjectConfig(def, cfg) {
  if (!def) return def;
  const c = cfg || {};

  /* 代码基线：合并项目 JSON **之前**的 styles/fields 深拷贝（JSON 克隆自动剥掉函数）。
   * 顶栏「配置已变更 N 处」= 当前配置 vs 这份基线（见 store.refreshDrift / config-diff.js）；
   * respawn 不走这里，所以基线始终代表「这一版代码声明了什么」。 */
  def._baseline = {
    styles: JSON.parse(JSON.stringify(def.styles || [])),
    fields: JSON.parse(JSON.stringify(def.fields || [])),
  };

  const codeStyles = (Array.isArray(def.styles) ? def.styles : []).filter((s) => s && s.id);
  const savedStyles = (Array.isArray(c.styles) ? c.styles : []).filter((s) => s && s.id);
  if (savedStyles.length) {
    const codeById = {};
    codeStyles.forEach((s) => { codeById[shortId(s.id)] = s; });
    def.styles = savedStyles.map((s) => (
      restoreStyle(codeById[shortId(s.id)] || null, s, def, codeStyles[0] || null)
    ));
  }

  const codeFields = (Array.isArray(def.fields) ? def.fields : []).filter((f) => f && f.key);
  const savedFields = (Array.isArray(c.fields) ? c.fields : []).filter((f) => f && f.key);
  if (savedFields.length) def.fields = savedFields.map((f) => Object.assign({}, f));
  else if (!Array.isArray(def.fields)) def.fields = codeFields;

  return def;
}
