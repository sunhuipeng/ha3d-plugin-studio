/* 项目/页面域工具：
 *   list_projects / create_project / copy_project / where / single_window / open_project
 * 新建与复制的实现在 lib/project-ops.js，与 REST 路由（routes/projects.js）共用一份。 */
'use strict';

const { z } = require('zod');
const { listProjectSummaries, readProject, safeId } = require('../lib/config');
const { createProject, copyProject } = require('../lib/project-ops');
const hub = require('../lib/ws-hub');
const H = require('./helpers');

function register(server) {
  server.tool(
    'studio_list_projects',
    '列出所有项目：id、名称、插件类型（kind/type）、模型数、家具件数（catalog 项目）、更新时间（按最近更新排序）。要在某个项目上开发时先 studio_open_project 打开它；家具项目打开后用 studio_list_catalog_items 读清单',
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
          items: p.items || 0,
          updatedAt: p.updatedAt,
        }));
        return H.text({ count: items.length, items });
      } catch (e) { return H.fail(e.message); }
    },
  );

  /* 新建项目：与启动页「新建项目」按钮同一套实现（lib/project-ops.js）。
   * 纯服务端即可完成，不要求前端在线；open=true 时才顺带让编辑页切过去。 */
  server.tool(
    'studio_create_project',
    '新建项目（与启动页「新建项目」等价）：创建 device / background 插件项目或 catalog 家具包项目，返回新项目 id。'
      + 'kind 创建时定死、之后不可更改；新项目没有代码，接着用 studio_write_code 写插件代码（家具包用 studio_upload_catalog_model）。'
      + '新建后广播刷新前端项目列表；open 默认 true（让编辑页立即打开新项目），没有前端在线也不影响创建结果。',
    {
      name: z.string().optional().describe('项目名称（最长 60 字；省略 = 未命名插件 / 未命名家具包）'),
      kind: z.enum(['device', 'background', 'catalog']).optional()
        .describe('项目类型，创建后不可更改：device=设备/门窗插件（默认）、background=背景插件、catalog=家具包'),
      open: z.boolean().optional().describe('新建后是否让编辑页立即打开该项目（默认 true；页面没开或打开失败不影响创建结果）'),
    },
    async ({ name, kind, open } = {}) => {
      try {
        const proj = createProject({ name, kind });
        const out = {
          ok: true,
          projectId: proj.id,
          name: proj.name,
          kind: (proj.plugin && proj.plugin.kind) || 'device',
          pluginId: (proj.plugin && proj.plugin.id) || proj.id,
          note: 'kind 创建后不可更改；新项目还没有代码，接下来 studio_get_code / studio_write_code 写插件代码（家具包走家具工具）',
        };
        out.notified = hub.broadcast({ type: 'refresh', what: 'projects' });
        if (open !== false) {
          try {
            await hub.callAny('open_project', { projectId: proj.id }, 30000);
            out.opened = true;
          } catch (e) {
            out.opened = false;
            out.openHint = '项目已创建，但没有前端页面可切换；页面打开后用 studio_open_project 打开它';
          }
        } else {
          out.opened = false;
        }
        return H.text(out);
      } catch (e) { return H.fail(e.message); }
    },
  );

  /* 复制项目：深拷贝整份 project.json + models/ 目录，与启动页「复制项目」等价。 */
  server.tool(
    'studio_copy_project',
    '复制项目（与启动页「复制项目」等价）：深拷贝源项目的全部配置（styles / fields / customJs / catalog.items）与 models/ 目录，返回新项目 id。'
      + '副本的 plugin.id / plugin.name 会自动改成新 id / 新名字，但 plugin.js 里写死的 register.id / register.name 不会自动改，'
      + '复制后请用 studio_get_code + studio_write_code 对齐。默认只创建并刷新前端项目列表（open=false），不打断当前编辑页。',
    {
      projectId: z.string().optional().describe('源项目 id；省略时用当前编辑页唯一打开的项目（见 studio_list_projects / studio_where）'),
      name: z.string().optional().describe('副本名称（省略 = <源项目名> 副本）'),
      open: z.boolean().optional().describe('是否立即让编辑页打开副本（默认 false，只创建 + 刷新项目列表，不切走当前页面）'),
    },
    async ({ projectId, name, open } = {}) => {
      try {
        let pid = projectId;
        if (!pid) {
          try { pid = H.resolveProjectId(); }
          catch (e) { throw new Error('省略 projectId 时需要有编辑页打开着项目；也可以直接传 projectId（见 studio_list_projects）'); }
        }
        if (!safeId(pid)) throw new Error('项目 id 不合法');
        const copy = copyProject({ sourceId: pid, name });
        const out = {
          ok: true,
          sourceProjectId: pid,
          projectId: copy.id,
          name: copy.name,
          kind: (copy.plugin && copy.plugin.kind) || 'device',
          pluginId: (copy.plugin && copy.plugin.id) || copy.id,
          note: '副本已含源项目的代码与模型；plugin.js 里写死的 register.id / name 需手动对齐新项目',
        };
        out.notified = hub.broadcast({ type: 'refresh', what: 'projects' });
        if (open) {
          try {
            await hub.callAny('open_project', { projectId: copy.id }, 30000);
            out.opened = true;
          } catch (e) {
            out.opened = false;
            out.openHint = '副本已创建，但没有前端页面可切换；页面打开后用 studio_open_project 打开它';
          }
        } else {
          out.opened = false;
        }
        return H.text(out);
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
            pageId: f.pageId,
            projectId: f.projectId || '',
            projectName: f.projectName || '',
            page: f.projectId ? 'project' : 'home',
            visible: !!f.visible,
            focused: !!f.focused,
            chosen: !!f.chosen,
          })),
          pages: hub.groupPages(fronts).map((p) => ({
            pageId: p.pageId,
            sockets: p.clients.length,
            clientId: p.clients[0].clientId,
            projectId: p.clients[0].projectId || '',
          })),
        });
      } catch (e) { return H.fail(e.message); }
    },
  );

  server.tool(
    'studio_single_window',
    '单窗口收敛：studio 常常同时开着好几个标签页，MCP 的操作会在它们之间跳来跳去（这个标签页调参数、那个标签页截图，看到的东西对不上）。'
    + '调它先问一遍所有已连接页面「你现在可见/有焦点吗」，按**页面**（不是连接）挑要保留的那个（有焦点 > 可见 > 最近活跃），'
    + '其余页面收到关闭指令后自动断开中继并关闭自己；不认指令的旧页面由服务端兜底断开连接。'
    + '同一页面因 HMR / 重连留下的多条 socket 视为同一页，**不会被关**（否则用户唯一的那页会被自己关掉）。'
    + '只保留一个窗口后，后续所有 studio_* 操作都固定落在这一个标签页上',
    {
      keepClientId: z.string().optional().describe('指定保留哪个页面（见 studio_where 返回的 tabs[].clientId 或 pages[].clientId）；不传则自动挑「有焦点 / 可见 / 最近活跃」的那个'),
      projectId: z.string().optional().describe('只在打开该项目的页面里挑保留者（其余项目的页面也会被关掉）；不传 = 所有页面一起收敛'),
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
        const keepPage = hub.pageKey(keep);
        const keepRow = snap.find((f) => f.clientId === keep.clientId) || {};
        /* 只有「别的页面」才算多余；同一页面的其它 socket 不是多余窗口 */
        const extras = snap.filter((f) => hub.pageKey(f) !== keepPage);
        const samePage = snap.filter((f) => hub.pageKey(f) === keepPage);
        const pageCount = hub.groupPages(snap).length;

        const keptOut = {
          clientId: keep.clientId,
          pageId: keepPage,
          projectId: keep.projectId || '',
          projectName: keep.projectName || '',
          visible: !!keepRow.visible,
          focused: !!keepRow.focused,
          sockets: samePage.length,
        };

        if (!extras.length) {
          return H.text({
            ok: true,
            alreadySingle: true,
            kept: keptOut,
            closed: [],
            before: before.length,
            pages: pageCount,
            after: before.length,
            message: `只有 ${pageCount} 个页面连着（${keep.clientId}${keep.projectName ? ' · ' + keep.projectName : ''}`
              + `${samePage.length > 1 ? `，该页有 ${samePage.length} 条连接，按页面去重、未关闭任何页面` : ''}），已经是单窗口`,
          });
        }

        if (dryRun) {
          return H.text({
            ok: true,
            dryRun: true,
            kept: keptOut,
            wouldClose: extras.map((f) => ({
              clientId: f.clientId, pageId: f.pageId, projectId: f.projectId || '', projectName: f.projectName || '',
              visible: !!f.visible, focused: !!f.focused,
            })),
            before: before.length,
            pages: pageCount,
            message: `会保留 ${keep.clientId}（页面 ${keepPage}），关闭其余 ${extras.length} 个页面的连接（dryRun 未执行）`,
          });
        }

        const closed = await hub.closeExtra(keep);
        const after = hub.listFrontends().filter((f) => f.alive);
        return H.text({
          ok: true,
          kept: keptOut,
          closed,
          before: before.length,
          pages: pageCount,
          after: after.length,
          message: `已保留 ${keep.clientId}${keep.projectName ? '（' + keep.projectName + '）' : ''}，关闭 ${closed.length} 个多余页面的连接`
            + (after.length > 1 ? `；仍有 ${after.length} 条连接（同一页面 ${hub.groupPages(after).length} 个页面，属正常现象）` : ''),
          note: after.length > 1 ? '同页多连接是 HMR / 重连残留，不影响 MCP 定位（永远挑该页最新的一条），无需处理' : '',
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
