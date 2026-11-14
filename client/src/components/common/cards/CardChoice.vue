<template>
  <!-- 选项组 / choice（只读展示版）：与 ha-3d-home 同一套分段控件视觉 ——
       浅灰蓝底槽里并排选项，当前值是白色浮起块，选项多时整组换行。
       studio 卡片只预览外观、不反控设备：这里用纯 span 渲染，没有 button / click /
       pointer / emit act，也不引入 home 那套窄屏滑动与预选态（那是反控用的）。
       ⚠ 引擎侧 action / param 契约仍由 engine/cards.js 归一，不要改。 -->
  <div class="dc-row dc-choice" :class="{ dis: dis }">
    <span class="dc-label" v-if="node.label">{{ node.label }}</span>
    <div class="seg-group" role="group">
      <span v-for="(o, i) in node._options" :key="i"
        class="seg-btn" :class="{ on: isActive(o) }">{{ o.label }}</span>
    </div>
  </div>
</template>

<script>
export default {
  name: 'CardChoice',
  props: { node: { type: Object, required: true } },
  computed: {
    /* 只读预览：只有「实体不可用」才灰化 */
    dis() { return !!this.node._disabled; },
  },
  methods: {
    /* 值可能是数字 / 布尔，统一按字符串比对（引擎归一化选项时也是 String） */
    isActive(o) { return String(o.value) === String(this.node._value); },
  },
};
</script>

<style scoped>
.dc-row { min-width: 0; }
.dc-choice { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dc-label { font-size: 13px; color: var(--ink2); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: none; }
/* 几何值与 ha-3d-home 的 CardChoice 对齐（2026-11-14 统一尺度）：选项高 30px、
   槽圆角 12px、内边距 4px、字 13px；字号再大会把 6 个两字选项挤到第二行。 */
.seg-group {
  display: flex; flex: 1 1 auto; min-width: 0; flex-wrap: wrap; gap: 2px;
  padding: 4px; border: 1px solid #d6e1f0; border-radius: 12px; background: #f2f5fa;
}
.seg-btn {
  display: flex; align-items: center; justify-content: center;
  flex: 1 1 auto; min-width: 0; height: 30px; padding: 0 7px;
  border: 1px solid transparent; border-radius: 9px;
  background: transparent; color: var(--ink2);
  font-size: 13px; line-height: 1; font-family: inherit;
  white-space: nowrap;
}
/* 选中 = 白色浮起块 + 蓝字（与工具栏/目录选中态同语言） */
.seg-btn.on { background: #fff; border-color: #cddffb; color: var(--blue); font-weight: 600; box-shadow: 0 2px 5px rgba(31, 45, 71, .14); }
.dc-choice.dis { opacity: .45; }
</style>
