/* 项目/页面域工具：list_projects / where / single_window / open_project */
'use strict';

const { z } = require('zod');
const { listProjectSummaries, readProject, safeId } = require('../config');
const hub = require('../ws-hub');
const H = require('./helpers');

function register(server) {
  server.tool(
    'studio_list_projects',
    '列出所有项目：id、名称、插件类型（kind/type）、模型数、更新时间（按最近更新排序）。要在某个项目上开发时先 studio_open_project 打开它',
    {},
    async () => {
      try {
        const items = listProjectSummaries().map((p) => ({
          projectId: p.id,
          name: p.name,
          kind: p.kind,
          type: p.type,
          pluginId: p.pluginId,
          models: p.models,
          updatedAt: p.updatedAt,
        }));
        return H.text({ count: items.length, items });
      } catch (e) { return H.fail(e.message); }
    },
  );

  server.tool(
    'studio_where',
    '判断编辑页现在停在哪一页：启动页（项目列表）还是某个项目的编辑页。项目页返回 projectId / 项目名；启动页返回 page:"home"（此时要操作项目就先 studio_open_project）；浏览器没打开页面返回 page:"none"。不确定「现在该不该先打开项目」时先调它',
    {},
    async () => {
      try {
        const fronts = hub.listFrontends().filter((f) => f.alive);
        if (!fronts.length) {
          return H.text({
            page: 'none',
            projectId: '',
            note: '浏览器没有打开 studio 页面（或已关闭）：先在浏览器打开 http://localhost:8098/ ，前端中继类工具（截图 / 写码运行 / 调参数）才有落点',
          });
        }
        /* 路由真身由前端回答（hash + S.proj）；连不上就退回 ws hello 上报的信息 */
        let live = null;
        try { live = await hub.callAny('where', {}, 8000); } catch (e) { /* 前端正忙就退回上报值 */ }
        const newest = fronts.sort((a, b) => (b.connectedAt || 0) - (a.connectedAt || 0))[0] || {};
        const projectId = (live && live.projectId) || newest.projectId || '';
        const page = (live && live.page) || (projectId ? 'project' : 'home');
        return H.text({
          page,
          projectId: page === 'project' ? projectId : '',
          projectName: (live && live.projectName) || newest.projectName || '',
          route: (live && live.hash) || '',
          href: (live && live.href) || '',
          tabs: fronts.map((f) => ({
            clientId: f.clientId,
            projectId: f.projectId || '',
            projectName: f.projectName || '',
            page: f.projectId ? 'project' : 'home',
            visible: !!f.visible,
            focused: !!f.focused,
            chosen: !!f.chosen,
          })),
        });
      } catch (e) { return H.fail(e.message); }
    },
  );

  server.tool(
    'studio_single_window',
    '单窗口收敛：studio 常常同时开着好几个标签页，MCP 的操作会在它们之间跳来跳去（这个标签页调参数、那个标签页截图，看到的东西对不上）。'
    + '调它先问一遍所有已连接页面「你现在可见/有焦点吗」，选出要保留的那个（有焦点 > 可见 > 最近连上），'
    + '其余前端收到关闭指令后自动断开中继并关闭自己；不认指令的旧页面由服务端兜底断开连接。'
    + '只保留一个窗口后，后续所有 studio_* 操作都固定落在这一个标签页上',
    {
      keepClientId: z.string().optional().describe('指定保留哪个页面（见 studio_where 返回的 tabs[].clientId）；不传则自动挑「有焦点 / 可见 / 最近连上」的那个'),
      projectId: z.string().optional().describe('只在打开该项目的页面里挑保留者（其余项目的页面也会被关掉）；不传 = 所有连接一起收敛'),
      dryRun: z.boolean().optional().describe('只列出会保留谁、关掉谁，不真的关闭'),
    },
    async ({ keepClientId, projectId, dryRun } = {}) => {
      try {
        const before = hub.listFrontends().filter((f) => f.alive);
        if (!before.length) {
          return H.text({
            ok: false,
            before: 0,
            message: '当前没有任何编辑页连上来（浏览器没打开 studio？），不需要收敛',
          });
        }
        /* 先问一遍 presence：不依赖前端有没有主动上报过焦点状态 */
        await hub.askPresence(350);
        const snap = hub.listFrontends().filter((f) => f.alive);
        const keep = hub.pickKeeper({ keepClientId, projectId });
        const keepRow = snap.find((f) => f.clientId === keep.clientId) || {};
        const extras = snap.filter((f) => f.clientId !== keep.clientId);

        const keptOut = {
          clientId: keep.clientId,
          projectId: keep.projectId || '',
          projectName: keep.projectName || '',
          visible: !!keepRow.visible,
          focused: !!keepRow.focused,
        };

        if (!extras.length) {
          return H.text({
            ok: true,
            alreadySingle: true,
            kept: keptOut,
            closed: [],
            before: before.length,
            after: before.length,
            message: `只有一个页面连着（${keep.clientId}${keep.projectName ? ' · ' + keep.projectName : ''}），已经是单窗口`,
          });
        }

        if (dryRun) {
          return H.text({
            ok: true,
            dryRun: true,
            kept: keptOut,
            wouldClose: extras.map((f) => ({
              clientId: f.clientId, projectId: f.projectId || '', projectName: f.projectName || '',
              visible: !!f.visible, focused: !!f.focused,
            })),
            before: before.length,
            message: `会保留 ${keep.clientId}，关闭其余 ${extras.length} 个页面（dryRun 未执行）`,
          });
        }

        const closed = await hub.closeExtra(keep);
        const after = hub.listFrontends().filter((f) => f.alive);
        return H.text({
          ok: true,
          kept: keptOut,
          closed,
          before: before.length,
          after: after.length,
          message: `已保留 ${keep.clientId}${keep.projectName ? '（' + keep.projectName + '）' : ''}，关闭 ${closed.length} 个多余标签页`
            + (after.length > 1 ? `；仍有 ${after.length} 个连接存活（可能是旧构建页面在重连，刷新或关掉即可）` : ''),
          note: after.length > 1 ? '若还有残留：让用户手动关掉多余标签页，或重新执行一次' : '',
        });
      } catch (e) { return H.fail(e.message); }
    },
  );

  server.tool(
    'studio_open_project',
    '让已打开的编辑页切换到指定项目（改 URL 路由，前端自动加载该项目配置与预览）。打开后该项目的读写/截图/点击等 studio_* 工具即可用',
    { projectId: z.string().describe('项目 id，见 studio_list_projects') },
    async ({ projectId }) => {
      try {
        const pid = String(projectId || '');
        if (!safeId(pid)) throw new Error('项目 id 不合法');
        readProject(pid);   // 不存在会抛错
        /* 目标项目页面大概率还没打开，走「任意已连页面」路由 */
        return H.text(await hub.callAny('open_project', { projectId: pid }, 30000));
      } catch (e) { return H.fail(e.message); }
    },
  );
}

module.exports = { register };
