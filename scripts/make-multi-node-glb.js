#!/usr/bin/env node
/*
 * 生成「多个独立 node 节点」的测试 GLB 模型（零依赖，只写标准 glTF 2.0 二进制）
 * 用法: node scripts/make-multi-node-glb.js [输出目录]
 *   不带参数 → 输出到演示项目 data/projects/pabbe02e8/models/
 *
 * 与 make-sample-glb.js 的区别：
 *  - 后者把所有几何合并进一个 node/mesh（场景树只有 1 个节点）
 *  - 本脚本每个逻辑部件（柜体/门板/把手…）是一个独立命名 node + 独立 mesh，
 *    GLTFLoader 加载后 gltf.scene.children 能拿到这些具名节点
 *
 * 约定：单位=米，原点=底面中心落地点，正面朝 +Z，宽度沿 X。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OUT_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, '..', 'data', 'projects', 'pabbe02e8', 'models');
const OUT_FILE = path.join(OUT_DIR, 'multi_node_cabinet.glb');

/* ---------- 材质 ---------- */
const hex = (h) => {
  const n = parseInt(h.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const MAT = {
  woodDark:  { color: hex('#6b4a32'), roughness: 0.7 },
  woodMid:   { color: hex('#9a7351'), roughness: 0.65 },
  woodLight: { color: hex('#c6a071'), roughness: 0.65 },
  offWhite:  { color: hex('#e6e5e0'), roughness: 0.6 },
  metal:     { color: hex('#b7bcc2'), metallic: 0.35, roughness: 0.35 },
};

/* ---------- 每节点几何累加器（与 sample 脚本同款，但按节点隔离） ---------- */
function newBuf() { return { pos: [], nrm: [], idx: [], count: 0 }; }
function pushQuad(b, p0, p1, p2, p3, n) {
  const base = b.count;
  for (const p of [p0, p1, p2, p3]) { b.pos.push(p[0], p[1], p[2]); b.nrm.push(n[0], n[1], n[2]); }
  b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  b.count += 4;
}
function pushTri(b, p0, p1, p2, n) {
  const base = b.count;
  for (const p of [p0, p1, p2]) { b.pos.push(p[0], p[1], p[2]); b.nrm.push(n[0], n[1], n[2]); }
  b.idx.push(base, base + 1, base + 2);
  b.count += 3;
}
const rotY = ([x, y, z], a) => [x * Math.cos(a) + z * Math.sin(a), y, -x * Math.sin(a) + z * Math.cos(a)];

function box(b, cx, cy, cz, sx, sy, sz) {
  const x0 = -sx / 2, x1 = sx / 2, y0 = -sy / 2, y1 = sy / 2, z0 = -sz / 2, z1 = sz / 2;
  const P = (x, y, z) => [x + cx, y + cy, z + cz];
  const N = (x, y, z) => [x, y, z];
  pushQuad(b, P(x1, y0, z1), P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), N(1, 0, 0));
  pushQuad(b, P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0), N(-1, 0, 0));
  pushQuad(b, P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0), P(x0, y1, z0), N(0, 1, 0));
  pushQuad(b, P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), N(0, -1, 0));
  pushQuad(b, P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), N(0, 0, 1));
  pushQuad(b, P(x1, y0, z0), P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0), N(0, 0, -1));
}

function cylinder(b, cx, cy0, cz, rb, rt, h, seg = 16, caps = true) {
  const y0 = cy0, y1 = cy0 + h;
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    const slope = (rb - rt) / Math.max(h, 1e-6);
    const nl = Math.hypot(1, slope);
    pushQuad(b,
      [cx + Math.cos(a0) * rb, y0, cz + Math.sin(a0) * rb],
      [cx + Math.cos(a1) * rb, y0, cz + Math.sin(a1) * rb],
      [cx + Math.cos(a1) * rt, y1, cz + Math.sin(a1) * rt],
      [cx + Math.cos(a0) * rt, y1, cz + Math.sin(a0) * rt],
      [Math.cos(am) / nl, slope / nl, Math.sin(am) / nl]);
  }
  if (caps && rt > 1e-5) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      pushTri(b, [cx, y1, cz],
        [cx + Math.cos(a0) * rt, y1, cz + Math.sin(a0) * rt],
        [cx + Math.cos(a1) * rt, y1, cz + Math.sin(a1) * rt], [0, 1, 0]);
    }
  }
  if (caps && rb > 1e-5) {
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      pushTri(b, [cx, y0, cz],
        [cx + Math.cos(a1) * rb, y0, cz + Math.sin(a1) * rb],
        [cx + Math.cos(a0) * rb, y0, cz + Math.sin(a0) * rb], [0, -1, 0]);
    }
  }
}

/* ---------- 模型定义：一个「双开门床头柜」，7 个独立节点 ---------- */
const W = 0.6, D = 0.44, H = 0.72;         // 柜体外形
const doorW = W / 2 - 0.035, doorH = H - 0.16;

const NODES = [
  {
    name: 'cabinet_body', label: '柜体',
    build(b) { box(b, 0, H / 2, 0, W, H, D); },
  },
  {
    name: 'plinth', label: '踢脚底座',
    build(b) { box(b, 0, 0.035, 0, W - 0.05, 0.07, D - 0.04); },
  },
  {
    name: 'top_panel', label: '顶面板',
    build(b) { box(b, 0, H + 0.015, 0, W + 0.03, 0.03, D + 0.03); },
  },
  {
    name: 'back_panel', label: '背板',
    build(b) { box(b, 0, H / 2, -D / 2 + 0.012, W - 0.06, H - 0.1, 0.02); },
  },
  {
    name: 'door_left', label: '左门板',
    build(b) { box(b, -(doorW / 2 + 0.012), H / 2, D / 2 + 0.012, doorW, doorH, 0.025); },
  },
  {
    name: 'door_right', label: '右门板',
    build(b) { box(b, doorW / 2 + 0.012, H / 2, D / 2 + 0.012, doorW, doorH, 0.025); },
  },
  {
    name: 'handle_left', label: '左把手',
    build(b) { cylinder(b, -0.045, H / 2 - 0.09, D / 2 + 0.045, 0.008, 0.008, 0.18, 8, false); },
  },
  {
    name: 'handle_right', label: '右把手',
    build(b) { cylinder(b, 0.045, H / 2 - 0.09, D / 2 + 0.045, 0.008, 0.008, 0.18, 8, false); },
  },
];

/* 每节点材质选择：节点内按材质分组（本模型每节点只用一种材质，够测试用） */
const NODE_MAT = {
  cabinet_body: 'woodMid', plinth: 'woodDark', top_panel: 'woodLight',
  back_panel: 'offWhite', door_left: 'offWhite', door_right: 'offWhite',
  handle_left: 'metal', handle_right: 'metal',
};

/* ---------- GLB 打包：每节点一个 mesh（单材质单 primitive），全部为根级独立节点 ---------- */
function buildMultiNodeGLB(nodeDefs) {
  const materials = [];
  const matIndex = new Map();
  const ensureMat = (name) => {
    if (matIndex.has(name)) return matIndex.get(name);
    const m = MAT[name];
    materials.push({
      name,
      doubleSided: true,
      pbrMetallicRoughness: {
        baseColorFactor: [m.color[0], m.color[1], m.color[2], 1],
        metallicFactor: m.metallic ?? 0,
        roughnessFactor: m.roughness ?? 0.75,
      },
    });
    matIndex.set(name, materials.length - 1);
    return materials.length - 1;
  };

  const accessors = [];
  const bufferViews = [];
  const chunks = [];
  let offset = 0;
  const addView = (u8, target) => {
    /* 注意：TypedArray 的 .length 是元素个数，byteLength 才是字节数（Buffer 下两者相同，
       换成 Float32Array/Uint16Array 后必须用 byteLength，否则所有 view 偏移与长度都会错位） */
    const bytes = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
    while (offset % 4 !== 0) { chunks.push(Buffer.alloc(1)); offset += 1; }
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
    chunks.push(bytes);
    offset += bytes.length;
    return bufferViews.length - 1;
  };

  const nodes = [];
  const meshes = [];

  for (const def of nodeDefs) {
    const matName = NODE_MAT[def.name] || 'offWhite';
    const b = newBuf();
    def.build(b);
    if (!b.count) throw new Error('空节点: ' + def.name);

    const posArr = Float32Array.from(b.pos);
    const nrmArr = Float32Array.from(b.nrm);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < b.pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], b.pos[i + k]);
        max[k] = Math.max(max[k], b.pos[i + k]);
      }
    }

    const posView = addView(posArr, 34962);
    accessors.push({ bufferView: posView, componentType: 5126, count: b.count, type: 'VEC3', min, max });
    const aPos = accessors.length - 1;

    const nrmView = addView(nrmArr, 34962);
    accessors.push({ bufferView: nrmView, componentType: 5126, count: b.count, type: 'VEC3' });
    const aNrm = accessors.length - 1;

    let idxBuf, compType;
    if (b.count > 65535) { idxBuf = Uint32Array.from(b.idx); compType = 5125; }
    else { idxBuf = Uint16Array.from(b.idx); compType = 5123; }
    const idxView = addView(idxBuf, 34963);
    accessors.push({ bufferView: idxView, componentType: compType, count: b.idx.length, type: 'SCALAR' });
    const aIdx = accessors.length - 1;

    meshes.push({
      name: def.name + '_mesh',
      primitives: [{ attributes: { POSITION: aPos, NORMAL: aNrm }, indices: aIdx, material: ensureMat(matName), mode: 4 }],
    });
    nodes.push({ name: def.name, mesh: meshes.length - 1 });
  }

  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: '2.0', generator: 'ha3d-plugin-studio multi-node test generator' },
    scene: 0,
    scenes: [{ name: 'RootScene', nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  };

  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  while (jsonBuf.length % 4 !== 0) jsonBuf = Buffer.concat([jsonBuf, Buffer.from(' ')]);
  let binBuf = bin;
  while (binBuf.length % 4 !== 0) binBuf = Buffer.concat([binBuf, Buffer.alloc(1)]);

  const total = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(total, 8);
  const jsonHead = Buffer.alloc(8);
  jsonHead.writeUInt32LE(jsonBuf.length, 0);
  jsonHead.writeUInt32LE(0x4e4f534a, 4);
  const binHead = Buffer.alloc(8);
  binHead.writeUInt32LE(binBuf.length, 0);
  binHead.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, jsonHead, jsonBuf, binHead, binBuf]);
}

/* ---------- 主流程 ---------- */
const glb = buildMultiNodeGLB(NODES);
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, glb);
console.log(`✓ ${path.relative(process.cwd(), OUT_FILE)}  ${(glb.length / 1024).toFixed(1)} KB`);
console.log(`  独立节点 ${NODES.length} 个:`);
for (const n of NODES) console.log(`   - ${n.name.padEnd(16)} (${n.label})`);
