/* 插件打包 + 远程发布（publish.js 的 HTTP 端点与 mcp-tools.js 的 MCP 工具共用）
 *
 * zip 包内结构（无顶层目录）:
 *   plugin.json   插件清单（id = 项目 id，含 version）
 *   plugin.js     注册代码
 *   models/*.glb  模型（可选：没有模型时包里不出现 models 条目，安装端也不会留空目录）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { PROJECTS_DIR, safeId, readProject, modelsDir, listModels, assertPublishTarget } = require('./config');
const { buildAll, validate } = require('./generator');
const { postInstallZip, savePublishedVersion } = require('./remote-install');

/* 项目打包成内存 zip（proj.models 需已注入模型清单） */
async function buildPluginZip(proj, built, projectId) {
  const zip = new JSZip();
  zip.file('plugin.json', JSON.stringify(built.manifest, null, 2) + '\n');
  zip.file('plugin.js', built.js);
  const copied = [];
  for (const file of proj.models) {
    const src = path.join(modelsDir(projectId), file);
    if (fs.existsSync(src)) { zip.file('models/' + file, fs.readFileSync(src)); copied.push(file); }
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buf, copied };
}

/* 项目文件夹整体打包（项目备份：project.json + preview.png + models/ 原样收入，不做校验/注入/版本处理）。
 * backups/ 是编辑器的内部备份，不进备份包。
 * 与 buildPluginZip 的区别：这是「源文件备份」，导出插件包是「可安装产物」。 */
async function buildProjectZip(projectId) {
  const dir = path.join(PROJECTS_DIR, safeId(projectId));
  if (!fs.existsSync(dir)) throw Object.assign(new Error('project not found'), { code: 'NOT_FOUND' });
  const zip = new JSZip();
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      if (name === 'backups') continue;   // 编辑器内部备份，不属于项目内容
      const r = rel ? rel + '/' + name : name;
      if (fs.statSync(path.join(dir, r)).isDirectory()) walk(r);
      else zip.file(r, fs.readFileSync(path.join(dir, r)));
    }
  };
  walk('');
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return buf;
}

/* 导出/发布共用前置：读项目 → 注入 models → 校验 → 构建 → 打包。
 * publish.js 的 /export、MCP 的 studio_export_project、publishProject 三处共用，保证
 * 「校验口径 + zip 内容」完全一致。
 * 返回 { proj, built, buf, copied, warnings }；项目不存在 throw code=NOT_FOUND，
 * 配置有 error 级问题 throw code=INVALID（带 warnings），调用方自行转成各自的错误形态。 */
async function prepareExportZip(projectId, { bump = false } = {}) {
  let proj;
  try { proj = readProject(projectId); }
  catch (e) { throw Object.assign(new Error('project not found'), { code: 'NOT_FOUND' }); }

  /* 运行时注入 models：validate 的模型检查与打包都要用，不写回文件。
   * 注意必须先注入再 validate，否则「没有 GLB 模型」的警告恒误报 */
  proj.models = listModels(projectId);

  /* 家具项目（catalog）不是插件：产物是 item.json + glb 的家具包，走 catalog-pkg.js */
  if (proj.plugin && proj.plugin.kind === 'catalog') {
    throw Object.assign(new Error('这是家具项目（catalog），不能导出/发布成插件包；请用「导出家具包」'),
      { code: 'INVALID', warnings: [] });
  }

  const warnings = validate(proj);
  const errs = warnings.filter((w) => w.level === 'error');
  if (errs.length) {
    throw Object.assign(
      new Error('配置有问题，无法导出: ' + errs.map((w) => w.message || w.text || JSON.stringify(w)).join('; ')),
      { code: 'INVALID', warnings },
    );
  }

  /* 产物 = 项目原代码，原样打包（AI 输出什么样就打包什么样，不包任何注入层）；
   * 配置与代码的一致性由「AI 按快照照抄 + 面板改动后重新生成」保障 */
  const built = buildAll(proj, bump);
  const { buf, copied } = await buildPluginZip(proj, built, projectId);
  return { proj, built, buf, copied, warnings };
}

/* 完整发布流程：prepareExportZip → POST 到 ha-3d-home 安装接口。
 * 上传 / 应答校验 / 版本落盘的共用段见 remote-install.js（与家具包发布一致）。
 * 返回 { manifest, copied, remote }；失败 throw Error（带可读信息）。 */
async function publishProject(projectId, bump) {
  const { proj, built, buf, copied } = await prepareExportZip(projectId, { bump: !!bump });
  const remote = assertPublishTarget();
  await postInstallZip(remote, built.manifest, buf);
  savePublishedVersion(projectId, proj, built.manifest);
  return { manifest: built.manifest, copied, remote };
}

module.exports = { buildProjectZip, prepareExportZip, publishProject };
