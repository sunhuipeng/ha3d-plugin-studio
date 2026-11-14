<template>
  <!-- 设备标题右侧的电源开关（只读展示版）。
       ⚠ 与 ha-3d-home 的同名组件不同源：studio 不接 HA，状态全由 props 注入。
       卡片只预览外观、不反控设备：纯 span 渲染，没有 click / emit act，
       原来的 fire() 合成动作节点与 readonly 分支一并删掉。 -->
  <span v-if="clickable" class="dc-power" :class="{ on: on }" title="只读预览：这里不会实际控制设备">
    <span class="dc-power-txt">{{ powerLabel }}</span>
    <span class="dc-power-dot"></span>
  </span>
</template>

<script>
export default {
  name: 'CardPowerToggle',
  props: {
    /* 主实体信息：只读展示不再需要，但容器层仍在透传，保留声明避免落到 DOM attr */
    eid: { type: String, default: '' },
    type: { type: String, default: '' },
    style: { type: [String, null], default: null },
    /* 以下三项是「注入」而非组件自己查：由编排层按插件 clickSpec + mock 状态算好 */
    clickable: { type: Boolean, default: false },
    on: { type: Boolean, default: false },
    /* click.label 拆出来的「开词 / 关词」 */
    words: { type: Array, default: () => ['开', '关'] },
    /* 保留字段兼容既有 power 注入对象；只读预览下恒不反控 */
    readonly: { type: Boolean, default: false },
  },
  computed: {
    _words() {
      const w = (this.words || []).filter((s) => s != null && String(s).length);
      return w.length > 1 ? [w[0], w[1]] : (w.length ? [w[0], w[0]] : ['开', '关']);
    },
    powerLabel() { return this.on ? this._words[0] : this._words[1]; },
  },
};
</script>

<style scoped>
/* 几何值与 ha-3d-home 的 CardPowerToggle 对齐（2026-11-14 统一尺度）：
   高 32px、字 12.5px、状态点 9px，同一套描边 + 轻投影语言；仍是 999px 胶囊。
   纯静态展示，无 hover / focus 反馈。 */
.dc-power {
  display: inline-flex; align-items: center; gap: 7px;
  height: 32px; padding: 0 13px; flex: none;
  border: 1px solid #c9d7ea; border-radius: 999px; background: #f8fafd;
  box-shadow: 0 1px 3px rgba(31, 45, 71, .08);
}
.dc-power-txt { font-size: 12.5px; color: var(--ink2); }
.dc-power-dot {
  width: 9px; height: 9px; border-radius: 50%; background: #c3cede; flex: none;
}
.dc-power.on { background: var(--blue-soft); border-color: #a8c8f7; box-shadow: 0 2px 7px rgba(59, 130, 246, .16); }
.dc-power.on .dc-power-txt { color: var(--blue); font-weight: 600; }
.dc-power.on .dc-power-dot { background: var(--blue); box-shadow: 0 0 0 3px rgba(41, 121, 255, .15); }
</style>
