<script setup>
/* 模型缩略图: 用共享离屏 renderer 加载 GLB 渲染成 dataURL；传 node 时只渲染该节点 */
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { modelThumbUrl, cachedThumb, isThumbError, nodeThumbUrl, cachedNodeThumb, isNodeThumbError } from '../thumb';

const props = defineProps({ projId: String, file: String, node: { type: String, default: '' } });
const url = ref('');
const failed = ref(false);
let timer = null;

const key = () => props.projId + '/' + props.file + (props.node ? '#' + props.node : '');
function refresh() {
  if (props.node) {
    failed.value = isNodeThumbError(props.projId, props.file, props.node);
    url.value = cachedNodeThumb(props.projId, props.file, props.node);
    if (!url.value && !failed.value) {
      nodeThumbUrl(props.projId, props.file, props.node);
      clearTimeout(timer);
      timer = setTimeout(refresh, 400);
    }
  } else {
    failed.value = isThumbError(props.projId, props.file);
    url.value = cachedThumb(props.projId, props.file);
    if (!url.value && !failed.value) {
      modelThumbUrl(props.projId, props.file);
      clearTimeout(timer);
      timer = setTimeout(refresh, 400);   // 加载中轮询，完成后 cachedThumb 会有值
    }
  }
}
function onThumb(e) { if (e.detail === key()) refresh(); }

onMounted(() => {
  refresh();
  window.addEventListener('model-thumb', onThumb);
  window.addEventListener('node-thumb', onThumb);
});
onBeforeUnmount(() => { clearTimeout(timer); window.removeEventListener('model-thumb', onThumb); window.removeEventListener('node-thumb', onThumb); });
</script>

<template>
  <span class="pthumb" :class="{ bad: failed }">
    <img v-if="url" :src="url" alt="">
    <span v-else-if="failed" class="pthumb-bad">✕</span>
    <span v-else class="pthumb-loading">…</span>
  </span>
</template>

<style scoped>
.pthumb {
  width: 44px; height: 44px; flex: none; border-radius: 6px;
  border: 1px solid var(--line); background: #f2f4f8;
  display: flex; align-items: center; justify-content: center; overflow: hidden;
}
.pthumb img { width: 100%; height: 100%; object-fit: contain; }
.pthumb-loading { color: var(--fg-dim); font-size: 12px; }
.pthumb.bad { background: #f4e4e2; }
.pthumb-bad { color: #b04a4a; font-size: 12px; }
</style>
