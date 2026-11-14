<script setup>
/* 顶栏项目名（插件编辑页 + 家具包编辑页共用）：点一下复制项目 id。
 *
 * 纯 props 组件、不读 store —— 两类编辑页拿项目的方式不同（project store / S 兼容视图），
 * 由父组件把 name / id 传进来即可。反馈走 Element Plus 的 ElMessage，
 * 复制实现统一走 lib/clipboard（含 http 非 localhost 的兜底）。
 */
import { ref, computed, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import { copyText } from '../../lib/clipboard';

const props = defineProps({
  name: { type: String, default: '' },
  id: { type: String, default: '' },
});

const copied = ref(false);
let copiedTimer = 0;
const label = computed(() => (props.name ? props.name + '  (' + props.id + ')' : ''));

async function onCopy() {
  if (!props.id) return;
  const ok = await copyText(props.id);
  if (!ok) { ElMessage.error('复制失败，请手动选中标题里的 id'); return; }
  ElMessage.success('已复制项目 id：' + props.id);
  copied.value = true;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { copied.value = false; }, 1600);
}
onBeforeUnmount(() => clearTimeout(copiedTimer));
</script>

<template>
  <button type="button" class="proj-name" :class="{ copied }" :disabled="!id"
    :title="id ? '点击复制项目 id：' + id : '项目未加载'" @click="onCopy">
    <span class="proj-title-text">{{ label }}</span>
    <span class="proj-copy-hint">{{ copied ? '✓ 已复制' : '⧉ 复制 id' }}</span>
  </button>
</template>
