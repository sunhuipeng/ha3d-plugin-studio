/* 配置域工具：get_project / get_code / write_code / sync_config */
'use strict';

const { z } = require('zod');
const { readProject, writeProject } = require('../config');
const { buildAll } = require('../generator');
const { normalizeOptionType, stripExtraOptionKeys } = require('../option-schema');
const { normalizeFieldType, normalizeEnumValues, splitList } = require('../field-schema');
const hub = require('../ws-hub');
const H = require('./helpers');

/* 落盘前后对账：样式 id / 参数 key / 字段 key 的增删摘要 */
function configDiff(before, after) {
  const styleMap = (p) => new Map((p.styles || [])
    .filter((s) => s && s.id).map((s) => [s.id, s]));
  const fieldKeys = (p) => new Set((p.fields || [])
    .filter((f) => f && f.key).map((f) => f.key));
  const bs = styleMap(before); const as = styleMap(after);
  const addedStyles = [...as.keys()].filter((id) => !bs.has(id));
  const removedStyles = [...bs.keys()].filter((id) => !as.has(id));
  const optionKeys = (s) => new Set(((s && s.options) || [])
    .filter((o) => o && o.key).map((o) => o.key));
  const addedOptions = []; const removedOptions = [];
  for (const [id, s] of as) {
    const prev = bs.get(id);
    if (!prev) { addedOptions.push(...[...optionKeys(s)].map((k) => `${id}.${k}`)); continue; }
    const po = optionKeys(prev); const ao = optionKeys(s);
    addedOptions.push(...[...ao].filter((k) => !po.has(k)).map((k) => `${id}.${k}`));
    removedOptions.push(...[...po].filter((k) => !ao.has(k)).map((k) => `${id}.${k}`));
  }
  const bf = fieldKeys(before); const af = fieldKeys(after);
  const addedFields = [...af].filter((k) => !bf.has(k));
  const removedFields = [...bf].filter((k) => !af.has(k));
  return {
    addedStyles, removedStyles, addedOptions, removedOptions, addedFields, removedFields,
    changed: !!(addedStyles.length || removedStyles.length || addedOptions.length
      || removedOptions.length || addedFields.length || removedFields.length),
  };
}

/* 落盘后一致性校验：前端 tab 读的是引擎内存（runtime），磁盘 JSON 是刚写下去的那份。
 * 两边都归一化成「样式 id + 参数 key 集合 / 字段 key 集合」，排序后逐项比对。
 * options 两种来源都兼容：磁盘是参数对象数组，前端 runtime 回传的是已拍平的 key 字符串数组。 */
function normStyles(list) {
  return (list || [])
    .filter((s) => s && s.id)
    .map((s) => ({
      id: String(s.id),
      options: (s.options || [])
        .map((o) => (o && typeof o === 'object' ? o.key : o))
        .filter(Boolean)
        .map(String)
        .sort(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
function parityOf(runtime, diskProj) {
  const rt = runtime || {};
  const rtStyles = normStyles(rt.styles);
  const diskStyles = normStyles(diskProj.styles);
  const rtFields = (rt.fields || []).filter(Boolean).map(String).sort();
  const diskFields = (diskProj.fields || []).filter((f) => f && f.key)
    .map((f) => String(f.key)).sort();
  const stylesOk = JSON.stringify(rtStyles) === JSON.stringify(diskStyles);
  const fieldsOk = JSON.stringify(rtFields) === JSON.stringify(diskFields);
  return {
    matched: stylesOk && fieldsOk,
    styles: stylesOk,
    fields: fieldsOk,
    ...(stylesOk ? {} : { runtimeStyles: rtStyles, diskStyles }),
    ...(fieldsOk ? {} : { runtimeFields: rtFields, diskFields }),
  };
}

/* ---- AI 直给「最终版配置」时的入参归一化（与 stylesOut / fieldsOut 同口径） ---- */
function normIncomingStyles(list) {
  return (Array.isArray(list) ? list : []).filter((s) => s && s.id).map((s) => {
    const out = { id: String(s.id), name: s.name ? String(s.name) : String(s.id) };
    ['icon', 'desc'].forEach((k) => { if (typeof s[k] === 'string' && s[k]) out[k] = s[k]; });
    if (typeof s.z === 'number' && Number.isFinite(s.z)) out.z = s.z;
    if (typeof s.labelOffset === 'number' && Number.isFinite(s.labelOffset)) out.labelOffset = s.labelOffset;
    /* 背景动态刷新率是 Hz 数字（引擎 refreshOf 按 Number 读，钳 0~30）。
     * 早期曾有把 refresh 当布尔开关的旧项目，这里兼容成 1 / 0，不再把数字丢掉。 */
    if (typeof s.refresh === 'number' && Number.isFinite(s.refresh)) {
      out.refresh = Math.max(0, Math.min(30, Math.round(s.refresh)));
    } else if (typeof s.refresh === 'boolean') {
      out.refresh = s.refresh ? 1 : 0;
    }
    out.options = (Array.isArray(s.options) ? s.options : []).filter((o) => o && o.key).map((o) => {
      const type = normalizeOptionType(o.type);
      const opt = { key: String(o.key), label: o.label ? String(o.label) : String(o.key), type };
      if (o.def !== undefined) opt.def = o.def;
      if (o.tip) opt.tip = String(o.tip);
      ['min', 'max', 'step'].forEach((k) => {
        if (typeof o[k] === 'number' && Number.isFinite(o[k])) opt[k] = o[k];
      });
      if (o.choices !== undefined) opt.choices = Array.isArray(o.choices) ? o.choices : splitList(o.choices);
      return stripExtraOptionKeys(opt, type);
    });
    return out;
  });
}

function normIncomingFields(list) {
  return (Array.isArray(list) ? list : []).filter((f) => f && f.key).map((f) => {
    const valueType = normalizeFieldType(f.valueType != null ? f.valueType : f.type);
    const out = { key: String(f.key), label: f.label ? String(f.label) : String(f.key), valueType };
    ['placeholder', 'tip', 'entityId'].forEach((k) => { if (f[k]) out[k] = String(f[k]); });
    const domains = splitList(f.domains);
    if (domains.length) out.domains = domains;
    if (valueType === 'enum') out.enumValues = normalizeEnumValues(f.enumValues);
    /* 字段属性（实体 attributes 的 YAML 示例）：一律存成字符串。
       传对象也收 —— JSON 是 YAML 1.2 的子集，前端 yaml 解析器照样能读，
       这样 AI 用 JSON 随手写一遍也不会把字段变成对象。 */
    if (f.attributes !== undefined && f.attributes !== null) {
      const raw = typeof f.attributes === 'string'
        ? f.attributes
        : JSON.stringify(f.attributes, null, 2);
      const attrs = String(raw)
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+$/gm, '')
        .replace(/^\n+/, '')
        .replace(/\n+$/, '');
      if (attrs) out.attributes = attrs;
    }
    if (f.def !== undefined) out.def = f.def;
    return out;
  });
}

/* 重复 id / key 会让后一条静默吃掉前一条，入参阶段就挡掉 */
function dupOf(list, key) {
  const seen = new Set(); const dup = [];
  (list || []).forEach((x) => {
    const k = x && x[key];
    if (!k) return;
    if (seen.has(k)) dup.push(k); else seen.add(k);
  });
  return dup;
}

function register(server) {
  /* 项目配置全貌（不含代码）：开工前用它建上下文 */
  server.tool(
    'studio_get_project',
    '一站式读取项目全部配置（不含代码）：AI 提示词 aiPrompt、插件属性（settings）、样式与参数（styles）、字段绑定（fields）、可用模型（models）；家具包（kind: catalog）会额外返回 catalog（整张家具清单 + 包元信息）。开发插件的第一步永远是调它建立上下文，再 studio_get_code 读代码',
    { projectId: z.string().optional().describe('项目 id；省略时自动使用唯一已打开的项目') },
    async ({ projectId }) => {
      try {
        const pid = H.requirePid(projectId);
        return H.text(H.projectConfig(readProject(pid), pid));
      } catch (e) { return H.fail(e.message); }
    },
  );

  /* ---------------- 读代码 ---------------- */

  server.tool(
    'studio_get_code',
    '读取当前项目的完整插件代码（plugin.js 全文）——造型、部件、实体绑定、状态逻辑都在里面，改代码从这里开始。附带模型文件列表与最小项目概要。家具包（kind: catalog）没有插件代码，请用 studio_list_catalog_items',
    { projectId: z.string().optional().describe('项目 id；省略时自动使用唯一已打开的项目') },
    async ({ projectId }) => {
      try {
        const pid = H.assertPluginProject(projectId);
        const proj = readProject(pid);
        const built = buildAll(proj);
        return H.text({
          projectId: pid,
          name: proj.name,
          plugin: {
            id: proj.plugin?.id || '',
            name: proj.plugin?.name || '',
            kind: proj.plugin?.kind || 'device',
            type: proj.plugin?.type || '',
            version: proj.plugin?.version || '',
          },
          styleId: (proj.styles?.[0] || {}).id || '',
          styles: (proj.styles || []).map((s) => ({ id: s.id, name: s.name || s.id })),
          fields: H.fieldsOut(proj),
          models: H.modelsWithSize(pid),
          source: 'customJs',
          code: built.js,
          codeLines: String(built.js || '').split('\n').length,
        });
      } catch (e) { return H.fail(e.message); }
    },
  );

  /* ---------------- 写代码 + 立即运行 ---------------- */

  server.tool(
    'studio_write_code',
    '提交插件代码：先做语法体检（有错不落盘），写入后立刻让前端清空上一轮渲染并用新代码重建，返回渲染结果（插件 id / 尺寸 / 相机 / 实体）。传空字符串 = 清空代码（plugin.js 为空）',
    {
      projectId: z.string().optional(),
      code: z.string().describe('plugin.js 完整源码'),
      view: z.enum(H.SCREEN_VIEWS).optional().describe('运行后套用的视角预设'),
      run: z.boolean().optional().describe('是否立即运行（默认 true）'),
    },
    async ({ projectId, code, view, run }) => {
      try {
        const pid = H.assertPluginProject(projectId);
        const proj = readProject(pid);
        const src = String(code == null ? '' : code);

        /* 语法体检：AI 写坏的代码不该静默落盘 */
        try {
          new Function('PluginEngine', src);   // eslint-disable-line no-new-func
        } catch (e) {
          return H.fail('代码有语法错误，未写入：' + e.message);
        }

        proj.customJs = src;
        writeProject(pid, proj);

        const base = {
          ok: true,
          projectId: pid,
          source: 'customJs',
          codeLines: src.split('\n').length,
        };
        if (run === false) return H.text(Object.assign(base, { ran: false }));

        /* 落盘成功 → 让前端重新读代码并重建场景 */
        try {
          const st = await hub.call(pid, 'run_code', { view }, 60000);
          return H.text(Object.assign(base, { ran: true, render: st }));
        } catch (e) {
          return H.text(Object.assign(base, {
            ran: false,
            renderError: H.friendlyRelayError(e, '代码已保存，但浏览器里的页面还是旧版本前端，请刷新页面后重试（刷新后会自动加载新构建）'),
          }));
        }
      } catch (e) { return H.fail(e.message); }
    },
  );

  /* ---------------- 运行时配置落盘 ---------------- */

  server.tool(
    'studio_sync_config',
    '把 styles / fields 写进项目配置并落盘：传什么就是什么，整表替换。'
    + '前端样式 / 字段 tab 的数据立即换成这份清单，画面按新配置重建，服务端 project.json 同步保存。'
    + '不合并、不留删除标记：清单里没有的旧条目就是被删掉了（代码里仍声明也不会复活）。'
    + '落盘是主目标：页面重渲染失败也照常写入（原因在 hint / warn 里给出）。'
    + '返回 diff（落盘前后增删）+ parity（tab 实际值 vs 磁盘 JSON）',
    {
      projectId: z.string().optional().describe('项目 id；省略时自动使用唯一已打开的项目'),
      styles: z.array(z.object({
        id: z.string().describe('样式 id（代码里 styles[].id 同名则复用它的渲染函数）'),
        name: z.string().optional().describe('样式名（缺省用 id）'),
        desc: z.string().optional().describe('样式说明'),
        icon: z.string().optional().describe('SVG 图标字符串（左下角卡片用）'),
        z: z.number().optional().describe('平面图叠放层级（2D 俯视）'),
        labelOffset: z.number().optional().describe('状态标签相对模型高度（米）'),
        refresh: z.number().optional().describe('刷新率（Hz，0 = 静态只画一次；背景插件动态效果用，引擎钳制 1~30）'),
        options: z.array(z.object({
          key: z.string(),
          label: z.string().optional(),
          type: z.enum(['range', 'number', 'select', 'checkbox', 'text']).optional()
            .describe('控件类型，缺省 text；不给 min/max/step/choices 时按类型自动丢弃无关键'),
          def: z.any().optional().describe('默认值'),
          min: z.number().optional(),
          max: z.number().optional(),
          step: z.number().optional(),
          choices: z.any().optional().describe('select 的选项：字符串数组或 [{label,value}]'),
          tip: z.string().optional(),
        })).optional().describe('样式参数（全量；没列出的旧参数即删除）'),
      })).optional().describe('最终版样式清单（全量替换）。不传则不动样式'),
      fields: z.array(z.object({
        key: z.string(),
        label: z.string().optional(),
        valueType: z.enum(['number', 'text', 'enum']).optional().describe('值类型，缺省 text'),
        enumValues: z.any().optional().describe('enum 的取值列表'),
        attributes: z.any().optional()
          .describe('实体 attributes 的 YAML 示例（给人 / AI 读，预览时作为模拟实体初值），如 "temperature: 26\\nhvac_action: heating"；也接受对象'),
        domains: z.any().optional().describe('可选值范围提示（数值/字符串列表）'),
        placeholder: z.string().optional(),
        tip: z.string().optional(),
        entityId: z.string().optional().describe('绑定的扩展实体 id'),
        def: z.any().optional(),
      })).optional().describe('最终版字段清单（全量替换）。不传则不动字段'),
    },
    async ({ projectId, styles, fields }) => {
      try {
        const pid = H.assertPluginProject(projectId);
        if (!Array.isArray(styles) && !Array.isArray(fields)) {
          return H.fail('请至少传 styles 或 fields（最终版全量清单）');
        }
        const payload = {};
        if (Array.isArray(styles)) {
          if (!styles.length) return H.fail('styles 不能为空：插件至少要保留一个样式');
          payload.styles = normIncomingStyles(styles);
          const dup = dupOf(payload.styles, 'id');
          if (dup.length) return H.fail('样式 id 重复，请合并后再提交：' + [...new Set(dup)].join(', '));
          for (const s of payload.styles) {
            const d = dupOf(s.options, 'key');
            if (d.length) return H.fail(`样式 ${s.id} 的参数 key 重复：` + [...new Set(d)].join(', '));
          }
        }
        if (Array.isArray(fields)) {
          payload.fields = normIncomingFields(fields);
          const dup = dupOf(payload.fields, 'key');
          if (dup.length) return H.fail('字段 key 重复，请合并后再提交：' + [...new Set(dup)].join(', '));
        }
        const before = readProject(pid);
        const r = await hub.call(pid, 'sync_config', payload, 120000);
        const after = readProject(pid);
        const renderOk = !r.render || r.render.ok !== false;
        const parity = r.runtime ? parityOf(r.runtime, after)
          : {
            matched: null,
            note: renderOk
              ? '前端是旧构建（没回传运行时清单），请刷新编辑页后再调一次以校验一致性'
              : '页面没能按新配置重渲染，本次不做 tab 一致性校验（配置已落盘）',
          };

        const hint = [];
        hint.push('已按清单覆盖 styles / fields 并落盘（前端 tab + 服务端 project.json 同步更新）');
        if (!renderOk) hint.push('⚠ 页面重渲染失败：' + ((r.render && r.render.error) || '未知原因'));
        if (parity.matched === false) hint.push('⚠ 磁盘与 tab 不一致，见 parity 明细');
        if (Array.isArray(r.warn) && r.warn.length) hint.push('⚠ ' + r.warn.join('；'));

        return H.text({
          ok: true,
          projectId: pid,
          savedAt: r.savedAt,
          render: r.render || null,
          diff: configDiff(before, after),
          parity,
          styles: r.styles,
          fields: r.fields,
          warn: r.warn || [],
          hint: hint.join('；'),
        });
      } catch (e) {
        return H.fail(H.friendlyRelayError(e, '浏览器里的页面还是旧版本前端，请刷新编辑页后重试'));
      }
    },
  );
}

module.exports = { register };
