/* 配置锁域工具：lock_config / unlock_config / get_lock
 *
 * 锁是**纯前端状态**（只在编辑页内存里，见 client/src/store.js 的 applyLock）：
 *   锁定后 → 编辑页左侧所有浮层（属性 / 字段 / 样式 / 部件 / 提示词 / 代码）
 *   里的输入控件变只读，用户只能看不能改；预览区、拖拽、渲染都照常可用。
 *   刷新 / 重开页面 = 自动解锁，不存在锁死解不开的情况。
 * 服务端只做中继，不存状态、不做写入拦截 —— 所以这三个工具必须编辑页开着才能用。
 */
'use strict';

const { z } = require('zod');
const hub = require('../ws-hub');
const H = require('./helpers');

const lockOut = (pid, st) => ({
  ok: true,
  projectId: pid,
  locked: !!st.locked,
  by: st.by || '',
  at: st.at || 0,
  note: st.note || '',
  readOnlyForUser: !!st.locked,
});

function register(server) {
  server.tool(
    'studio_lock_config',
    '锁定用户编辑页的左侧配置面板（纯前端只读）：锁定后属性 / 字段 / 样式 / 部件 / 代码面板里的'
    + '输入控件变只读，用户只能看不能改，避免你批量改配置时和用户手改互相覆盖。'
    + '不影响你自己的写入工具，也不影响预览区操作；用户刷新页面即自动解锁。'
    + '需要编辑页当前处于打开状态。',
    {
      projectId: z.string().optional().describe('项目 id；省略时自动使用唯一已打开的项目'),
      note: z.string().optional().describe('锁备注（显示在编辑页只读提示条里，如「正在批量重构样式参数」）'),
    },
    async ({ projectId, note } = {}) => {
      try {
        const pid = H.requirePid(projectId);
        const st = await hub.call(pid, 'lock', { locked: true, note: note || '' }, 20000);
        return H.text({
          ...lockOut(pid, st),
          message: '已锁定：用户左侧面板转为只读（刷新页面会自动解锁）；你现在可以放心改配置 / 代码。',
        });
      } catch (e) { return H.fail(e.message); }
    },
  );

  server.tool(
    'studio_unlock_config',
    '解除用户编辑页左侧配置面板的只读状态（锁是纯前端状态，只有页面开着才能解）。'
    + '你批量改完配置 / 代码后调它，把编辑权交还用户。',
    {
      projectId: z.string().optional().describe('项目 id；省略时自动使用唯一已打开的项目'),
      note: z.string().optional().describe('解锁备注'),
    },
    async ({ projectId, note } = {}) => {
      try {
        const pid = H.requirePid(projectId);
        const st = await hub.call(pid, 'lock', { locked: false, note: note || '' }, 20000);
        return H.text({
          ...lockOut(pid, st),
          message: '已解锁：用户左侧面板恢复可编辑。',
        });
      } catch (e) { return H.fail(e.message); }
    },
  );

  server.tool(
    'studio_get_lock',
    '查用户编辑页当前的配置锁状态：locked（是否只读）、by（谁锁的：mcp = AI / user = 用户）、note（备注）。'
    + '锁只是前端只读开关，不拦 AI 写入；不确定用户是不是正在手改时可以先看一眼',
    {
      projectId: z.string().optional().describe('项目 id；省略时自动使用唯一已打开的项目'),
    },
    async ({ projectId } = {}) => {
      try {
        const pid = H.requirePid(projectId);
        const st = await hub.call(pid, 'lock', {}, 20000);
        return H.text({
          ...lockOut(pid, st),
          hint: st.locked
            ? '用户面板当前只读（' + (st.by === 'mcp' ? 'AI 锁的' : '用户自己锁的') + '），刷新页面会自动解锁'
            : '未锁定：用户可以直接手改左侧面板',
        });
      } catch (e) { return H.fail(e.message); }
    },
  );
}

module.exports = { register };
