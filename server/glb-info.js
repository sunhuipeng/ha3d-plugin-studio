/*
 * GLB 结构深度解析（纯函数、零依赖，服务端 MCP 工具用）
 *
 * 与 mcp/helpers.js 的 glbSummary（只给 mesh/材质数量 + 局部 bbox）不同，这里解析到
 * 「AI 拿到就能判断这个模型是什么、由哪些部件组成、材质有没有问题、摆到 home 里该填多大」：
 *   - 文件层：GLB 头 / chunk 列表 / asset / 扩展
 *   - 场景层：场景与节点树（含 TRS / matrix / mesh / children）
 *   - 网格层：逐 mesh 逐 primitive 的属性、顶点/三角形数、材质引用、局部包围盒
 *   - 外观层：材质（baseColor / metallic / roughness / alpha / 贴图 / 扩展）、贴图、图片、采样器
 *   - 动画层：动画名 / 通道数 / 目标节点与路径
 *   - 尺寸层：**世界坐标包围盒**（沿节点树叠加 TRS/matrix 后再量），输出 w(X) / d(Z) / h(Y)
 *     —— 与编辑页「按模型实测」（THREE.Box3.setFromObject）同口径，可直接填 catalog.items 的 w/d/h
 *
 * 列表都带上限（CAPS），大模型不会把 MCP 返回撑爆；超出部分在 *Note 字段里说明。
 */
/* 复用插件编辑页已有的实现（不重复造轮子）：
 *   - split-glb.js: parseGlb（JSON/BIN chunk）+ mat4FromTRS / mat4Mul / transformPoint（列主序世界矩阵）
 *   - mcp/helpers.js: glbSummary（列表摘要）——列表类工具直接调它，本模块只补「深度明细」
 * 本模块只新增它们没有的：容器元信息、材质/贴图/动画/扩展明细、顶点三角统计、世界包围盒 → 实测 w/d/h。 */
'use strict';

const {
  parseGlb: parseGlbChunks, MAT4_IDENT, mat4FromTRS, mat4Mul, transformPoint,
} = require('./split-glb');

const CAPS = {
  nodes: 120, meshes: 60, primitives: 240, materials: 60,
  textures: 60, images: 60, samplers: 30, animations: 30,
  accessors: 240, bufferViews: 240,
};

const r3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;

/* ---------------- 容器层 ---------------- */

function parseGlb(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length < 20) throw new Error('文件太短，不是完整 GLB');
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB（magic 不等于 glTF）');
  const version = b.readUInt32LE(4);
  const declared = b.readUInt32LE(8);
  /* JSON/BIN 的解析完全交给 split-glb.js（含 glTF 2.0 版本校验）；
   * 这里只额外扫一遍 chunk 头，补上「文件多大、有哪些 chunk、有没有被截断」这类容器元信息 */
  const { json, bin } = parseGlbChunks(b);
  const chunks = [];
  let off = 12;
  while (off + 8 <= b.length) {
    const len = b.readUInt32LE(off);
    const type = b.readUInt32LE(off + 4);
    chunks.push({
      type: type === 0x4e4f534a ? 'JSON' : (type === 0x004e4942 ? 'BIN' : '0x' + type.toString(16)),
      length: len,
    });
    off += 8 + len;
  }
  return { bytes: b.length, version, declared, chunks, json, binBytes: bin.length };
}

/* ---------------- 世界变换：直接复用 split-glb.js 的列主序矩阵工具 ---------------- */

const identity = () => MAT4_IDENT.slice();
const mul = mat4Mul;
const apply = transformPoint;
function matrixOf(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.map(Number);
  return mat4FromTRS(
    Array.isArray(node.translation) ? node.translation : [0, 0, 0],
    Array.isArray(node.rotation) ? node.rotation : [0, 0, 0, 1],
    Array.isArray(node.scale) ? node.scale : [1, 1, 1],
  );
}
function corners(mn, mx) {
  return [
    [mn[0], mn[1], mn[2]], [mx[0], mn[1], mn[2]], [mn[0], mx[1], mn[2]], [mx[0], mx[1], mn[2]],
    [mn[0], mn[1], mx[2]], [mx[0], mn[1], mx[2]], [mn[0], mx[1], mx[2]], [mx[0], mx[1], mx[2]],
  ];
}

/* 沿场景节点树累计世界矩阵，把每个 primitive 的局部 AABB 8 个角点变换后求并集。
 * 与 THREE.Box3.setFromObject（几何体包围盒 × matrixWorld）同一套做法，结果可直接当实测尺寸。 */
function worldBox(json) {
  const nodes = json.nodes || [];
  const meshes = json.meshes || [];
  const acc = json.accessors || [];
  const scenes = json.scenes || [];
  const sceneIdx = Number.isInteger(json.scene) ? json.scene : 0;
  let roots = (scenes[sceneIdx] && Array.isArray(scenes[sceneIdx].nodes)) ? scenes[sceneIdx].nodes : [];
  if (!roots.length) {
    const child = new Set();
    nodes.forEach((n) => (n.children || []).forEach((c) => child.add(c)));
    roots = nodes.map((n, i) => i).filter((i) => !child.has(i));
  }
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  let found = false;
  let primCount = 0;
  const stack = roots.map((i) => ({ idx: i, m: identity(), depth: 0, path: '' }));
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (cur.depth > 64 || cur.idx < 0 || cur.idx >= nodes.length) continue;
    const key = cur.idx + '@' + cur.depth;
    if (seen.has(key)) continue;        // 防异常循环引用
    seen.add(key);
    const n = nodes[cur.idx] || {};
    const world = mul(cur.m, matrixOf(n));
    if (Number.isInteger(n.mesh) && meshes[n.mesh]) {
      for (const p of meshes[n.mesh].primitives || []) {
        const a = acc[(p.attributes || {}).POSITION];
        if (!a || !Array.isArray(a.min) || !Array.isArray(a.max)) continue;
        primCount += 1;
        for (const c of corners(a.min, a.max)) {
          const q = apply(world, c);
          for (let i = 0; i < 3; i++) {
            mn[i] = Math.min(mn[i], q[i]);
            mx[i] = Math.max(mx[i], q[i]);
          }
          found = true;
        }
      }
    }
    for (const c of (n.children || []).slice().reverse()) {
      stack.push({ idx: c, m: world, depth: cur.depth + 1, path: cur.path });
    }
  }
  if (!found) return null;
  return {
    min: mn.map(r3), max: mx.map(r3),
    size: [r3(mx[0] - mn[0]), r3(mx[1] - mn[1]), r3(mx[2] - mn[2])],
    center: [r3((mn[0] + mx[0]) / 2), r3((mn[1] + mx[1]) / 2), r3((mn[2] + mx[2]) / 2)],
    primitives: primCount,
  };
}

/* ---------------- 主入口 ---------------- */

function glbDetail(buf) {
  const g = parseGlb(buf);
  const j = g.json;
  const out = {
    format: 'glb',
    version: g.version,
    bytes: g.bytes,
    declaredLength: g.declared,
    binBytes: g.binBytes,
    chunks: g.chunks,
    lengthMatch: g.declared === g.bytes,
    asset: j.asset || {},
    extensionsUsed: j.extensionsUsed || [],
    extensionsRequired: j.extensionsRequired || [],
  };
  const warnings = [];
  if (!out.lengthMatch) warnings.push('GLB 头声明的长度与实际文件字节数不一致（文件可能被截断）');

  const nodes = j.nodes || [];
  const meshes = j.meshes || [];
  const materials = j.materials || [];
  const textures = j.textures || [];
  const images = j.images || [];
  const accessors = j.accessors || [];
  const animations = j.animations || [];

  out.counts = {
    scenes: (j.scenes || []).length,
    nodes: nodes.length,
    meshes: meshes.length,
    primitives: meshes.reduce((n, m) => n + (m.primitives || []).length, 0),
    materials: materials.length,
    textures: textures.length,
    images: images.length,
    animations: animations.length,
    accessors: accessors.length,
    bufferViews: (j.bufferViews || []).length,
    skins: (j.skins || []).length,
    cameras: (j.cameras || []).length,
    samplers: (j.samplers || []).length,
  };

  /* 场景：默认场景 + 每个场景的根节点 */
  out.scene = {
    default: Number.isInteger(j.scene) ? j.scene : 0,
    list: (j.scenes || []).slice(0, 20).map((s, i) => ({
      index: i, name: s.name || '', nodes: (s.nodes || []).slice(0, 40),
    })),
  };

  /* 节点树（带 TRS / 变换摘要，mesh 名一并带出，方便找部件） */
  out.nodes = nodes.slice(0, CAPS.nodes).map((n, i) => {
    const row = {
      index: i,
      name: n.name || '',
      children: (n.children || []).slice(0, 40),
      mesh: Number.isInteger(n.mesh) ? n.mesh : null,
      meshName: Number.isInteger(n.mesh) && meshes[n.mesh] ? (meshes[n.mesh].name || '') : '',
    };
    if (Array.isArray(n.translation)) row.translation = n.translation;
    if (Array.isArray(n.rotation)) row.rotation = n.rotation;
    if (Array.isArray(n.scale)) row.scale = n.scale;
    if (Array.isArray(n.matrix)) row.hasMatrix = true;
    if (n.camera != null) row.camera = n.camera;
    if (n.skin != null) row.skin = n.skin;
    if (n.extensions) row.extensions = Object.keys(n.extensions);
    return row;
  });
  if (nodes.length > CAPS.nodes) out.nodesNote = `只列前 ${CAPS.nodes} 个节点，共 ${nodes.length} 个`;

  /* 网格与 primitive：顶点/三角面数、属性、材质、局部包围盒 */
  let verts = 0;
  let tris = 0;
  let pcap = 0;
  out.meshes = meshes.slice(0, CAPS.meshes).map((m, mi) => {
    const row = { index: mi, name: m.name || '', primitives: [] };
    let mv = 0; let mt = 0;
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (const p of (m.primitives || [])) {
      const pos = accessors[(p.attributes || {}).POSITION];
      const idx = accessors[p.indices];
      const v = (pos && pos.count) || 0;
      const t = idx ? Math.round((idx.count || 0) / 3) : Math.round(v / 3);
      mv += v; mt += t; verts += v; tris += t;
      if (pcap < CAPS.primitives) {
        pcap += 1;
        row.primitives.push({
          mode: p.mode == null ? 4 : p.mode,
          attributes: Object.keys(p.attributes || {}),
          vertices: v, triangles: t,
          indicesAccessor: p.indices == null ? null : p.indices,
          material: p.material == null ? null : p.material,
          materialName: p.material == null ? '' : ((materials[p.material] || {}).name || ''),
          targets: (p.targets || []).length,
          position: pos ? { count: pos.count, min: pos.min, max: pos.max } : null,
        });
      }
      if (pos && pos.min && pos.max) {
        for (let i = 0; i < 3; i++) {
          mn[i] = Math.min(mn[i], pos.min[i]);
          mx[i] = Math.max(mx[i], pos.max[i]);
        }
      }
    }
    row.vertices = mv;
    row.triangles = mt;
    if (Number.isFinite(mn[0])) row.localSize = mx.map((v, i) => r3(v - mn[i]));
    return row;
  });
  if (meshes.length > CAPS.meshes) out.meshesNote = `只列前 ${CAPS.meshes} 个 mesh，共 ${meshes.length} 个`;
  out.totals = { vertices: verts, triangles: tris };

  /* 材质：显黑排查最常看的就是这几个字段 */
  out.materials = materials.slice(0, CAPS.materials).map((m, i) => {
    const pbr = m.pbrMetallicRoughness || {};
    const row = {
      index: i,
      name: m.name || '',
      baseColorFactor: pbr.baseColorFactor || null,
      metallicFactor: pbr.metallicFactor == null ? 1 : pbr.metallicFactor,
      roughnessFactor: pbr.roughnessFactor == null ? 1 : pbr.roughnessFactor,
      baseColorTexture: pbr.baseColorTexture == null ? null : pbr.baseColorTexture,
      metallicRoughnessTexture: pbr.metallicRoughnessTexture == null ? null : pbr.metallicRoughnessTexture,
      emissiveFactor: m.emissiveFactor || null,
      alphaMode: m.alphaMode || 'OPAQUE',
      doubleSided: !!m.doubleSided,
    };
    ['normalTexture', 'occlusionTexture', 'emissiveTexture'].forEach((k) => {
      if (m[k] != null) row[k] = m[k];
    });
    if (m.extensions) row.extensions = Object.keys(m.extensions);
    return row;
  });
  if (materials.length > CAPS.materials) out.materialsNote = `只列前 ${CAPS.materials} 个材质，共 ${materials.length} 个`;

  out.textures = textures.slice(0, CAPS.textures).map((t, i) => ({
    index: i, name: t.name || '', source: t.source == null ? null : t.source,
    sampler: t.sampler == null ? null : t.sampler,
    extensions: t.extensions ? Object.keys(t.extensions) : [],
  }));
  out.images = images.slice(0, CAPS.images).map((im, i) => {
    const row = { index: i, name: im.name || '', mimeType: im.mimeType || '', uri: im.uri || '' };
    if (im.bufferView != null) {
      row.bufferView = im.bufferView;
      const bv = (j.bufferViews || [])[im.bufferView];
      if (bv) row.bytes = bv.byteLength;
    }
    return row;
  });
  out.samplers = (j.samplers || []).slice(0, CAPS.samplers).map((s, i) => ({ index: i, ...s }));

  out.animations = animations.slice(0, CAPS.animations).map((a, i) => ({
    index: i, name: a.name || '',
    channels: (a.channels || []).length,
    samplers: (a.samplers || []).length,
    targets: (a.channels || []).slice(0, 12).map((c) => ({
      node: c.target && c.target.node, path: c.target && c.target.path,
    })),
  }));
  out.accessors = {
    count: accessors.length,
    byType: accessors.reduce((o, a) => { const k = a.type || '?'; o[k] = (o[k] || 0) + 1; return o; }, {}),
    sample: accessors.slice(0, 20).map((a, i) => ({
      index: i, type: a.type, componentType: a.componentType,
      count: a.count, normalized: !!a.normalized,
    })),
  };
  out.bufferViews = {
    count: (j.bufferViews || []).length,
    totalBytes: (j.bufferViews || []).reduce((n, v) => n + (v.byteLength || 0), 0),
  };

  /* 尺寸：世界包围盒（叠加节点变换）→ 直接可填 w/d/h */
  const wb = worldBox(j);
  out.bbox = wb || null;
  out.measured = wb ? { w: wb.size[0], d: wb.size[2], h: wb.size[1] } : null;
  out.bboxNote = '沿场景节点树叠加 TRS/matrix 后，把各 primitive 的 POSITION min/max 包围盒角点变换求并集；'
    + 'size = [宽X, 高Y, 深Z]，measured = { w:X, d:Z, h:Y }（米，与编辑页「按模型实测」同口径）';
  if (!wb) warnings.push('没有可用的 POSITION min/max，无法计算实测尺寸（填 w/d/h 需手动给）');
  if (out.extensionsRequired && out.extensionsRequired.length) {
    warnings.push('使用了必需扩展 ' + out.extensionsRequired.join(', ') + '：加载器不支持会直接失败');
  }
  out.warnings = warnings;
  return out;
}

/* 只要实测尺寸（上传模型自动填 w/d/h 时用），解析失败返回 null 而不是抛错 */
function measureGlb(buf) {
  try {
    const d = glbDetail(buf);
    return d.measured && d.measured.w > 0 && d.measured.d > 0 && d.measured.h > 0 ? d.measured : null;
  } catch (e) { return null; }
}

module.exports = { glbDetail, measureGlb, parseGlb, CAPS };
