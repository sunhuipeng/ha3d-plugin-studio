<script setup>
/* 浮层容器：只负责浮层外壳（定位 / 宽度 / 动画），内容按 tab 拆到 panels/*.vue */
import { computed, watch } from 'vue';
import { S, act, toast } from '../store';
import SettingsPanel from './panels/SettingsPanel.vue';
import PartsPanel from './panels/PartsPanel.vue';
import StylesPanel from './panels/StylesPanel.vue';
import FieldsPanel from './panels/FieldsPanel.vue';
import CodePanel from './panels/CodePanel.vue';
import PromptPanel from './panels/PromptPanel.vue';

/* 各 tab 浮层独立宽度（px） */
const PANEL_W = { settings: 400, parts: 480, styles: 520, fields: 480, code: 820, prompt: 580 };
const panelWidth = computed(() => (PANEL_W[S.panel] || 400) + 'px');

const PANELS = {
  settings: SettingsPanel,
  prompt: PromptPanel,
  parts: PartsPanel,
  styles: StylesPanel,
  fields: FieldsPanel,
  code: CodePanel,
};
const current = computed(() => PANELS[S.panel] || null);

/* 字段 / 样式两个 tab 顶部的协同说明：配置是「人机共用」的 */
const showCfgNote = computed(() => S.panel === 'styles' || S.panel === 'fields');

/* 配置锁：锁定后左侧所有浮层只读（纯前端状态，刷新页面即解锁） */
const locked = computed(() => S.lock.locked);
const lockOwner = computed(() => (S.lock.by === 'mcp' ? 'AI' : '你'));
function unlock() {
  act.setLock(false).catch((e) => toast(e.message, true));
}

/* 锁定 = 面板里的每个控件自己 disabled（各 panel 里 `:disabled="LOCK"`）。
 * 这里只负责两件收尾：锁的瞬间 blur 掉正在编辑的输入框、关掉已展开的下拉浮层。
 * 面板照常能打开 / 切换 / 滚动查看；MCP 直接写配置不经过前端，不受影响。 */
watch(locked, (v) => {
  if (!v) return;
  const el = document.activeElement;
  if (el && el.closest && el.closest('#float-panel')) el.blur();
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
</script>

<template>
  <transition name="fp">
    <aside id="float-panel" v-if="S.panel && S.proj" :style="{ width: panelWidth }">
      <div class="fp-body" :class="{ locked }">
        <!-- 配置锁：只读提示条（锁定期间面板内所有控件不响应，查看 / 滚动正常） -->
        <div v-if="locked" class="lock-note">
          <span class="lock-note-title">配置已锁定 · 只读</span>
          <span class="lock-note-text">
            由{{ lockOwner }}锁定，避免人和 AI 同时改配置互相覆盖<template v-if="S.lock.note">（{{ S.lock.note }}）</template>。
            需要手动编辑请先解锁；刷新页面也会自动解锁。
          </span>
          <button class="lock-note-btn" @click="unlock">解锁</button>
        </div>
        <div v-if="showCfgNote && !locked" class="cfg-note">
          此处的配置<b>支持手动编辑</b>，AI Agent 可随时读取最新内容；Agent 同样会动态
          <b>新增、删除、修改</b>这些配置 —— 一切以<b>最终生成的代码</b>为准。
        </div>
        <div class="fp-content" :class="{ locked }">
          <component :is="current" v-if="current" />
        </div>
      </div>
    </aside>
  </transition>
</template>
