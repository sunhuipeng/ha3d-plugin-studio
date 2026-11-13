<template>
  <!-- 开关控件：switch（state on/off，action 是一次性服务）与 bool（布尔属性，点一下取反）共用。
       两种位置都用同一个胶囊：左边文字、右边状态圆点，整块就是点击区域。
       · group 内的一行 → 显示 node.label（如「开关」「摆头」）
       · single 平铺的格子 → 由容器层传入设备名（node._title）
       状态由引擎算好的 node._on 给（switch 走 isOn 判定，bool 取 attr 的布尔值）。 -->
  <button class="dc-chip" :class="{ on: node._on, dis: dis }"
    :disabled="dis" :title="node._title || caption" @click.stop="fire">
    <span class="dc-chip-name">{{ caption }}</span>
    <span class="dc-chip-dot"></span>
  </button>
</template>

<script>
export default {
  name: 'CardToggle',
  props: {
    node: { type: Object, required: true },
    /* 容器层可覆盖显示文字：single 平铺时显示设备名，而不是控件自己的 label */
    text: { type: String, default: '' },
  },
  emits: ['act'],
  computed: {
    caption() { return this.text || this.node.label || '开 / 关'; },
    /* 没写 action 就是纯显示，不给点 */
    dis() { return !!(this.node._disabled || !this.node.action); },
  },
  methods: {
    fire() {
      if (this.dis) return;
      /* bool 把取反后的值交给引擎写进 service_data；switch 不给值 */
      this.$emit('act', this.node, this.node.type === 'bool' ? !this.node._on : undefined);
    },
  },
};
</script>

<style scoped>
/* 所有 switch / bool 统一成这一枚胶囊：浅底 + 细边 + 大圆角 + 右侧状态点。
   开态换蓝底蓝字蓝点，关态保持中性灰蓝；禁用降透明度并禁止点击。 */
.dc-chip {
  display: flex; align-items: center; gap: 7px;
  width: 100%; min-width: 0; height: 34px; padding: 0 14px;
  border: 1px solid #dfe7f4; border-radius: 999px; background: #f7f9fd;
  text-align: left; transition: background .16s, border-color .16s, box-shadow .16s;
}
.dc-chip:hover:not(.dis) { border-color: #c3cede; background: #f2f6fc; }
.dc-chip:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.dc-chip-name {
  flex: 1; min-width: 0; font-size: 12px; color: var(--ink2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dc-chip-dot {
  width: 8px; height: 8px; border-radius: 50%; flex: none;
  background: #b9c8dc; transition: background .16s, box-shadow .16s;
}
.dc-chip.on { background: var(--blue-soft); border-color: #b7d3fb; }
.dc-chip.on:hover:not(.dis) { background: #dfeafd; }
.dc-chip.on .dc-chip-name { color: var(--blue); font-weight: 600; }
.dc-chip.on .dc-chip-dot { background: var(--blue); box-shadow: 0 0 0 3px rgba(59, 130, 246, .16); }
.dc-chip.dis { opacity: .45; cursor: not-allowed; }
</style>
