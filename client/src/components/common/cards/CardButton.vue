<template>
  <!-- 一次性动作按钮（只读展示版）：只由 type: 'button' 的控件渲染。
       服务名 / 参数 / 目标实体全在插件声明里；studio 卡片只预览外观，
       所以这里是一块长得像按钮的静态文本，不点击、不 emit act。 -->
  <div class="dc-btn" :class="{ dis: node._disabled }">
    {{ node.label || '执行' }}
  </div>
</template>

<script>
export default {
  name: 'CardButton',
  props: { node: { type: Object, required: true } },
};
</script>

<style scoped>
/* 几何值与 ha-3d-home 的 CardButton 对齐（2026-11-14 统一尺度）：
   高 36px、圆角 10px、字 13px，同一套描边 / 投影语言。纯静态，无 hover 反馈。 */
.dc-btn {
  display: flex; align-items: center; justify-content: center;
  width: 100%; min-width: 0; height: 36px; padding: 0 8px; border-radius: 10px;
  background: var(--bg); border: 1px solid #c9d7ea;
  box-shadow: 0 1px 3px rgba(31, 45, 71, .07);
  font-size: 13px; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dc-btn.dis { opacity: .45; }
</style>
