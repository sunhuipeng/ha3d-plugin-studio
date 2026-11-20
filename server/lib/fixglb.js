/* GLB 材质修复（Node 零依赖）——移植自 ha-3d-home/scripts/fix-glb-materials.py
 * 针对 Quaternius 等免费模型库的通病（3D 场景发黑根源）：
 * 1. baseColorFactor 未做 sRGB→线性转换 → 无贴图且过暗的材质 gamma 提亮 pow(c, 1/2.2)（幂等）
 * 2. metallic 偏高（无环境贴图接近全黑）→ metallic 置 0，roughness 抬到 >= 0.7
 * 3. 移除 KHR_materials_specular / KHR_materials_emissive_strength 压暗扩展
 * 判定规则与 Python 版一致，可重复运行（修过的不重复调整）。
 */
const GAMMA = 1.0 / 2.2;
const DARK_MAX = 0.25;    // 最亮通道低于此值视为「sRGB 被当线性存」
const BLACK_MAX = 0.05;   // 低于此值视为有意的纯黑，不动颜色

function fixMaterials(gltf) {
  const problems = [];
  const notes = [];
  let n = 0;
  const mats = gltf.materials || [];
  mats.forEach((mat, i) => {
    const name = mat.name || `material#${i}`;
    if (!mat.pbrMetallicRoughness) mat.pbrMetallicRoughness = {};
    const pbr = mat.pbrMetallicRoughness;
    const hasTex = 'baseColorTexture' in pbr;
    // 1) 无贴图 → 过暗才提亮；纯黑视为有意，只提示不动
    if (!hasTex && Array.isArray(pbr.baseColorFactor) && pbr.baseColorFactor.length >= 3) {
      const f = pbr.baseColorFactor;
      const bright = Math.max(f[0], f[1], f[2]);
      if (bright <= BLACK_MAX) {
        notes.push(`${name}: 纯黑颜色（视为有意，不调整亮度）`);
      } else if (bright < DARK_MAX) {
        problems.push(`${name}: 颜色过暗 max=${bright.toFixed(3)}（sRGB 被当线性存），gamma 提亮`);
        const rgb = f.slice(0, 3).map((c) => Math.pow(Math.min(Math.max(c, 0), 1), GAMMA));
        pbr.baseColorFactor = rgb.concat(f.slice(3));
        n += 1;
      }
    }
    // 2) 压 metallic、抬 roughness（factor 与贴图相乘，有贴图同样有效）
    const metallic = 'metallicFactor' in pbr ? pbr.metallicFactor : 1.0;
    if (metallic > 0.05) {
      const tag = 'metallicRoughnessTexture' in pbr ? '（factor 会与贴图相乘，可整体归零）' : '（无环境贴图会发黑）';
      problems.push(`${name}: metallic=${Number(metallic).toFixed(2)} 偏高${tag}，压到 0`);
      pbr.metallicFactor = 0.0;
      n += 1;
    }
    const roughness = 'roughnessFactor' in pbr ? pbr.roughnessFactor : 1.0;
    if (roughness < 0.7) {
      problems.push(`${name}: roughness=${Number(roughness).toFixed(2)} 偏低（高光刺眼），抬到 0.7`);
      pbr.roughnessFactor = 0.7;
      n += 1;
    }
    // 3) 清掉可能压暗整体的 KHR 扩展
    if (mat.extensions) {
      for (const ext of ['KHR_materials_specular', 'KHR_materials_emissive_strength']) {
        if (ext in mat.extensions) {
          problems.push(`${name}: 移除压暗扩展 ${ext}`);
          delete mat.extensions[ext];
          n += 1;
        }
      }
      if (!Object.keys(mat.extensions).length) delete mat.extensions;
    }
  });
  return { changed: n, problems, notes };
}

/* 解析 GLB → { json, jsonLen }；非 GLB 抛错
 * 布局: magic(0-3) version(4-7) total(8-11) | chunk0 len(12-15) type(16-19) | json... */
function parseGlb(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46546c67) throw new Error('非 GLB 文件');
  if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error('GLB 首 chunk 不是 JSON');
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
  return { json, jsonLen };
}

function writeGlb(buf, jsonLen, json) {
  let newJson = Buffer.from(JSON.stringify(json), 'utf8');
  const pad = (4 - (newJson.length % 4)) % 4;   // JSON chunk 4 字节对齐，空格填充
  if (pad) newJson = Buffer.concat([newJson, Buffer.alloc(pad, 0x20)]);
  const binChunk = buf.slice(20 + jsonLen);
  const total = 12 + 8 + newJson.length + binChunk.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);   // magic 'glTF'
  out.writeUInt32LE(2, 4);            // version
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(newJson.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);  // 'JSON'
  newJson.copy(out, 20);
  binChunk.copy(out, 20 + newJson.length);
  return out;
}

/* 修复一个 GLB Buffer。返回 { data, changed, problems, notes }；无可修项时 changed=0 */
function fixGlbMaterials(buf) {
  const { json, jsonLen } = parseGlb(buf);
  const { changed, problems, notes } = fixMaterials(json);
  return { data: writeGlb(buf, jsonLen, json), changed, problems, notes };
}

module.exports = { fixGlbMaterials };
