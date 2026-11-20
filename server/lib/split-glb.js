/*
 * GLB 拆分：把一个 GLB 的（顶层）node 节点导出为独立的 .glb 文件。
 * 零依赖，只读写标准 glTF 2.0 二进制。
 *
 * 两种用法：
 *  - splitGlb(buf, base)                 全拆：每个顶层节点 → 一个单节点 GLB
 *  - splitGlbOne(buf, base, 'door_left') 单拆：指定节点 → 独立 GLB + 其余节点 → `<base>__rest.glb`
 *
 * 做法：
 *  1. 解析 JSON chunk + BIN chunk
 *  2. 沿 children 计算子树内每个 mesh 的世界矩阵
 *  3. 把顶点/法线用世界矩阵烘焙（法线用逆转置矩阵），按原材质重组 primitives
 *  4. 输出 GLB 的节点在原点、无变换；部件 pos/rot/scale 由前端继承
 */
'use strict';

const MAT4_IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/* ---- 最小 mat4 工具（列主序，与 glTF 一致） ---- */
function mat4FromTRS(t, q, s) {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
function mat4Mul(a, b) {   // returns a*b
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}
function transformPoint(m, v) {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
  ];
}
/* 逆转置 3x3（法线矩阵）：取 m 左上 3x3 → 求逆 → 转置 */
function normalMatrix(m) {
  const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22] = a;
  const d = a00 * a11 * a22 + a01 * a12 * a20 + a02 * a10 * a21
    - a02 * a11 * a20 - a01 * a10 * a22 - a00 * a12 * a21;
  if (!isFinite(d) || Math.abs(d) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const inv = [
    (a11 * a22 - a12 * a21) / d, (a02 * a21 - a01 * a22) / d, (a01 * a12 - a02 * a11) / d,
    (a12 * a20 - a10 * a22) / d, (a00 * a22 - a02 * a20) / d, (a02 * a10 - a00 * a12) / d,
    (a10 * a21 - a11 * a20) / d, (a01 * a20 - a00 * a21) / d, (a00 * a11 - a01 * a10) / d,
  ];
  /* inv 的转置 = 行列互换 */
  return [
    inv[0], inv[3], inv[6],
    inv[1], inv[4], inv[7],
    inv[2], inv[5], inv[8],
  ];
}
function transformNormal(nm, v) {
  const out = [
    nm[0] * v[0] + nm[1] * v[1] + nm[2] * v[2],
    nm[3] * v[0] + nm[4] * v[1] + nm[5] * v[2],
    nm[6] * v[0] + nm[7] * v[1] + nm[8] * v[2],
  ];
  const l = Math.hypot(out[0], out[1], out[2]) || 1;
  return [out[0] / l, out[1] / l, out[2] / l];
}

/* ---- GLB 解析 ---- */
function parseGlb(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB 文件');
  if (buf.readUInt32LE(4) !== 2) throw new Error('仅支持 glTF 2.0');
  let off = 12, json = null, bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len;
  }
  if (!json) throw new Error('GLB 缺少 JSON chunk');
  return { json, bin: bin || Buffer.alloc(0) };
}

function readAccessor(json, bin, accIdx) {
  const acc = json.accessors[accIdx];
  if (acc.sparse) throw new Error('暂不支持 sparse accessor');
  const bv = json.bufferViews[acc.bufferView] || {};
  const nComp = { VEC3: 3, VEC2: 2, SCALAR: 1 }[acc.type];
  const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const count = acc.count;
  const out = new Array(count * nComp);
  for (let i = 0; i < count * nComp; i++) {
    if (acc.componentType === 5126) out[i] = bin.readFloatLE(start + i * 4);
    else if (acc.componentType === 5125) out[i] = bin.readUInt32LE(start + i * 4);
    else if (acc.componentType === 5123) out[i] = bin.readUInt16LE(start + i * 2);
    else out[i] = bin.readUInt8(start + i);
  }
  return { data: out, count, nComp };
}

/* ---- GLB 打包：groups = [{ name, prims }] → 一个 GLB（每 group 一个 node/mesh） ---- */
function buildGlb(groups, materials) {
  const accessors = [];
  const bufferViews = [];
  const chunks = [];
  let offset = 0;
  const addView = (buf, target) => {
    while (offset % 4 !== 0) { chunks.push(Buffer.alloc(1)); offset += 1; }
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target });
    chunks.push(buf);
    offset += buf.length;
    return bufferViews.length - 1;
  };

  const meshes = groups.map((g) => {
    const newPrims = [];
    for (const prim of g.prims) {
      const posArr = Float32Array.from(prim.pos);
      const nrmArr = Float32Array.from(prim.nrm);
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < prim.pos.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], prim.pos[i + k]);
          max[k] = Math.max(max[k], prim.pos[i + k]);
        }
      }
      const posView = addView(Buffer.from(posArr.buffer), 34962);
      accessors.push({ bufferView: posView, componentType: 5126, count: prim.pos.length / 3, type: 'VEC3', min, max });
      const aPos = accessors.length - 1;
      const nrmView = addView(Buffer.from(nrmArr.buffer), 34962);
      accessors.push({ bufferView: nrmView, componentType: 5126, count: prim.nrm.length / 3, type: 'VEC3' });
      const aNrm = accessors.length - 1;
      const use32 = prim.pos.length / 3 > 65535;
      const idxArr = use32 ? Uint32Array.from(prim.idx) : Uint16Array.from(prim.idx);
      const idxView = addView(Buffer.from(idxArr.buffer), 34963);
      accessors.push({ bufferView: idxView, componentType: use32 ? 5125 : 5123, count: prim.idx.length, type: 'SCALAR' });
      const aIdx = accessors.length - 1;
      newPrims.push({
        attributes: { POSITION: aPos, NORMAL: aNrm },
        indices: aIdx,
        material: prim.material,
        mode: 4,
      });
    }
    return { name: (g.name || 'node') + '_mesh', primitives: newPrims };
  });

  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: '2.0', generator: 'ha3d-plugin-studio glb splitter' },
    scene: 0,
    scenes: [{ name: 'RootScene', nodes: groups.map((_, i) => i) }],
    nodes: groups.map((g, i) => ({ name: g.name || 'node_' + i, mesh: i })),
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

/* ---- 烘焙器：解析一次，按顶层 root 收集并烘焙世界变换后的 prims ---- */
function makeBaker(json, bin) {
  const nodes = json.nodes || [];
  const sceneIdx = json.scene || 0;
  const roots = ((json.scenes || [])[sceneIdx] || {}).nodes || [];
  if (!roots.length) throw new Error('GLB 没有任何节点');

  const localMat = (i) => {
    const n = nodes[i] || {};
    if (n.matrix) return n.matrix.slice();
    return mat4FromTRS(n.translation || [0, 0, 0], n.rotation || [0, 0, 0, 1], n.scale || [1, 1, 1]);
  };
  const world = new Map();
  const walkMat = (i, parent) => {
    const m = mat4Mul(parent, localMat(i));
    world.set(i, m);
    for (const c of nodes[i].children || []) walkMat(c, m);
  };
  for (const r of roots) walkMat(r, MAT4_IDENT);

  const accType = (j, i) => j.accessors[i].type;
  const accComp = (j, i) => j.accessors[i].componentType;

  const collect = (i, out) => {
    const n = nodes[i] || {};
    if (n.mesh !== undefined) {
      const mesh = json.meshes[n.mesh];
      for (const prim of mesh.primitives || []) {
        const posAcc = readAccessor(json, bin, prim.attributes.POSITION);
        if (accType(json, prim.attributes.POSITION) !== 'VEC3' || accComp(json, prim.attributes.POSITION) !== 5126) {
          throw new Error('POSITION 需为 float VEC3');
        }
        const nrmAcc = prim.attributes.NORMAL !== undefined
          ? readAccessor(json, bin, prim.attributes.NORMAL) : null;
        let idx;
        if (prim.indices !== undefined) idx = readAccessor(json, bin, prim.indices).data;
        else { idx = new Array(posAcc.count); for (let k = 0; k < idx.length; k++) idx[k] = k; }
        const m = world.get(i);
        const nm = normalMatrix(m);
        const pos = new Array(posAcc.data.length);
        for (let k = 0; k < posAcc.count; k++) {
          const p = transformPoint(m, [posAcc.data[k * 3], posAcc.data[k * 3 + 1], posAcc.data[k * 3 + 2]]);
          pos[k * 3] = p[0]; pos[k * 3 + 1] = p[1]; pos[k * 3 + 2] = p[2];
        }
        let nrm;
        if (nrmAcc) {
          nrm = new Array(nrmAcc.data.length);
          for (let k = 0; k < nrmAcc.count; k++) {
            const v = transformNormal(nm, [nrmAcc.data[k * 3], nrmAcc.data[k * 3 + 1], nrmAcc.data[k * 3 + 2]]);
            nrm[k * 3] = v[0]; nrm[k * 3 + 1] = v[1]; nrm[k * 3 + 2] = v[2];
          }
        } else {
          nrm = new Array(pos.length);   // 无法线兜底：全朝上
          for (let k = 0; k < pos.length / 3; k++) { nrm[k * 3] = 0; nrm[k * 3 + 1] = 1; nrm[k * 3 + 2] = 0; }
        }
        out.push({ node: i, primIndex: out.length, pos, nrm, idx, material: prim.material || 0 });
      }
    }
    for (const c of n.children || []) collect(c, out);
  };

  /* 烘焙一个顶层 root 的全部 prims；空节点（纯变换）返回空数组 */
  const bake = (rootIdx, order) => {
    const prims = [];
    collect(rootIdx, prims);
    return { name: (nodes[rootIdx] || {}).name || `node_${order}`, prims };
  };
  return { nodes, roots, bake };
}

/* 材质重映射（多个 group 共用一张材质表）：直接改写 prim.material 为新下标 */
function makeMaterialRemap(json) {
  const matMap = new Map();
  const materials = [];
  const remap = (groups) => {
    for (const g of groups) {
      for (const p of g.prims) {
        if (!matMap.has(p.material)) {
          const src = (json.materials || [])[p.material];
          matMap.set(p.material, materials.length);
          materials.push(src ? JSON.parse(JSON.stringify(src)) : {
            name: 'mat_' + p.material, doubleSided: true,
            pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 0.75 },
          });
        }
        p.material = matMap.get(p.material);
      }
    }
    return materials;
  };
  return { remap };
}

/* 文件名安全化：仅保留字母数字下划线连字符 */
function slugify(name, fallback) {
  return String(name).replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || fallback;
}

/* ---- 全拆：每个顶层节点一个文件 ----
 * 返回 [{ file, node, data }]；调用方负责写盘 */
function splitGlb(buf, baseName) {
  const { json, bin } = parseGlb(buf);
  const { roots, bake } = makeBaker(json, bin);
  const { remap } = makeMaterialRemap(json);

  const results = [];
  const used = new Set();
  roots.forEach((rootIdx, order) => {
    const group = bake(rootIdx, order);
    if (!group.prims.length) return;      // 空节点跳过
    const slug = slugify(group.name, `node_${order}`);
    let file = `${baseName}__${slug}.glb`;
    let k = 2;
    while (used.has(file)) file = `${baseName}__${slug}_${k++}.glb`;
    used.add(file);
    const materials = remap([group]);
    results.push({ file, node: group.name, data: buildGlb([group], materials) });
  });
  if (!results.length) throw new Error('没有可拆分的网格节点');
  return results;
}

/* ---- 单拆：只把指定顶层节点导出为一个独立 .glb（不做剩余部分，原文件保持不变） ----
 * 返回 [{ file, node, data }]；调用方负责写盘 */
function splitGlbOne(buf, baseName, nodeName) {
  const { json, bin } = parseGlb(buf);
  const { nodes, roots, bake } = makeBaker(json, bin);
  const { remap } = makeMaterialRemap(json);

  const idx = roots.findIndex((r, order) => ((nodes[r] || {}).name || `node_${order}`) === nodeName);
  if (idx < 0) throw new Error(`找不到节点「${nodeName}」（仅支持顶层节点）`);

  const target = bake(roots[idx], idx);
  if (!target.prims.length) throw new Error(`节点「${nodeName}」没有网格，无法单独拆分`);

  const file = `${baseName}__${slugify(target.name, 'node')}.glb`;
  return [{ file, node: target.name, data: buildGlb([target], remap([target])) }];
}

/* 拆分必须在服务端做：逐顶点烘焙世界变换后再写出新的 .glb。
 * 这里解析顶点是「生产新文件」，不向 AI / 前端返回任何顶点信息，符合 GLB 边界；
 * 设备/背景插件编辑页「部件」面板的拆分按钮也走这套实现（routes/models.js）。 */
module.exports = { splitGlb, splitGlbOne };
