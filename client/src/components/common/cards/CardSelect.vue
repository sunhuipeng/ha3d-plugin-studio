<template>
  <!-- 下拉单选：_options 由引擎归一化成 [{value,label}]（插件可写静态中文表，也可写 'attr:source_list'）。
       用下标做 option 的 value，回传时还原原始值 —— 这样 option 里的布尔 / 数字不会被转成字符串。 -->
  <div class="dc-row dc-select" :class="{ dis: dis }">
    <span class="dc-label">{{ node.label || node.attr || '选项' }}</span>
    <select :value="selected" :disabled="dis" @change="onChange" @pointerdown.stop @wheel.stop>
      <option v-if="selected < 0" value="-1" disabled>--</option>
      <option v-for="(o, i) in node._options" :key="i" :value="i">{{ o.label }}</option>
    </select>
  </div>
</template>

<script>
export default {
  name: 'CardSelect',
  props: { node: { type: Object, required: true } },
  emits: ['act'],
  computed: {
    dis() { return !!(this.node._disabled || !this.node.action); },
    selected() {
      const list = this.node._options || [];
      const v = this.node._value;
      if (v == null) return -1;
      return list.findIndex((o) => String(o.value) === String(v));
    },
  },
  methods: {
    onChange(e) {
      const o = (this.node._options || [])[Number(e.target.value)];
      if (o) this.$emit('act', this.node, o.value);
    },
  },
};
</script>

<style scoped>
.dc-row { min-width: 0; }
.dc-select { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.dc-label { font-size: 12px; color: var(--ink2); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
select {
  min-width: 0; max-width: 100%; flex: 1; padding: 4px 8px; border-radius: 7px;
  border: 1px solid var(--line); background: var(--bg); color: var(--ink); font-size: 12px; outline: none;
}
select:focus { border-color: var(--blue); background: #fff; }
.dc-select.dis { opacity: .45; }
</style>
