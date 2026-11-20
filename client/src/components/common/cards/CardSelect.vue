<template>
  <!-- 下拉单选（只读展示版）：_options 由引擎归一化成 [{value,label}]。
       原来用原生 <select> + @change 发 act；studio 卡片不反控，改成一块长得
       和下拉一样的静态文本，只显示当前选中项的 label。 -->
  <div class="dc-row dc-select" :class="{ dis: dis }">
    <span class="dc-label">{{ node.label || node.attr || '选项' }}</span>
    <span class="dc-select-val">{{ selectedLabel }}</span>
  </div>
</template>

<script>
export default {
  name: 'CardSelect',
  props: { node: { type: Object, required: true } },
  computed: {
    /* 只读预览：只有「实体不可用」才灰化 */
    dis() { return !!this.node._disabled; },
    selected() {
      const list = this.node._options || [];
      const v = this.node._value;
      if (v == null) return -1;
      return list.findIndex((o) => String(o.value) === String(v));
    },
    selectedLabel() {
      const o = (this.node._options || [])[this.selected];
      return o ? o.label : '--';
    },
  },
};
</script>

<style scoped>
.dc-row { min-width: 0; }
.dc-select { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
/* 统一尺度（2026-11-14）：静态下拉高 36px、字 13px，与动作按钮 / 胶囊同量级。 */
.dc-label { font-size: 13px; color: var(--ink2); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dc-select-val {
  min-width: 0; max-width: 100%; flex: 1; height: 36px; padding: 0 9px;
  line-height: 34px; border-radius: 10px;
  border: 1px solid #c9d7ea; background: var(--bg); color: var(--ink); font-size: 13px;
  box-shadow: 0 1px 3px rgba(31, 45, 71, .07);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dc-select.dis { opacity: .45; }
</style>
