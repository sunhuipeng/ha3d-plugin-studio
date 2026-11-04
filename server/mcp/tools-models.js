/* 模型域工具：upload_model / get_model / list_models / split_model / delete_model / rename_model / fix_model_materials */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { z } = require('zod');
const { modelsDir, ensureDir, readProject } = require('../config');
const { splitGlb, splitGlbOne } = require('../split-glb');
const { fixGlbMaterials } = require('../fixglb');
const hub = require('../ws-hub');
const H = require('./helpers');

function register(server) {
  server.tool(
    'studio_upload_model',
    '把本机 GLB 上传到项目 models 目录（代码里 glb("xxx.glb") 引用的文件）。服务端先落盘，再通知前端刷新模型列表',
    {
      projectId: z.string().optional(),
      filePath: z.string().describe('本机 GLB 文件的绝对路径'),
      name: z.string().optional().describe('保存到项目里的文件名，默认沿用源文件名'),
    },
    async ({ projectId, filePath, name }) => {
      try {
        const pid = H.requirePid(projectId);
        if (!fs.existsSync(filePath)) throw new Error('文件不存在: ' + filePath);
        const src = path.resolve(filePath);
        if (path.extname(src).toLowerCase() !== '.glb') throw new Error('仅支持 .glb 文件');
        const fileName = name ? path.basename(name) : path.basename(src);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.glb$/i.test(fileName)) throw new Error('目标文件名不合法: ' + fileName);
        const dir = modelsDir(pid);
        ensureDir(dir);
        const dest = path.join(dir, fileName);
        fs.copyFileSync(src, dest);
        const url = `/api/projects/${pid}/models/${encodeURIComponent(fileName)}`;
        const notified = hub.notify(pid, { type: 'refresh', what: 'models', file: fileName });
        return H.text({ ok: true, projectId: pid, file: fileName, url, size: fs.statSync(dest).size, notified });
      } catch (e) { return H.fail(e.message); }
    },
  );

  server.tool(
    'studio_get_model',
    '把项目内 models/ 目录的 glb 模型导出（复制）到本机文件系统并返回绝对路径 + 结构摘要（网格/节点/材质/动画数、包围盒尺寸），AI 拿到路径后可用本地脚本深入分析模型（尺寸、顶点、部件拆解等）',
    {
      projectId: z.string().optional(),
      file: z.string().describe('模型文件名（见 studio_get_project 返回的 models[].file，如 frame.glb）'),
      saveTo: z.string().optional().describe('导出目标：目录（可以不存在，如 /tmp/models，会自动建）或完整文件路径（如 /tmp/models/frame.glb）；省略时存到系统临时目录 ha3d-models/<projectId>/ 下'),
    },
    async ({ projectId, file, saveTo }) => {
      try {
        const pid = H.requirePid(projectId);
        const name = path.basename(String(file || ''));
        if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/i.test(name)) {
          throw new Error('file 参数不合法（只取文件名，防目录穿越）: ' + name);
        }
        const src = path.join(modelsDir(pid), name);
        if (!fs.existsSync(src)) {
          const have = H.modelsWithSize(pid).map((m) => m.file).join(', ') || '（无）';
          throw new Error('模型不存在: ' + name + '（该项目现有: ' + have + '）');
        }
        /* 解析导出目标：目录 → 追加文件名；否则按完整路径。
         * 目录判定（宽松）：已存在的目录 / 以分隔符结尾 / 没有扩展名 / 扩展名不是模型后缀。
         * 否则 AI 传 /tmp/modeldump 这种「想当目录用的路径」会被写成无后缀文件。 */
        let dest;
        if (saveTo) {
          const abs = path.resolve(saveTo);
          const ex = path.extname(abs).toLowerCase();
          const isDir = /[\\/]$/.test(String(saveTo))
            || (fs.existsSync(abs) && fs.statSync(abs).isDirectory())
            || !ex
            || !/^\.(glb|gltf|bin)$/.test(ex);
          dest = isDir ? path.join(abs, name) : abs;
        } else {
          dest = path.join(os.tmpdir(), 'ha3d-models', pid, name);
        }
        ensureDir(path.dirname(dest));
        fs.copyFileSync(src, dest);

        const buf = fs.readFileSync(src);
        return H.text({
          ok: true,
          projectId: pid,
          file: name,
          savedTo: dest,
          bytes: buf.length,
          glb: H.glbSummary(buf),
        });
      } catch (e) { return H.fail(e.message); }
    },
  );

  /* ---------------- 模型列表 ---------------- */

  server.tool(
    'studio_list_models',
    '列出当前项目 models/ 里的全部模型（不传 projectId 就是当前打开的项目）：文件名、大小、更新时间、被代码引用的行数；withSummary=true 时再附 glb 结构摘要（mesh/节点/材质数 + 包围盒尺寸）。上传、删除、改名前后对账用',
    {
      projectId: z.string().optional(),
      withSummary: z.boolean().optional().describe('是否解析 glb 结构（默认 false；模型多/大时慢，最多解析前 20 个）'),
    },
    async ({ projectId, withSummary }) => {
      try {
        const pid = H.requirePid(projectId);
        const code = String(readProject(pid).customJs || '');
        const files = H.modelsWithSize(pid).map((m, i) => {
          const abs = path.join(modelsDir(pid), m.file);
          const st = fs.statSync(abs);
          const refs = code.split('\n').filter((l) => l.includes(m.file)).length;
          const row = {
            file: m.file,
            size: m.size,
            updatedAt: st.mtime.toISOString(),
            codeRefs: refs,
            url: `/api/projects/${pid}/models/${encodeURIComponent(m.file)}`,
          };
          /* 摘要最多解析前 20 个，避免一次读几十个大文件把工具卡住 */
          if (withSummary && i < 20) {
            try {
              row.glb = (() => {
                const g = H.glbSummary(fs.readFileSync(abs));
                return { meshes: g.meshes, nodes: g.nodes, materials: g.materials, animations: g.animations, size: g.bbox && g.bbox.size };
              })();
            } catch (e) { row.glb = { error: e.message }; }
          }
          return row;
        });
        return H.text({
          ok: true,
          projectId: pid,
          projectName: readProject(pid).name || '',
          count: files.length,
          totalBytes: files.reduce((n, f) => n + f.size, 0),
          unused: files.filter((f) => f.codeRefs === 0).map((f) => f.file),
          models: files,
          hint: files.length ? '' : '这个项目还没有模型：用 studio_upload_model 上传，或让用户在设计器里导入',
        });
      } catch (e) { return H.fail(e.message); }
    },
  );

  /* ---------------- 模型拆分 / 删除 / 改名 ---------------- */

  server.tool(
    'studio_split_model',
    '把一个 GLB 按顶层节点拆成多个独立 .glb（每个部件一份，顶点已烘焙世界变换、模型位于原点）。传 node 只导出该节点；拆出的部件可单独做动画/材质/显隐，比在一个大模型里靠名称找部件稳',
    {
      projectId: z.string().optional(),
      file: z.string().describe('要拆的模型文件名，如 door.glb'),
      node: z.string().optional().describe('只导出这个顶层节点（节点名见 studio_get_model 返回的 nodeList[].name）；省略 = 全部拆开'),
    },
    async ({ projectId, file, node }) => {
      try {
        const pid = H.requirePid(projectId);
        const name = path.basename(String(file || ''));
        if (!/\.glb$/i.test(name)) throw new Error('仅支持 .glb 文件: ' + name);
        const src = path.join(modelsDir(pid), name);
        if (!fs.existsSync(src)) {
          const have = H.modelsWithSize(pid).map((m) => m.file).join(', ') || '（无）';
          throw new Error('模型不存在: ' + name + '（该项目现有: ' + have + '）');
        }
        const base = name.replace(/\.glb$/i, '');
        const buf = fs.readFileSync(src);
        const dir = modelsDir(pid);
        ensureDir(dir);
        const parts = node ? splitGlbOne(buf, base, String(node).trim()) : splitGlb(buf, base);
        const created = [];
        for (const p of parts) {
          const dest = path.join(dir, p.file);
          fs.writeFileSync(dest, p.data);
          created.push({ file: p.file, node: p.node, size: p.data.length });
        }
        hub.notify(pid, { type: 'refresh', what: 'models' });
        return H.text({
          ok: true,
          projectId: pid,
          source: name,
          mode: node ? 'single' : 'all',
          created,
          models: H.modelsOut(pid),
          hint: '拆出的部件在原点、无变换：加载后自己摆位置。代码里用 ctx.glb("<文件名>") 分别加载。',
        });
      } catch (e) { return H.fail(e.message); }
    },
  );

  server.tool(
    'studio_delete_model',
    '删除项目 models/ 里的模型文件（试错上传的、拆分剩下的都可清）。会先扫一遍代码，把仍在引用该文件的代码行一起返回，避免删完留下死引用',
    {
      projectId: z.string().optional(),
      file: z.string().describe('要删除的模型文件名，如 old.glb'),
    },
    async ({ projectId, file }) => {
      try {
        const pid = H.requirePid(projectId);
        const name = path.basename(String(file || ''));
        if (!/\.glb$/i.test(name)) throw new Error('仅支持 .glb 文件: ' + name);
        const target = path.join(modelsDir(pid), name);
        if (!fs.existsSync(target)) {
          const have = H.modelsWithSize(pid).map((m) => m.file).join(', ') || '（无）';
          throw new Error('模型不存在: ' + name + '（该项目现有: ' + have + '）');
        }
        const refs = H.codeRefLines(pid, name);
        const size = fs.statSync(target).size;
        fs.unlinkSync(target);
        hub.notify(pid, { type: 'refresh', what: 'models' });
        return H.text({
          ok: true,
          projectId: pid,
          deleted: name,
          bytes: size,
          codeRefs: refs,
          warning: refs.length
            ? `代码里仍有 ${refs.length} 处引用「${name}」，预览会加载失败：请用 studio_get_code 取全文，改掉这些行后再 studio_write_code 提交`
            : '',
          models: H.modelsOut(pid),
        });
      } catch (e) { return H.fail(e.message); }
    },
  );

  server.tool(
    'studio_rename_model',
    '重命名项目 models/ 里的模型文件（统一命名、去掉临时后缀）。会扫描代码里对旧文件名的引用并一起返回，方便同一次改动里把代码改齐',
    {
      projectId: z.string().optional(),
      file: z.string().describe('原文件名，如 frame_v2.glb'),
      to: z.string().describe('新文件名，必须以 .glb 结尾，如 frame.glb'),
    },
    async ({ projectId, file, to }) => {
      try {
        const pid = H.requirePid(projectId);
        const from = path.basename(String(file || ''));
        const destName = path.basename(String(to || ''));
        if (!/\.glb$/i.test(from)) throw new Error('仅支持 .glb 文件: ' + from);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.glb$/i.test(destName)) throw new Error('新文件名不合法（字母数字开头、仅 .glb）: ' + destName);
        if (from === destName) throw new Error('新文件名与原文件名相同');
        const src = path.join(modelsDir(pid), from);
        const dest = path.join(modelsDir(pid), destName);
        if (!fs.existsSync(src)) {
          const have = H.modelsWithSize(pid).map((m) => m.file).join(', ') || '（无）';
          throw new Error('模型不存在: ' + from + '（该项目现有: ' + have + '）');
        }
        if (fs.existsSync(dest)) throw new Error('目标文件已存在: ' + destName + '（先删掉它，或换一个名字）');
        const refs = H.codeRefLines(pid, from);
        fs.renameSync(src, dest);
        hub.notify(pid, { type: 'refresh', what: 'models' });
        return H.text({
          ok: true,
          projectId: pid,
          from,
          to: destName,
          codeRefs: refs,
          hint: refs.length
            ? `代码里 ${refs.length} 处仍在用旧文件名「${from}」，不改会加载失败：取全文替换成「${destName}」后 studio_write_code 提交`
            : '代码里没有引用旧文件名，无需改代码',
          models: H.modelsOut(pid),
        });
      } catch (e) { return H.fail(e.message); }
    },
  );

  server.tool(
    'studio_fix_model_materials',
    '修复 GLB 材质发黑（3D 场景里模型发暗最常见的原因）：① baseColorFactor 未做 sRGB→线性转换 → gamma 提亮；② metallic 偏高（无环境贴图会发黑）→ 压到 0；③ roughness 偏低 → 抬到 0.7；④ 移除 KHR_materials_specular / KHR_materials_emissive_strength 压暗扩展。与编辑页模型卡片上的「修复材质」按钮同一套逻辑，可重复运行（修过的不会重复调整）。**原地改写、不生成备份**（幂等，可反复跑）。默认修 models/ 下全部 .glb，也可只修一个；dryRun=true 时只体检不写盘',
    {
      projectId: z.string().optional(),
      file: z.string().optional().describe('只修这一个模型文件，如 nightstand.glb；不传 = 修 models/ 下全部 .glb'),
      dryRun: z.boolean().optional().describe('只报告问题、不写文件（默认 false = 直接修）'),
    },
    async ({ projectId, file, dryRun }) => {
      try {
        const pid = H.requirePid(projectId);
        const all = H.modelsWithSize(pid).map((m) => m.file);
        if (!all.length) throw new Error('该项目 models/ 里还没有 .glb 模型（先用 studio_upload_model 传一个）');
        let targets = all;
        if (file) {
          const name = path.basename(String(file));
          if (!all.includes(name)) throw new Error('模型不存在: ' + name + '（现有: ' + all.join(', ') + '）');
          targets = [name];
        }
        const results = [];
        const bumped = [];
        let totalChanged = 0;
        for (const name of targets) {
          const p = path.join(modelsDir(pid), name);
          const buf = fs.readFileSync(p);
          let r;
          try { r = fixGlbMaterials(buf); }
          catch (e) { results.push({ file: name, ok: false, error: 'GLB 解析失败: ' + e.message }); continue; }
          const item = {
            file: name,
            ok: true,
            changed: r.changed,
            bytesBefore: buf.length,
            problems: r.problems,
            notes: r.notes,
          };
          if (r.changed > 0 && !dryRun) {
            /* 原地改写、不备份（幂等，可反复跑；源文件由用户自己保管） */
            fs.writeFileSync(p, r.data);
            item.bytesAfter = fs.statSync(p).size;
            bumped.push(name);
          }
          totalChanged += r.changed;
          results.push(item);
        }
        if (bumped.length) hub.notify(pid, { type: 'refresh', what: 'models', files: bumped, bump: true });
        return H.text({
          ok: true,
          projectId: pid,
          dryRun: !!dryRun,
          totalChanged,
          results,
          hint: totalChanged === 0
            ? '材质健康，无需修复'
            : (dryRun
              ? '以上是体检结果（没有写盘）；确认后去掉 dryRun 再调一次即可修复'
              : '已原地写盘（不留备份）。材质在 glb 内部，代码不用改；前端会自动绕过缓存重载模型（缩略图与画布同步刷新）'),
          models: H.modelsOut(pid),
        });
      } catch (e) { return H.fail(e.message); }
    },
  );
}

module.exports = { register };
