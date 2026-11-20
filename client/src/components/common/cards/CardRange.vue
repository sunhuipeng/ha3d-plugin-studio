<template>
  <!-- 滑块（只读展示版）：studio 卡片只预览外观，不反控设备。
       与 ha-3d-home 的自绘 range 同一套视觉：20px 圆角胶囊轨道，左段主题蓝描边 +
       淡色填充，右段灰轨，20×30 竖向椭圆把手。这里没有 pointer / input / change，
       也不 emit act —— 把手位置只由 node._value 算出来，纯静态。
       ⚠ 引擎侧 engine/cards.js 与 home 逐字同源，不要改；这里只管渲染。 -->
  <div class="dc-row dc-range" :class="{ dis: dis }">
    <span class="dc-label">{{ node.label || node.attr || '数值' }}</span>
    <span class="dc-val">{{ shownText }}<i v-if="node.unit">{{ node.unit }}</i></span>
    <div class="dc-slider" role="slider" aria-readonly="true"
      :aria-label="node.label || node.attr || '数值'"
      :aria-valuemin="node._min" :aria-valuemax="node._max" :aria-valuenow="Number(shown)"
      :aria-valuetext="shownText + (node.unit || '')" :aria-disabled="dis ? 'true' : 'false'">
      <div class="dc-inner">
        <div class="dc-track"></div>
        <div class="dc-fill" :style="fillStyle"></div>
        <div class="dc-thumb" :style="{ left: pct }"></div>
      </div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'CardRange',
  props: { node: { type: Object, required: true } },
  computed: {
    /* 只读预览：只有「实体不可用」才灰化。不再因「没写 action」禁用 ——
       这里不反控，action 字段与展示无关。 */
    dis() { return !!this.node._disabled; },
    shown() {
      const v = this.node._value;
      return v == null ? this.node._min : v;
    },
    scalePow() {
      const s = Number(this.node._step) || 1;
      return s < 1 ? 2 : 0;
    },
    shownText() {
      const v = Number(this.shown);
      if (!isFinite(v)) return String(this.shown);
      return String(Number(v.toFixed(this.scalePow)));
    },
    ratio() {
      const min = Number(this.node._min), max = Number(this.node._max);
      const v = Number(this.shown);
      if (!isFinite(min) || !isFinite(max) || max <= min || !isFinite(v)) return 0;
      return Math.min(1, Math.max(0, (v - min) / (max - min)));
    },
    pct() { return (this.ratio * 100).toFixed(3) + '%'; },
    /* 左段填充：ratio=0 时整块隐藏，否则 0 宽度的边框会画出一个小竖条 */
    fillStyle() { return { width: this.pct, opacity: this.ratio > 0 ? 1 : 0 }; },
  },
};
</script>

<style scoped>
.dc-row { min-width: 0; }
.dc-range { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 2px 8px; }
/* 文字尺度与 home 对齐（13px）。轨道 20px / 把手 20×30 保持上一轮定稿不动 ——
   它与 CSS 的 .dc-inner 内缩 10px 绑定，改了会脱钩。 */
.dc-label { font-size: 13px; color: var(--ink2); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dc-val { font-size: 13px; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }
.dc-val i { font-size: 11px; color: var(--ink2); font-style: normal; margin-left: 1px; }
.dc-slider { grid-column: 1 / -1; position: relative; width: 100%; height: 34px; }
/* 轨道两端内缩 10px（= 把手半宽），把手在端点也不会画出卡片外 */
.dc-inner { position: absolute; left: 10px; right: 10px; top: 50%; height: 20px; transform: translateY(-50%); }
/* 右半段 / 整条底轨：中性灰 */
.dc-track {
  position: absolute; inset: 0; z-index: 0; box-sizing: border-box;
  border: 1.5px solid #dbe4f0; border-radius: 999px;
  background: rgba(255, 255, 255, .6);
}
/* 左侧已选段：主题色描边 + 淡色填充 */
.dc-fill {
  position: absolute; left: 0; top: 0; bottom: 0; z-index: 1; box-sizing: border-box;
  border: 1.5px solid var(--blue); border-radius: 999px;
  background: rgba(59, 130, 246, .14);
}
/* 竖向椭圆把手：比轨道高，白底 + 蓝描边 */
.dc-thumb {
  position: absolute; top: 50%; z-index: 2; box-sizing: border-box;
  width: 20px; height: 30px; border-radius: 999px;
  background: #fff; border: 2px solid var(--blue); box-shadow: 0 1px 5px rgba(59, 130, 246, .25);
  transform: translate(-50%, -50%);
}
.dc-range.dis { opacity: .45; }
</style>
