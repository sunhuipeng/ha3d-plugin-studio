/* 模型域工具：upload_model / get_model / list_models / split_model / delete_model / rename_model / fix_model_materials
 *
 * GLB 边界（2026-11-12 定）：本域只做「静态文件集合」的文件级操作 + 两类服务端写操作。
 *   · 服务端保留：split_model（拆分，split-glb.js 需逐顶点烘焙）、fix_model_materials（修材质发黑）；
 *     设备/背景插件编辑页的「部件」面板也走同一套 HTTP 路由，不能动。
 *   · 服务端不再解析 GLB 内容：get_model / list_models 只返回文件信息 + 完整 url（路径），
 *     AI 用 MCP 服务器地址拼接后自行下载；节点树 / 顶点 / 包围盒 / 尺寸 / 材质明细在本地用
 *     Python 或 Node.js 直接解析（零依赖读二进制容器，不引 three.js 等第三方库，见 H.GLB_PARSE）。
 *   · MCP 不写任何本机文件：没有 saveTo 参数，也不复制 glb 到磁盘。
 *   · 删除模型只对插件项目开放；家具包请用 tools-catalog.js 的 studio_delete_catalog_items（要同步维护 catalog.items）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const { modelsDir, ensureDir, readProject } = require('../lib/config');
const { splitGlb, splitGlbOne } = require('../lib/split-glb');
const { fixGlbMaterials } = require('../lib/fixglb');
const hub = require('../lib/ws-hub');
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
    '取项目内 models/ 目录某个 glb 的**下载地址 + 文件基本信息**（字节数 / 魔数校验 / 完整 url）。'
    + '返回的 url 是完整路径（如 /api/projects/<projectId>/models/frame.glb），不含 http:// 主机与端口——'
    + '**把它拼到你连接 MCP 服务器的地址后面，用 curl / 本地脚本直接下载这个 .glb**。'
    + 'MCP 本身不写任何本机文件（没有 saveTo 参数）。'
    + '服务端不解析 GLB 内容：节点树、顶点/三角面、包围盒 w·d·h、材质贴图、动画等详细数据，'
    + '都下载到本机后用 Python 或 Node.js 自己解析（GLB = 12 字节头 + JSON chunk + BIN chunk，读 accessors 即可，'
    + '零依赖，不要引入 three.js 等第三方库）；'
    + '改好的模型用 studio_upload_model 覆盖上传（家具包用 studio_upload_catalog_model）',
    {
      projectId: z.string().optional(),
      file: z.string().describe('模型文件名（见 studio_get_project 返回的 models[].file，如 frame.glb）'),
    },
    async ({ projectId, file }) => {
      try {
        const pid = H.requirePid(projectId);
        const name = path.basename(String(file || ''));
        if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
          throw new Error('file 参数不合法（只取文件名，防目录穿越）: ' + name);
        }
        const src = path.join(modelsDir(pid), name);
        if (!fs.existsSync(src)) {
          const have = H.modelsWithSize(pid).map((m) => m.file).join(', ') || '（无）';
          throw new Error('模型不存在: ' + name + '（该项目现有: ' + have + '）');
        }
        const buf = fs.readFileSync(src);
        const isGlb = buf.length >= 12 && buf.readUInt32LE(0) === 0x46546c67;
        const url = `/api/projects/${pid}/models/${encodeURIComponent(name)}`;
        return H.text({
          ok: true,
          projectId: pid,
          file: name,
          url,
          bytes: buf.length,
          format: isGlb ? 'glb' : 'unknown',
          hint: isGlb
            ? '把 url 拼到你连接的 MCP 服务器地址后即可下载该 .glb；MCP 不写本机文件。'
              + '下载后用 Python 或 Node.js 自己解析（12 字节头 + JSON chunk + BIN chunk，读 accessors 拿节点树/包围盒/材质，'
              + '零依赖即可，不要引入 three.js 等第三方库）；解析出的节点名可用于 studio_split_model 的 node 参数'
            : '文件头不是 GLB 魔数：可能不是有效 glb，下载后请用 Python / Node.js 自行核对文件内容',
        });
      } catch (e) { return H.fail(e.message); }
    },
  );

  /* ---------------- 模型列表 ---------------- */

  server.tool(
    'studio_list_models',
    '列出当前项目 models/ 里的全部模型（不传 projectId 就是当前打开的项目）：文件名、大小、更新时间、被代码引用的行数、HTTP URL。'
    + '只返回文件信息，不解析 GLB 内容；每项都带完整 url 路径，拼上 MCP 服务器地址即可下载，'
    + '需要结构/包围盒/材质时下载后用 Python 或 Node.js 自己解析（零依赖，不要引入 three.js 等第三方库）。上传、删除、改名前后对账用',
    {
      projectId: z.string().optional(),
    },
    async ({ projectId }) => {
      try {
        const pid = H.requirePid(projectId);
        const code = String(readProject(pid).customJs || '');
        const files = H.modelsWithSize(pid).map((m) => {
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
      node: z.string().optional().describe('只导出这个顶层节点：节点名按 studio_get_model 的 url 下载 glb 后，用 Python 或 Node.js 读 nodes[].name 得到（零依赖，不要引 three.js 等第三方库）；也可在编辑页「部件」面板查看；省略 = 全部拆开'),
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
    '删除插件项目 models/ 里的模型文件（试错上传的、拆分剩下的都可清）。会先扫一遍代码，把仍在引用该文件的代码行一起返回，避免删完留下死引用。'
    + '**家具包项目请用 studio_delete_catalog_items**（删家具还要同步维护 catalog.items）',
    {
      projectId: z.string().optional(),
      file: z.string().describe('要删除的模型文件名，如 old.glb'),
    },
    async ({ projectId, file }) => {
      try {
        const pid = H.requirePid(projectId);
        const proj = readProject(pid);
        if ((proj.plugin || {}).kind === 'catalog') {
          return H.fail('家具包项目不能用 studio_delete_model（只删文件会让 catalog.items 留下失效条目）。'
            + '请用 studio_delete_catalog_items {itemIds:[...]} 按家具条目删除');
        }
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

  /* 批量删除模型（公共能力）：一次可传多个文件，插件项目与家具包项目通用。
   * 家具包里「一个 GLB = 一条清单条目」，默认连引用它的条目一起移除，避免留下空引用；
   * 插件项目只删文件，并把代码里仍引用该文件的位置一并返回。 */
  server.tool(
    'studio_delete_models',
    '一次删除插件项目 models/ 里指定的多个模型文件（files 数组，重复/不存在的会被去重或报告，不会中断整批）。'
    + '**只服务插件编辑页（设备 / 背景插件）**：只删文件，返回每个文件在代码里的引用行（codeRefs）提醒改代码。'
    + '家具包项目（kind: catalog）请改用 studio_delete_catalog_items——删家具时除了模型文件，'
    + '还要同步维护 project.json 里的 catalog.items，本工具不做这件事，所以会直接拒绝。'
    + 'dryRun=true 只返回删除计划、不落盘',
    {
      projectId: z.string().optional(),
      files: z.array(z.string()).optional().describe('要删除的模型文件名数组，如 ["a.glb","b.glb"]'),
      dryRun: z.boolean().optional().describe('默认 false；true 只返回计划，不删文件'),
    },
    async ({ projectId, files, dryRun }) => {
      try {
        const pid = H.requirePid(projectId);
        const proj = readProject(pid);
        if ((proj.plugin || {}).kind === 'catalog') {
          return H.fail('家具包项目不能用 studio_delete_models（只删模型文件会让 catalog.items 留下失效条目）。'
            + '请用 studio_delete_catalog_items {itemIds:[...]} 按家具条目删除，它会同步维护清单与模型文件');
        }
        const dir = modelsDir(pid);
        const requested = [];
        const invalid = [];
        for (const raw of (Array.isArray(files) ? files : [])) {
          const name = path.basename(String(raw || '').trim());
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.glb$/i.test(name)) { invalid.push(String(raw)); continue; }
          if (!requested.includes(name)) requested.push(name);
        }
        if (!requested.length) {
          return H.fail('没有可删除的模型：请传 files（多个文件名）。'
            + (invalid.length ? ` 非法文件名：${invalid.join(', ')}` : ''));
        }

        /* 先算完整计划再动手：缺文件 / 非法名都只是逐条报告，不影响其它文件 */
        const plan = [];
        const codeRefs = {};
        for (const name of requested) {
          const abs = path.join(dir, name);
          const exists = fs.existsSync(abs);
          const refs = exists ? H.codeRefLines(pid, name) : [];
          if (refs.length) codeRefs[name] = refs;
          plan.push({
            file: name, exists,
            bytes: exists ? fs.statSync(abs).size : 0,
            codeRefs: refs.length,
            action: exists ? 'delete' : 'notFound',
          });
        }
        const toDelete = plan.filter((p) => p.action === 'delete').map((p) => p.file);
        const notFound = plan.filter((p) => p.action === 'notFound').map((p) => p.file);

        if (dryRun) {
          return H.text({
            ok: true, dryRun: true, projectId: pid,
            plan, toDelete, notFound, invalid, codeRefs,
            hint: '这是预演：没有删任何文件；去掉 dryRun 才会真正执行',
          });
        }

        const deleted = [];
        for (const name of toDelete) {
          fs.unlinkSync(path.join(dir, name));
          deleted.push(name);
        }
        const notified = hub.notify(pid, { type: 'refresh', what: 'models', files: deleted });
        return H.text({
          ok: true, projectId: pid,
          requested, deleted, notFound, invalid, codeRefs,
          remaining: H.modelsOut(pid), notified,
          warning: [
            Object.keys(codeRefs).length ? `代码里仍有引用：${Object.keys(codeRefs).join(', ')}，详见 codeRefs` : '',
            notFound.length ? `未找到：${notFound.join(', ')}` : '',
            invalid.length ? `文件名不合法已跳过：${invalid.join(', ')}` : '',
          ].filter(Boolean).join('；'),
          hint: '模型文件已删除；如 codeRefs 非空，请改掉代码里的引用再提交',
        });
      } catch (e) { return H.fail(e.message); }
    },
  );
}

module.exports = { register };
