<script setup>
import { onMounted, computed, ref } from 'vue';
import { ElMessageBox } from 'element-plus';
import { S, act, toast, bigToast, initRoute } from './store';
import Home from './components/Home.vue';
import LeftRail from './components/LeftRail.vue';
import PluginStage from './components/PluginStage.vue';
import RightPanel from './components/RightPanel.vue';
import { initWs } from './ws-client';

/* 建立与 Node 服务端的 WebSocket 中继（MCP 工具调用走这条链路） */
initWs();

onMounted(() => { act.loadTarget(); act.loadProjects().catch((e) => toast(e.message, true)); initRoute(); });

/* ---- 配置快照：属性 / 字段 / 样式改过而代码没重新生成 → 发布/导出前提醒 ---- */
const snapText = computed(() => {
  const s = S.snapshot;
  if (!s.has) return '未记录快照';
  if (s.stale) return `配置已变更 ${s.changeCount} 处`;
  return '配置与快照一致';
});
const snapTitle = computed(() => {
  const s = S.snapshot;
  if (!s.has) return '还没有配置快照。点一下把当前属性 / 字段 / 样式记下来，之后发布前会自动对账';
  const t = s.at ? new Date(s.at).toLocaleString('zh-CN', { hour12: false }) : '';
  const head = `快照：${t}${s.label ? '（' + s.label + '）' : ''} · v${s.version || '-'}`;
  if (!s.stale) return head + '\n配置与快照一致';
  return head + `\n改过的配置（${s.scopes.settings} 属性 / ${s.scopes.styles} 样式 / ${s.scopes.fields} 字段）：\n· `
    + (s.summary.join('\n· ') || s.hint);
});

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* 发布 / 导出前对账：配置与快照不一致就弹窗提醒「让 AI 重新生成」（只提醒，不拦） */
async function ensureConfigFresh(action) {
  const d = await act.loadSnapshot();
  if (!d || !d.stale) return true;
  const rows = (d.summary || []).slice(0, 8)
    .map((t) => `<div class="drift-row"><i class="drift-dot"></i><span>${esc(t)}</span></div>`)
    .join('');
  const more = d.changeCount > 8
    ? `<div class="drift-row dim"><span>…另外还有 ${d.changeCount - 8} 处</span></div>` : '';
  try {
    await ElMessageBox.alert(
      `<div class="drift-msg">`
      + `<p class="drift-head">快照之后配置改了 <b>${d.changeCount}</b> 处`
      + `（属性 ${d.scopes.settings} / 样式 ${d.scopes.styles} / 字段 ${d.scopes.fields}）：</p>`
      + `<div class="drift-list">${rows || '<div class="drift-row dim"><span>（无明细）</span></div>'}${more}</div>`
      + `<p class="drift-note">plugin.js 还是按<b>旧配置</b>写的，${action}出去的效果可能不对。`
      + `建议让 AI 重新生成后再${action}。</p>`
      + `</div>`,
      {
        dangerouslyUseHTMLString: true,
        confirmButtonText: `仍然${action}`,
        customClass: 'drift-box',
      }
    );
    return true;
  } catch (e) { return false; }
}

async function onSnapChip() {
  const s = S.snapshot;
  try {
    if (!s.has) {
      await ElMessageBox.confirm(
        '把当前的属性（settings）、字段（fields）、样式（styles）复制进项目的 snapshot 字段。<br>'
        + '之后改了这些配置而代码没重新生成，发布 / 导出时会提醒你。',
        '记录配置快照',
        { dangerouslyUseHTMLString: true, confirmButtonText: '记录快照', cancelButtonText: '取消' }
      );
      await act.takeSnapshot('');
      return;
    }
    if (!s.stale) { toast('配置与快照一致，无需更新'); return; }
    await ElMessageBox.confirm(
      `当前配置与快照有 <b>${s.changeCount}</b> 处不同。<br>刷新快照只是把「已变更」标记清掉，`
      + `<b>不会</b>让代码跟着配置改 —— 如果代码还要按新配置重写，先让 AI 重新生成再刷新。`,
      '配置已变更',
      { dangerouslyUseHTMLString: true, confirmButtonText: '仍要刷新快照', cancelButtonText: '取消', type: 'warning' }
    );
    await act.takeSnapshot('');
  } catch (e) { /* 取消 */ }
}

/* 发布确认弹窗：点遮罩 / × = 放弃发布；两张选项卡即按钮，点了直接执行 */
const pubAsk = ref(false);
async function onPublish() {
  if (!S.proj) return;
  if (!(await ensureConfigFresh('发布'))) return;
  pubAsk.value = true;
}
async function doPublish(bump) {
  pubAsk.value = false;
  try { await act.publish(bump); } catch (e) { toast(e.message, true); }
}
function onBack() {
  act.goHome().catch((e) => toast(e.message, true));
}
/* 下拉菜单：导出插件包（可安装产物）/ 导出项目（整个项目文件夹备份，可在启动页再导入） */
async function onExport() {
  if (!(await ensureConfigFresh('导出'))) return;
  try { await act.exportZip(); } catch (e) { toast(e.message, true); }
}
async function onExportProject() {
  try { await act.exportProjectZip(); } catch (e) { toast(e.message, true); }
}
function onPublishCmd(cmd) {
  if (cmd === 'export') onExport();
  else if (cmd === 'exportProject') onExportProject();
}
</script>

<template>
  <div id="app-root">
    <!-- MCP 调用提示横条：MCP 连接/调用时出现，长时间无活动自动消失 -->
    <transition name="mcp-fade">
      <div v-if="S.mcp.active" class="mcp-bar" :class="{ off: !S.mcp.connected, busy: S.mcp.busy }">
        <span class="mcp-dot"></span>
        <span class="mcp-text">{{ S.mcp.text }}</span>
      </div>
    </transition>

    <!-- 启动页: 项目列表 -->
    <Home v-if="S.view === 'home'" />

    <!-- 编辑开发页 -->
    <template v-else>
      <header id="topbar">
        <el-button size="small" @click="onBack">← 项目</el-button>
        <div class="proj-name">{{ S.proj ? S.proj.name + '  (' + S.proj.id + ')' : '' }}</div>
        <div class="spacer"></div>
        <!-- 右侧操作区：已保存 → 配置快照 → 发布，贴右边缘排布（右侧不留空白） -->
        <div class="topbar-right">
          <span class="save-state">{{ S.saveState }}</span>
          <!-- 配置快照状态：点一下 = 记录/刷新快照（属性 + 字段 + 样式） -->
          <button class="snap-chip" :class="{ stale: S.snapshot.stale, none: !S.snapshot.has }"
                  :title="snapTitle" @click="onSnapChip">
            <span class="snap-dot"></span>{{ snapText }}
          </button>
          <el-dropdown class="btn-publish" :class="{ busy: S.publishing }" split-button size="small" type="primary"
                       :disabled="!S.proj || S.publishing" @click="onPublish" @command="onPublishCmd">
            <span v-if="S.publishing" class="pub-spin"></span>
            {{ S.publishing ? '发布中…' : '发布到 ha-3d-home' }}
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="export" :disabled="S.publishing">导出插件包</el-dropdown-item>
                <el-dropdown-item command="exportProject" :disabled="S.publishing">导出项目</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <div id="main">
        <LeftRail />
        <div id="stage-area">
          <PluginStage v-if="S.proj" :key="'stage-' + S.proj.id" />
          <RightPanel v-if="S.proj" :key="S.proj.id" />
        </div>
      </div>
    </template>

    <!-- 发布确认弹窗：点遮罩 / × = 放弃发布；两张选项卡即按钮，点了直接执行 -->
    <transition name="big-fade">
      <div v-if="pubAsk" class="modal-mask" @click.self="pubAsk = false">
        <div class="pub-modal">
          <button class="pub-close" aria-label="关闭" @click="pubAsk = false">
            <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
          </button>
          <div class="pub-title">发布到 ha-3d-home</div>
          <div class="pub-msg">
            <p class="pub-head">发布前要自动升一位版本号吗？<span class="pub-tag">推荐升版本</span></p>
            <div class="pub-opts">
              <button type="button" class="pub-opt on" @click="doPublish(true)">
                <b>升版本并发布</b>
                <span>plugin.js 地址带上新版本号，浏览器立刻拉到新代码</span>
              </button>
              <button type="button" class="pub-opt" @click="doPublish(false)">
                <b>不升版本直接发布</b>
                <span>版本号不变，可能命中浏览器长缓存，页面看不到新效果</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <div v-if="S.toast.show" class="toast" :class="{ err: S.toast.err }">{{ S.toast.msg }}</div>

    <!-- 发布成功等重大提示：居中大横幅，点击任意处关闭 -->
    <transition name="big-fade">
      <div v-if="S.bigToast.show" class="big-toast" @click="S.bigToast.show = false">
        <div class="big-toast-card">
          <span class="big-toast-icon">
            <svg viewBox="0 0 24 24" width="26" height="26"><path d="M20 6L9 17l-5-5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
          <span class="big-toast-title">{{ S.bigToast.title }}</span>
          <span v-if="S.bigToast.detail" class="big-toast-detail">{{ S.bigToast.detail }}</span>
        </div>
      </div>
    </transition>
  </div>
</template>
