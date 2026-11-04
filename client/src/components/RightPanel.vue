<script setup>
/* 浮层容器：只负责浮层外壳（定位 / 宽度 / 动画），内容按 tab 拆到 panels/*.vue */
import { computed } from 'vue';
import { S } from '../store';
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
</script>

<template>
  <transition name="fp">
    <aside id="float-panel" v-if="S.panel && S.proj" :style="{ width: panelWidth }">
      <div class="fp-body">
        <component :is="current" v-if="current" />
      </div>
    </aside>
  </transition>
</template>
