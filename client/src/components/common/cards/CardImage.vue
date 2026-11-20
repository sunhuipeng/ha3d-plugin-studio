<template>
  <!-- 清扫地图（studio 只读预览）：与 home 的 CardImage 同一套视觉，但不连 HA。
       读 image 实体 attributes.entity_picture（mock 里是 data URL / 同源地址）直接显示。 -->
  <div class="dc-img" :class="{ dis: node._disabled }">
    <div class="dc-img-head" v-if="node.label">{{ node.label }}</div>
    <div class="dc-img-box">
      <img v-if="src" :src="src" :alt="node.label || '清扫地图'" @error="onError" />
      <div v-else class="dc-img-ph">{{ node._disabled ? '地图不可用' : '暂无地图' }}</div>
    </div>
  </div>
</template>

<script>
export default {
  name: 'CardImage',
  props: { node: { type: Object, required: true } },
  data() { return { failed: false }; },
  computed: {
    src() {
      if (this.failed || this.node._disabled) return '';
      const pic = this.node._value;
      if (!pic || typeof pic !== 'string') return '';
      return pic;   // mock 里给的是 data URL / 同源地址，直接用
    },
  },
  watch: {
    'node._value'() { this.failed = false; },
  },
  methods: {
    onError() { this.failed = true; },
  },
};
</script>

<style scoped>
.dc-img { min-width: 0; }
.dc-img.dis { opacity: .6; }
.dc-img-head { font-size: 13px; color: var(--ink2); margin-bottom: 6px; }
.dc-img-box {
  position: relative; width: 100%; aspect-ratio: 4 / 3; max-height: 320px;
  border-radius: 8px; overflow: hidden; background: #eef1f5;
  border: 1px solid rgba(30, 40, 60, .08);
}
.dc-img-box img { display: block; width: 100%; height: 100%; object-fit: contain; }
.dc-img-ph {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 12px; color: var(--ink2);
}
</style>
