/* 配置域工具：get_project / snapshot / get_code / write_code */
'use strict';

const { z } = require('zod');
const { readProject, writeProject } = require('../config');
const { buildAll } = require('../generator');
const { diffSnapshot, driftOut, recordSnapshot } = require('../config-snapshot');
const hub = require('../ws-hub');
const H = require('./helpers');

function register(server) {
  /* 项目配置全貌（不含代码）：开工前用它建上下文 */
  server.tool(
    'studio_get_project',
    '一站式读取项目全部配置（不含代码）：AI 提示词 aiPrompt、插件属性（settings）、样式与参数（styles）、字段绑定（fields）、可用模型（models）。开发插件的第一步永远是调它建立上下文，再 studio_get_code 读代码',
    { projectId: z.string().optional().describe('项目 id；省略时自动使用唯一已打开的项目') },
    async ({ projectId }) => {
      try {
        const pid = H.requirePid(projectId);
        return H.text(H.projectConfig(readProject(pid), pid));
      } catch (e) { return H.fail(e.message); }
    },
  );

  server.tool(
    'studio_snapshot',
    '配置快照：把当前项目的属性（settings）、字段（fields）、样式（styles）原样复制存进 project.snapshot。'
    + '用途：plugin.js 是按某一版配置写死的，用户改配置后代码不会自己变；发布/导出前会拿快照对账，漂移就提醒重新生成。'
    + '用法：AI 完成一轮开发并验证通过后调它记录（带 label）；只想看配置是否漂移用 compareOnly=true；clear=true 删除快照',
    {
      projectId: z.string().optional().describe('项目 id，缺省用当前打开的项目'),
      label: z.string().optional().describe('快照备注，如「首版落地灯完成」'),
      compareOnly: z.boolean().optional().describe('只对比不写：返回当前配置与上次快照的差异'),
      clear: z.boolean().optional().describe('删除快照（之后不再做漂移提醒，直到重新记录）'),
    },
    async ({ projectId, label, compareOnly, clear } = {}) => {
      try {
        const pid = H.requirePid(projectId);

        if (clear) {
          const proj = readProject(pid);
          const had = !!proj.snapshot;
          delete proj.snapshot;
          writeProject(pid, proj);
          hub.notify(pid, { type: 'refresh', what: 'snapshot' });
          return H.text({ ok: true, action: 'cleared', projectId: pid, removed: had });
        }

        if (compareOnly) {
          const d = diffSnapshot(readProject(pid));
          return H.text({
            ok: true,
            action: 'compared',
            projectId: pid,
            ...driftOut(d),
            snapshot: d.snapshot,
            codeChanged: d.codeChanged,
          });
        }

        /* 覆盖旧快照前 recordSnapshot 会先留一份差异（AI 可据此判断「这轮是不是真的对齐了」） */
        const { before, snapshot, proj } = recordSnapshot(pid, label);
        const notified = hub.notify(pid, { type: 'refresh', what: 'snapshot' });
        return H.text({
          ok: true,
          action: 'recorded',
          projectId: pid,
          projectName: proj.name || '',
          at: snapshot.at,
          label: snapshot.label,
          version: snapshot.version,
          codeLines: snapshot.code.lines,
          /* 记下来的三块各有多少条，便于确认没记错东西 */
          counts: {
            settings: Object.keys(snapshot.config.settings).length,
            styles: snapshot.config.styles.length,
            fields: snapshot.config.fields.length,
          },
          replaced: before.hasSnapshot,
          replacedAt: before.snapshot ? before.snapshot.at : '',
          changesSincePrevious: before.changes,
          notified,
          hint: before.hasSnapshot
            ? (before.changeCount
              ? `已用当前配置覆盖旧快照（旧快照之后有 ${before.changeCount} 处配置改动，见 changesSincePrevious）`
              : '已刷新快照时间（配置与旧快照一致）')
            : '已记录首份配置快照',
        });
      } catch (e) { return H.fail(e.message); }
    },
  );

  /* ---------------- 读代码 ---------------- */

  server.tool(
    'studio_get_code',
    '读取当前项目的完整插件代码（plugin.js 全文）——造型、部件、实体绑定、状态逻辑都在里面，改代码从这里开始。附带模型文件列表与最小项目概要',
    { projectId: z.string().optional().describe('项目 id；省略时自动使用唯一已打开的项目') },
    async ({ projectId }) => {
      try {
        const pid = H.requirePid(projectId);
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
        const pid = H.requirePid(projectId);
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
}

module.exports = { register };
