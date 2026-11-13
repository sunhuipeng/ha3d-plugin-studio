<template>
  <!-- 一次性动作按钮：只由 type: 'button' 的控件渲染（引擎 COMPONENTS 一一对应）。
       服务名 / 参数 / 目标实体全在插件声明里，按钮只负责 emit。
       没写 action 时与 CardToggle 一致禁用，避免出一个点不动的假按钮。 -->
  <button class="dc-btn" :disabled="node._disabled || !node.action" @click.stop="$emit('act', node)">
    {{ node.label || '执行' }}
  </button>
</template>

<script>
export default {
  name: 'CardButton',
  props: { node: { type: Object, required: true } },
  emits: ['act'],
};
</script>

<style scoped>
.dc-btn {
  width: 100%; min-width: 0; height: 28px; padding: 0 4px; border-radius: 8px;
  background: var(--bg); border: 1px solid var(--line);
  font-size: 12px; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: background .14s, border-color .14s;
}
.dc-btn:hover { background: var(--blue-soft); border-color: #c7ddfb; color: #1d4ed8; }
.dc-btn:active { transform: translateY(1px); }
.dc-btn:disabled { opacity: .45; cursor: not-allowed; }
</style>
