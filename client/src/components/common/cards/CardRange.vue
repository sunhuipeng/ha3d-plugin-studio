<template>
  <!-- 滑块：本地 draft 优先（HA 回推有 300ms~1s 延迟，直接读服务端值会「拖到 60 → 跳回 30 → 再跳回 60」）。
       规则：input 只改 draft 并 180ms 节流发服务；松手（change）必须补发一次；发出后 1.2s 内 draft 优先。
       没写 action 时是纯显示，不发服务。 -->
  <div class="dc-row dc-range" :class="{ dis: dis }">
    <span class="dc-label">{{ node.label || node.attr || '数值' }}</span>
    <span class="dc-val">{{ shownText }}<i v-if="node.unit">{{ node.unit }}</i></span>
    <input type="range" :min="node._min" :max="node._max" :step="node._step || 1"
      :value="shown" :disabled="dis"
      @input="onInput" @change="onChange" @pointerdown.stop @wheel.stop />
  </div>
</template>

<script>
export default {
  name: 'CardRange',
  props: { node: { type: Object, required: true } },
  emits: ['act'],
  data() {
    return { draft: null, dragging: false, pending: false };
  },
  computed: {
    dis() { return !!(this.node._disabled || !this.node.action); },
    /* 拖动中 / 刚发出还没回推 → 用本地值；否则用服务端值。
     * 注意 draft 可能被 watch 清空，这里必须判 null —— 否则 `:value` 拿到 null，
     * 浏览器会把滑块画成量程中点（50），看起来像「值自己跳到 50」。 */
    shown() {
      if ((this.dragging || this.pending) && this.draft != null) return this.draft;
      const v = this.node._value;
      return v == null ? this.node._min : v;
    },
    /* 显示精度跟着 step 走（0.5 的温控不能显示成 24.0000001） */
    scalePow() {
      const s = Number(this.node._step) || 1;
      return s < 1 ? 2 : 0;
    },
    shownText() {
      const v = Number(this.shown);
      if (!isFinite(v)) return String(this.shown);
      return String(Number(v.toFixed(this.scalePow)));
    },
  },
  watch: {
    /* 外部值变了（HA 回推 / 换设备）→ 丢掉本地草稿；pending 窗口内不动，
     * 否则「松手 → 清 draft → 渲染 null → 跳到中点」 */
    'node._value'() { if (!this.dragging && !this.pending) this.draft = null; },
  },
  beforeUnmount() { clearTimeout(this.sendTimer); clearTimeout(this.pendTimer); },
  methods: {
    onInput(e) {
      this.draft = Number(e.target.value);
      this.dragging = true;
      clearTimeout(this.sendTimer);
      this.sendTimer = setTimeout(() => this.flush(), 180);
    },
    onChange() {
      this.dragging = false;
      clearTimeout(this.sendTimer);
      this.flush();          // 松手补发，否则最后一次值丢掉
    },
    flush() {
      if (this.draft == null || this.dis) return;
      this.pending = true;
      this.$emit('act', this.node, Number(this.draft.toFixed(this.scalePow)));
      clearTimeout(this.pendTimer);
      this.pendTimer = setTimeout(() => {
        this.pending = false;
        this.draft = null;   // 交回服务端值；若服务端没接受，会如实跳回
      }, 1200);
    },
  },
};
</script>

<style scoped>
.dc-row { min-width: 0; }
.dc-range { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 2px 8px; }
.dc-label { font-size: 12px; color: var(--ink2); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dc-val { font-size: 12px; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }
.dc-val i { font-size: 10px; color: var(--ink2); font-style: normal; margin-left: 1px; }
.dc-range input[type="range"] {
  grid-column: 1 / -1; width: 100%; height: 18px; -webkit-appearance: none; appearance: none; background: none;
}
.dc-range input[type="range"]::-webkit-slider-runnable-track {
  height: 4px; border-radius: 999px; background: #e3e9f2;
}
.dc-range input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%;
  background: var(--blue); border: 2px solid #fff; box-shadow: 0 1px 4px rgba(59,130,246,.45);
  margin-top: -5px;
}
.dc-range.dis { opacity: .45; }
</style>
