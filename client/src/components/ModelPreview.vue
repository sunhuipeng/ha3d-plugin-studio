<script setup>
/* 大图模型预览: 可拖拽旋转/滚轮缩放的迷你 3D 视口 + 模型信息 + 材质修复 */
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { modelUrl } from '../thumb';
import { frameObject } from '../engine/frame';
import { applyLegacyRenderer } from '../engine/three-legacy';

const props = defineProps({ projId: String, file: String, node: { type: String, default: '' }, fixing: Boolean });
const emit = defineEmits(['fix']);
const wrap = ref(null);
const info = ref(null);      // { meshes, vertices, size: [x,y,z] }
const loading = ref(false);
const failed = ref(false);

let renderer = null, scene = null, camera = null, controls = null, current = null;

function init() {
  const el = wrap.value;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  applyLegacyRenderer(renderer);   // 与主视口 / home 同口径（见 engine/three-legacy.js）
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  el.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  /* 渲染器已是 legacy 灯光口径（×PI），这里按物理光原值 ÷PI 换算，观感不变 */
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa4b2, 0.37));
  const d = new THREE.DirectionalLight(0xffffff, 0.25);
  d.position.set(3, 5, 4);
  scene.add(d);
  camera = new THREE.PerspectiveCamera(40, 1, 0.001, 500);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  resize();
  loop();
}
function resize() {
  if (!wrap.value || !renderer) return;
  const w = wrap.value.clientWidth || 1, h = wrap.value.clientHeight || 1;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
function loop() {
  requestAnimationFrame(loop);
  if (controls) controls.update();
  if (renderer && scene) renderer.render(scene, camera);
}
function clearModel() {
  if (current && scene) { scene.remove(current); current = null; }
}
function load() {
  clearModel(); info.value = null; failed.value = false;
  if (!props.file) return;
  loading.value = true;
  const url = modelUrl(props.projId, props.file);
  new GLTFLoader().load(url, (gltf) => {
    loading.value = false;
    clearModel();
    /* node 非空时只显示该节点子树（从场景里摘出来单独放） */
    let target = gltf.scene;
    if (props.node) {
      const o = gltf.scene.getObjectByName(props.node);
      if (!o) { failed.value = true; return; }
      o.removeFromParent();
      target = o;
    }
    current = target;
    scene.add(current);
    /* 取景公式与缩略图同源（engine/frame.js）；这里系数略放远，留出可拖拽旋转的余量 */
    const { size, center, maxDim, camPos } = frameObject(new THREE.Box3().setFromObject(current), {
      fov: 40, padding: 1.7, dir: { x: 0.65, y: 0.5, z: 0.75 },
    });
    controls.target.copy(center);
    camera.position.copy(camPos);
    camera.near = maxDim / 100; camera.far = maxDim * 20; camera.updateProjectionMatrix();
    let meshes = 0, vertices = 0;
    current.traverse((o) => {
      if (o.isMesh) { meshes++; if (o.geometry?.attributes?.position) vertices += o.geometry.attributes.position.count; }
    });
    info.value = { meshes, vertices, size: [size.x, size.y, size.z] };
  }, undefined, () => { loading.value = false; failed.value = true; });
}
watch(() => [props.file, props.node], load);

/* 模型文件被修改（材质修复）后重新加载 */
function onFixed(e) {
  const d = e.detail || {};
  if (d.projId === props.projId && d.file === props.file) load();
}

onMounted(() => { init(); load(); window.addEventListener('resize', resize); window.addEventListener('model-fixed', onFixed); });
onBeforeUnmount(() => {
  window.removeEventListener('resize', resize);
  window.removeEventListener('model-fixed', onFixed);
  if (controls) controls.dispose();
  if (renderer) { renderer.dispose(); renderer.domElement && renderer.domElement.remove(); }
});
</script>

<template>
  <div class="mpreview">
    <div ref="wrap" class="mp-canvas"></div>
    <div v-if="loading" class="mp-tag">加载中…</div>
    <div v-else-if="failed" class="mp-tag bad">模型加载失败</div>
    <div v-else-if="!file" class="mp-tag">未选择模型</div>
    <el-button v-if="file" class="mp-fix" size="small" :disabled="fixing"
      title="修复材质过暗（金属度偏高 / 颜色未转 sRGB / 压暗扩展）"
      @click="emit('fix')">{{ fixing ? '修复中…' : '✨ 修复材质' }}</el-button>
  </div>
</template>

<style scoped>
.mpreview {
  position: relative; height: 210px; border: 1px solid var(--line);
  border-radius: 10px; overflow: hidden; background: #f2f4f8; margin-bottom: 6px;
}
.mp-canvas { position: absolute; inset: 0; cursor: grab; }
.mp-canvas:active { cursor: grabbing; }
.mp-tag {
  position: absolute; top: 8px; left: 50%; transform: translateX(-50%);
  background: rgba(255,255,255,.92); border: 1px solid var(--line);
  border-radius: 6px; padding: 2px 10px; font-size: 11px; color: var(--fg-dim);
  pointer-events: none;
}
.mp-tag.bad { color: var(--danger); border-color: #e0a2a2; }
.mp-fix {
  position: absolute; top: 8px; right: 8px; z-index: 2;
  box-shadow: 0 1px 3px rgba(0,0,0,.06);
}
</style>
