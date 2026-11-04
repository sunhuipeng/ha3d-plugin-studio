/* GLB 缩略图离屏渲染（共享一个 WebGL renderer），结果按 projId/file 缓存 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { frameObject } from './engine/frame';

const cache = new Map();   // key: projId/file → dataURL | 'error' | undefined(加载中)
const revs = new Map();    // key: projId/file → 版本号（材质修复后 +1，强制绕过浏览器缓存）
const nodeThumbs = new Map();  // key: projId/file#node → dataURL | 'error' | undefined
let renderer = null;

export function modelUrl(projId, file) {
  const rev = revs.get(projId + '/' + file) || 0;
  return `/api/projects/${projId}/models/${encodeURIComponent(file)}` + (rev ? `?v=${rev}` : '');
}

/* ---------- GLB 节点树（独立 node 列表，用于部件条目下嵌套子列表） ----------
   结果形如 [{ name, children: [{ name, children: [] }] }]，来自 glTF JSON 的 nodes/scenes，
   与 GLTFLoader 场景对象解耦，不会构建 mesh。缓存 + part-nodes 事件通知，模式同缩略图。 */
const nodesCache = new Map();  // key: projId/file → 树数组 | 'error' | undefined(加载中)

export function cachedNodes(projId, file) {
  const v = nodesCache.get(projId + '/' + file);
  return v && v !== 'error' ? v : null;
}
export function isNodesError(projId, file) { return nodesCache.get(projId + '/' + file) === 'error'; }

export function modelNodes(projId, file) {
  const key = projId + '/' + file;
  if (nodesCache.has(key)) return cachedNodes(projId, file);
  nodesCache.set(key, undefined);
  new GLTFLoader().load(modelUrl(projId, file), (gltf) => {
    try {
      const json = gltf.parser.json;
      const build = (i) => {
        const n = (json.nodes || [])[i] || {};
        return { name: n.name || `node_${i}`, children: (n.children || []).map(build) };
      };
      const sceneIdx = json.scene || 0;
      const tree = ((json.scenes || [])[sceneIdx]?.nodes || []).map(build);
      nodesCache.set(key, tree.length ? tree : 'error');
    } catch (e) {
      nodesCache.set(key, 'error');
    }
    window.dispatchEvent(new CustomEvent('part-nodes', { detail: key }));
  }, undefined, () => {
    nodesCache.set(key, 'error');
    window.dispatchEvent(new CustomEvent('part-nodes', { detail: key }));
  });
  return null;
}

/* 模型文件被修改（如材质修复）：清缩略图缓存 + 升版本号，并通知各预览处刷新 */
export function bumpModel(projId, file) {
  const key = projId + '/' + file;
  revs.set(key, Date.now());
  cache.delete(key);
  nodesCache.delete(key);
  for (const k of [...nodeThumbs.keys()]) {
    if (k.startsWith(key + '#')) nodeThumbs.delete(k);
  }
  window.dispatchEvent(new CustomEvent('model-thumb', { detail: key }));
  window.dispatchEvent(new CustomEvent('model-fixed', { detail: { projId, file } }));
}

function getRenderer(size = 96) {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(2);   // 2x 位图：高分屏下灯箱放大不糊
  }
  renderer.setSize(size, size, false);
  return renderer;
}

export function cachedThumb(projId, file) {
  const v = cache.get(projId + '/' + file);
  return v && v !== 'error' ? v : '';
}

export function isThumbError(projId, file) { return cache.get(projId + '/' + file) === 'error'; }

export function modelThumbUrl(projId, file) {
  const key = projId + '/' + file;
  if (cache.has(key)) return cache.get(key) || '';
  cache.set(key, undefined);            // 标记加载中
  const url = modelUrl(projId, file);
  new GLTFLoader().load(url, (gltf) => {
    try {
      cache.set(key, renderThumb(gltf.scene));
    } catch (e) {
      cache.set(key, 'error');
    }
    window.dispatchEvent(new CustomEvent('model-thumb', { detail: key }));
  }, undefined, () => {
    cache.set(key, 'error');
    window.dispatchEvent(new CustomEvent('model-thumb', { detail: key }));
  });
  return '';
}

/* 通用单对象缩略图渲染（居中取景 + 打光） */
function renderThumb(obj) {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa4b2, 1.2));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(2, 4, 3);
  scene.add(dir);
  scene.add(obj);
  const { center, maxDim, camPos } = frameObject(new THREE.Box3().setFromObject(obj), {
    fov: 40, padding: 1.5, dir: { x: 0.65, y: 0.55, z: 0.65 },
  });
  const cam = new THREE.PerspectiveCamera(40, 1, maxDim / 1000, maxDim * 10);
  cam.position.copy(camPos);
  cam.lookAt(center);
  const r = getRenderer(96);
  r.render(scene, cam);
  return r.domElement.toDataURL('image/png');
}

/* ---------- GLB 内单个节点的缩略图（子列表用）：key 为 file#node ---------- */

export function cachedNodeThumb(projId, file, node) {
  const v = nodeThumbs.get(projId + '/' + file + '#' + node);
  return v && v !== 'error' ? v : '';
}
export function isNodeThumbError(projId, file, node) {
  return nodeThumbs.get(projId + '/' + file + '#' + node) === 'error';
}

export function nodeThumbUrl(projId, file, node) {
  const key = projId + '/' + file + '#' + node;
  if (nodeThumbs.has(key)) return cachedNodeThumb(projId, file, node);
  nodeThumbs.set(key, undefined);
  new GLTFLoader().load(modelUrl(projId, file), (gltf) => {
    try {
      const obj = gltf.scene.getObjectByName(node);
      nodeThumbs.set(key, obj ? renderThumb(obj) : 'error');
    } catch (e) {
      nodeThumbs.set(key, 'error');
    }
    window.dispatchEvent(new CustomEvent('node-thumb', { detail: key }));
  }, undefined, () => {
    nodeThumbs.set(key, 'error');
    window.dispatchEvent(new CustomEvent('node-thumb', { detail: key }));
  });
  return '';
}
