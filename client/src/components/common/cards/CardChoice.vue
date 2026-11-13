<template>
  <!-- 选项组（choice）：select 的按钮组形态 —— option/options、attr、
       action/param 的取值与带值契约和 select 完全一致，只是 UI 从下拉换成
       分段控件（segmented）：浅灰蓝底槽里并排选项，当前值是白色浮起块。
       选项多时整组换行，不挤压标签。原生 button，不依赖 Element Plus。 -->
  <div class="dc-row dc-choice" :class="{ dis: dis }">
    <span class="dc-label" v-if="node.label">{{ node.label }}</span>
    <div class="seg-group" role="group">
      <button v-for="(o, i) in node._options" :key="i" type="button"
        class="seg-btn" :class="{ on: isActive(o) }" :disabled="dis"
        @click="pick(o)" @pointerdown.stop>{{ o.label }}</button>
    </div>
  </div>
</template>

<script>
export default {
  name: 'CardChoice',
  props: { node: { type: Object, required: true } },
  emits: ['act'],
  computed: {
    /* 与 CardSelect 同口径：没 action / 实体不可用都禁用 */
    dis() { return !!(this.node._disabled || !this.node.action); },
  },
  methods: {
    /* 值可能是数字 / 布尔，统一按字符串比对（引擎归一化选项时也是 String） */
    isActive(o) { return String(o.value) === String(this.node._value); },
    pick(o) {
      if (this.dis) return;
      this.$emit('act', this.node, o.value);
    },
  },
};
</script>

<style scoped>
.dc-row { min-width: 0; }
.dc-choice { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dc-label { font-size: 12px; color: var(--ink2); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: none; }
/* 分段控件外壳：浅灰蓝底槽 + 细边 + 小圆角（10px，与卡片/子卡同尺度，
   不要 999px —— 选项换行时胶囊会被拉成一条怪异的超长圆角条）。
   按钮内边距压紧，6 个两字选项（如空调的 自动/制冷/制热/除湿/送风/关闭）能在
   一排内放下，避免最后一个选项被挤到第二行、看着像独立控件。 */
.seg-group {
  display: flex; flex: 1 1 auto; min-width: 0; flex-wrap: wrap; gap: 2px;
  padding: 3px; border: 1px solid #e3eaf4; border-radius: 10px; background: #f2f5fa;
}
.seg-btn {
  flex: 1 1 auto; min-width: 0; height: 25px; padding: 0 7px;
  border: 1px solid transparent; border-radius: 7px;
  background: transparent; color: var(--ink2);
  font-size: 12px; line-height: 1; font-family: inherit; cursor: pointer;
  white-space: nowrap;
  transition: background .15s, color .15s, box-shadow .15s, border-color .15s;
}
.seg-btn:hover { background: #e9eff8; color: var(--ink); }
/* 选中 = 白色浮起块 + 蓝字（与工具栏/目录选中态同语言），不再用黑色实心 */
.seg-btn.on { background: #fff; border-color: #cddffb; color: var(--blue); font-weight: 600; box-shadow: 0 1px 3px rgba(31, 45, 71, .12); }
.seg-btn.on:hover { background: #fff; }
.seg-btn:focus-visible { outline: 2px solid var(--blue); outline-offset: 1px; }
.seg-btn:disabled { cursor: not-allowed; }
.dc-choice.dis { opacity: .45; }
</style>
