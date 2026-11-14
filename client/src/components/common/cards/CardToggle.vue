<template>
  <!-- 开关控件（只读展示版）：switch / bool 共用同一枚胶囊，左边文字、右边状态圆点。
       状态由引擎算好的 node._on 给（switch 走 isOn 判定，bool 取 attr 的布尔值）。
       studio 卡片只预览外观、不反控设备：纯 div 渲染，没有 click / emit act。 -->
  <div class="dc-chip" :class="{ on: node._on, dis: dis }" :title="node._title || caption">
    <span class="dc-chip-name">{{ caption }}</span>
    <span class="dc-chip-dot"></span>
  </div>
</template>

<script>
export default {
  name: 'CardToggle',
  props: {
    node: { type: Object, required: true },
    /* 容器层可覆盖显示文字：single 平铺时显示设备名，而不是控件自己的 label */
    text: { type: String, default: '' },
  },
  computed: {
    caption() { return this.text || this.node.label || '开 / 关'; },
    /* 只读预览：只有「实体不可用」才灰化 */
    dis() { return !!this.node._disabled; },
  },
};
</script>

<style scoped>
/* 所有 switch / bool 统一成这一枚胶囊（只读展示，无 hover / 点击反馈）。
   几何值与 ha-3d-home 的 CardToggle 逐项对齐（2026-11-14 统一尺度）：
   高 46px、圆角 14px、字 13.5px、状态点 10px，加深描边 + 轻投影避免融进白色子卡。
   开态换蓝底蓝字蓝点；实体不可用时降透明度。改 home 那份时这里要同步。 */
.dc-chip {
  display: flex; align-items: center; gap: 8px;
  width: 100%; min-width: 0; height: 46px; padding: 0 15px;
  border: 1px solid #c9d7ea; border-radius: 14px; background: #f8fafd;
  box-shadow: 0 1px 4px rgba(31, 45, 71, .09), 0 1px 0 rgba(255, 255, 255, .8) inset;
  text-align: left;
}
.dc-chip-name {
  flex: 1; min-width: 0; font-size: 13.5px; color: var(--ink2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dc-chip-dot {
  width: 10px; height: 10px; border-radius: 50%; flex: none;
  background: #b9c8dc;
}
.dc-chip.on { background: var(--blue-soft); border-color: #a8c8f7; box-shadow: 0 2px 8px rgba(59, 130, 246, .18); }
.dc-chip.on .dc-chip-name { color: var(--blue); font-weight: 600; }
.dc-chip.on .dc-chip-dot { background: var(--blue); box-shadow: 0 0 0 3px rgba(59, 130, 246, .16); }
.dc-chip.dis { opacity: .45; }
</style>
