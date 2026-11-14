<template>
  <!-- 设备卡的控件渲染器：只按 node.rows 排版（每个子数组一行，总 4 列）。
       type → 用哪个组件由引擎（CardEngine.componentOf）决定，占几列由引擎算好的 _span 决定。
       纯展示：不读 store、不调 HA、不 emit act —— studio 卡片只预览外观，不反控设备。 -->
  <div class="dc-lines">
    <div class="dc-line" v-for="(row, ri) in node.rows" :key="ri">
      <div v-for="(c, ci) in row" :key="key(c, ci)" class="dc-cell"
        :style="{ gridColumn: 'span ' + (c._span || 4) }">
        <component v-if="comp(c)" :is="comp(c)" :node="c" />
      </div>
    </div>
  </div>
</template>

<script>
import { CardEngine } from '../../../engine/cards.js';
import CardToggle from './CardToggle.vue';
import CardRange from './CardRange.vue';
import CardSelect from './CardSelect.vue';
import CardChoice from './CardChoice.vue';
import CardButton from './CardButton.vue';
import CardReadonly from './CardReadonly.vue';

const COMPONENTS = { CardToggle, CardRange, CardSelect, CardChoice, CardButton, CardReadonly };

export default {
  name: 'CardGroup',
  props: {
    node: { type: Object, required: true },
  },
  methods: {
    comp(c) { return COMPONENTS[CardEngine.componentOf(c)] || null; },
    /* key 用「类型 + 实体 + 属性 + 下标」：结构不变时不会因为值变化而重建控件，
     * 否则值刷新时整块被卸载重挂，视觉会闪一下。 */
    key(c, i) { return (c.type || 'x') + '|' + (c._eid || c.label || '') + '|' + (c.attr || '') + '|' + i; },
  },
};
</script>

<style scoped>
.dc-lines { display: flex; flex-direction: column; gap: 9px; }
.dc-line { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; align-items: center; }
.dc-cell { min-width: 0; }
</style>
