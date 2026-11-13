<template>
  <!-- 设备标题右侧的电源开关。
       ⚠ 与 ha-3d-home 的同名组件**不同源**：home 版直接读 window.PluginEngine /
       window.HA / useHaStore().entityVersion；studio 不接 HA，全部改由 props 注入
       （路线 A），组件只负责展示与 emit，状态与动作由外层编排层提供。
       · clickable / on / words 由卡片预览层算好并随 entityVersion 刷新
       · readonly = 只读预览（studio 默认）：保留外观，点击不发动作 -->
  <button v-if="clickable" class="dc-power" :class="{ on: on }" type="button"
    :title="powerTitle" @click.stop="fire">
    <span class="dc-power-txt">{{ powerLabel }}</span>
    <span class="dc-power-dot"></span>
  </button>
</template>

<script>
export default {
  name: 'CardPowerToggle',
  props: {
    /* 主实体信息：仅用于 emit 出去的动作节点，组件自身不读任何状态 */
    eid: { type: String, default: '' },
    type: { type: String, default: '' },
    style: { type: [String, null], default: null },
    /* 以下三项是「注入」而非组件自己查：由编排层按插件 clickSpec + mock 状态算好 */
    clickable: { type: Boolean, default: false },
    on: { type: Boolean, default: false },
    /* click.label 拆出来的「开词 / 关词」 */
    words: { type: Array, default: () => ['开', '关'] },
    /* 只读预览：标题提示「不会控制设备」，点击不 emit */
    readonly: { type: Boolean, default: false },
  },
  emits: ['act'],
  computed: {
    _words() {
      const w = (this.words || []).filter((s) => s != null && String(s).length);
      return w.length > 1 ? [w[0], w[1]] : (w.length ? [w[0], w[0]] : ['开', '关']);
    },
    powerLabel() { return this.on ? this._words[0] : this._words[1]; },
    powerTitle() {
      if (this.readonly) return '只读预览：这里不会实际控制设备';
      return this.on ? ('点击' + this._words[1]) : ('点击' + this._words[0]);
    },
  },
  methods: {
    fire() {
      if (this.readonly) return;
      /* 合成一个轻量动作节点，交给上层（home 里由 HA.toggle 消费）。
         studio 只读预览下不会走到这里，保留接口只是为了将来接真 HA 时不用改组件。 */
      this.$emit('act', {
        _powerToggle: true, _eid: this.eid, action: 'toggle',
        type: this.type, style: this.style, on: this.on,
      });
    },
  },
};
</script>

<style scoped>
.dc-power {
  display: inline-flex; align-items: center; gap: 6px;
  height: 26px; padding: 0 11px; flex: none;
  border: 1px solid #dfe7f4; border-radius: 999px; background: #f7f9fd;
  cursor: pointer; transition: background .16s, border-color .16s;
}
.dc-power:hover { border-color: #c3cede; background: #f2f6fc; }
.dc-power:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.dc-power-txt { font-size: 12px; color: var(--ink2); transition: color .16s; }
.dc-power-dot {
  width: 8px; height: 8px; border-radius: 50%; background: #c3cede; flex: none;
  transition: background .16s, box-shadow .16s;
}
.dc-power.on { background: var(--blue-soft); border-color: #b7d3fb; }
.dc-power.on .dc-power-txt { color: var(--blue); font-weight: 600; }
.dc-power.on .dc-power-dot { background: var(--blue); box-shadow: 0 0 0 3px rgba(41, 121, 255, .15); }
</style>
