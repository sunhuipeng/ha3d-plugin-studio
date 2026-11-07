<script setup>
import { onMounted, computed, ref } from 'vue';
import { S, act, toast, bigToast, initRoute } from './store';
import Home from './components/Home.vue';
import LeftRail from './components/LeftRail.vue';
import PluginStage from './components/PluginStage.vue';
import RightPanel from './components/RightPanel.vue';
import CatalogEditor from './components/CatalogEditor.vue';
import { initWs } from './ws-client';

/* 家具项目（kind: catalog）走独立的编辑页：没有代码/实体/样式，只有清单 + 预览 + 属性。
 * 两类编辑页完全分开：插件那套（LeftRail + PluginStage + RightPanel）不掺任何 catalog 分支。 */
const isCatalog = computed(() => !!(S.proj && S.proj.plugin && S.proj.plugin.kind === 'catalog'));

/* 建立与 Node 服务端的 WebSocket 中继（MCP 工具调用走这条链路） */
initWs();

onMounted(() => { act.loadTarget(); act.loadProjects().catch((e) => toast(e.message, true)); initRoute(); });

/* ---- 配置漂移：当前引擎内存 vs 代码加载时的基线（styles/fields），客户端算好放在 S.snapshot ---- */
const snapText = computed(() => {
  const s = S.snapshot;
  if (!s.has) return '配置与代码一致';
  if (s.stale) return `配置已变更 ${s.changeCount} 处`;
  return '配置与代码一致';
});
const snapTitle = computed(() => {
  const s = S.snapshot;
  if (!s.has) return '还没有渲染过插件：渲染成功后以「AI 代码声明的样式/字段」为基线，之后改了配置这里会显示差异';
  if (!s.stale) return '当前内存配置与 AI 代码加载时声明的一致';
  return `相对代码加载时的配置（基线），样式 ${s.scopes.styles} / 字段 ${s.scopes.fields} 处不同：\n· `
    + (s.summary.join('\n· ') || '（无明细）');
});

/* ---- 配置漂移弹窗：替代 ElMessageBox，结构 = 总述 → 逐条差异 → 提示 → 单按钮 ----
 * driftAsk 存触发来源动作（'发布' | '导出'），null = 关闭；按钮文案随之变「仍然发布/仍然导出」 */
const driftAsk = ref(null);

function onSnapChip() {
  const s = S.snapshot;
  if (!s.has) { toast('渲染一次插件后，就会以 AI 代码声明的样式/字段建立对比基准'); return; }
  if (!s.stale) { toast('当前配置与代码加载时一致'); return; }
  driftAsk.value = '发布';
}

/* 弹窗里唯一的按钮：确认后继续原动作（发布 → 选版本弹窗；导出 → 直接打包下载） */
function confirmDrift() {
  const a = driftAsk.value;
  driftAsk.value = null;
  if (a === '发布') pubAsk.value = true;
  else if (a === '导出') act.exportZip().catch((e) => toast(e.message, true));
}

/* 发布 / 导出前对账：有差异就先弹差异弹窗（confirmDrift 里继续），没差异直接放行 */
function ensureConfigFresh(action) {
  const d = S.snapshot;
  if (d.has && d.stale) { driftAsk.value = action; return false; }
  return true;
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

    <!-- 家具项目（kind: catalog）：独立编辑页，自带顶栏与发布/导出 -->
    <CatalogEditor v-else-if="S.proj && isCatalog" :key="'cat-' + S.proj.id" />

    <!-- 插件编辑开发页 -->
    <template v-else>
      <header id="topbar">
        <el-button size="small" @click="onBack">← 项目</el-button>
        <div class="proj-name">{{ S.proj ? S.proj.name + '  (' + S.proj.id + ')' : '' }}</div>
        <div class="spacer"></div>
        <!-- 右侧操作区：已保存 → 配置快照 → 发布，贴右边缘排布（右侧不留空白） -->
        <div class="topbar-right">
          <span class="save-state">{{ S.saveState }}</span>
          <!-- 配置漂移状态：内存 vs 代码基线；点一下 = 以当前内存为准重置基线 -->
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

    <!-- 配置差异弹窗：总述 → 逐条差异 → 提示 → 单按钮（点遮罩 / × = 关闭不动作） -->
    <transition name="big-fade">
      <div v-if="driftAsk" class="modal-mask" @click.self="driftAsk = null">
        <div class="pub-modal drift-modal">
          <button class="pub-close" aria-label="关闭" @click="driftAsk = null">
            <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
          </button>
          <div class="pub-title">配置已变更</div>

          <!-- ① 总述：一共有几处 -->
          <p class="drift-count">
            当前参数和实际代码中的参数有
            <b>{{ S.snapshot.changeCount }}</b>
            处不同<span class="drift-scope">（样式 {{ S.snapshot.scopes.styles }} / 字段 {{ S.snapshot.scopes.fields }}）</span>
          </p>

          <!-- ② 逐条差异 -->
          <div class="drift-list">
            <div v-for="(t, i) in S.snapshot.summary" :key="i" class="drift-row">
              <i class="drift-dot"></i><span>{{ t }}</span>
            </div>
            <div v-if="!S.snapshot.summary.length" class="drift-row dim"><span>（无明细）</span></div>
          </div>

          <!-- ③ 提示 -->
          <p class="drift-hint">当前参数和实际代码中的参数有差异，如需按当前参数发布，可让 AI 重新拉取代码和参数，进行自动合并。</p>

          <button type="button" class="drift-go" @click="confirmDrift">仍然{{ driftAsk }}</button>
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
