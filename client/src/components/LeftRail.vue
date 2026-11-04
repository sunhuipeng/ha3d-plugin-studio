<script setup>
/* 左侧竖排操作栏: 图标+文字+快捷键，分组排列，点击或按快捷键开关对应浮层面板 */
import { onMounted, onBeforeUnmount } from 'vue';
import { Operation, Box, Brush, PriceTag, Document, EditPen } from '@element-plus/icons-vue';
import { S } from '../store';

const groups = [
  [{ id: 'settings', label: '属性', icon: Operation, key: 'A' },
    { id: 'fields', label: '字段', icon: PriceTag, key: 'F' },
    { id: 'styles', label: '样式', icon: Brush, key: 'Y' },
    { id: 'parts', label: '部件', icon: Box, key: 'P' },
  ],
  [
    { id: 'prompt', label: '提示词', icon: EditPen, key: 'T' },
    { id: 'code', label: '代码', icon: Document, key: 'C' },
  ]
];

const KEY_MAP = Object.fromEntries(groups.flat().map((it) => [it.key, it]));

function toggle(id) { S.panel = S.panel === id ? null : id; }

/* 点击浮层外的区域 → 关闭浮层（图标栏的激活态同源，一起取消）。
   Element Plus 的下拉/弹窗都 teleport 到 body，命中了要放行，否则会被误判成「外部」。 */
const KEEP = [
  '#rail', '#float-panel',
  '.el-popper', '.el-select__popper', '.el-overlay', '.el-message-box', '.el-message', '.el-notification',
].join(',');

function onDocDown(e) {
  if (!S.panel) return;
  const t = e.target;
  if (t && t.closest && t.closest(KEEP)) return;
  S.panel = null;
  S.previewFile = '';
}

function onKeydown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  const it = KEY_MAP[e.key.toUpperCase()];
  if (it) { e.preventDefault(); toggle(it.id); }
  else if (e.key === 'Escape') {
    /* 先取消模型预览高亮，都没有时再关闭整个浮层 */
    if (S.previewFile) S.previewFile = '';
    else if (S.panel) S.panel = null;
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  /* 捕获阶段监听：场景/画布里的库若 stopPropagation 也不影响判定 */
  window.addEventListener('pointerdown', onDocDown, true);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('pointerdown', onDocDown, true);
});
</script>

<template>
  <nav id="rail">
    <template v-for="(g, gi) in groups" :key="gi">
      <div v-if="gi" class="rail-sep"></div>
      <button v-for="it in g" :key="it.id" class="rail-item" :class="{ on: S.panel === it.id }"
        :title="it.label + '（快捷键 ' + it.key + '）'" @click="toggle(it.id)">
        <span class="rail-icon">
          <el-icon :size="18"><component :is="it.icon" /></el-icon>
          <span class="rail-key">{{ it.key }}</span>
        </span>
        <span class="rail-label">{{ it.label }}</span>
      </button>
    </template>
  </nav>
</template>

<style scoped>
#rail {
  width: 62px; min-width: 62px; background: var(--bg2);
  border-right: 1px solid var(--line);
  display: flex; flex-direction: column; align-items: center;
  padding: 10px 0; gap: 2px; overflow-y: auto;
}
.rail-sep { width: 34px; height: 1px; background: var(--line); margin: 8px 0; flex: none; }
.rail-item {
  width: 52px; padding: 7px 0 5px; flex: none; position: relative;
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  background: none; border: none; border-radius: 8px; cursor: pointer;
  color: var(--fg-dim); font: inherit;
}
.rail-item:hover { background: var(--bg3); color: var(--fg); }
.rail-item.on { background: #e8f1fc; color: var(--accent); }
.rail-icon { position: relative; display: inline-flex; }
.rail-key {
  position: absolute; top: -3px; right: -9px;
  font-size: 9px; line-height: 1; color: var(--fg-dim); opacity: .85;
  font-family: ui-monospace, Menlo, monospace;
}
.rail-item.on .rail-key { color: var(--accent); }
.rail-label { font-size: 11px; line-height: 1; white-space: nowrap; }
</style>
