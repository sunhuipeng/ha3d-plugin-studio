/* 家具包（kind: "catalog"）打包 + 远程发布。
 *
 * 与插件包（plugin-pkg.js）并列但产物不同 —— 家具包交给 ha-3d-home 的家具包导入：
 *   item.json     清单：kind:"catalog" + id(项目 id) + items 数组（每个 glb 一条）
 *   <模型>.glb    各条目引用的模型，与 item.json 平铺（home 侧包内不分子目录）
 *
 * 发布走 home 的同一个远程安装接口 POST /api/plugins/install?id=<项目id>&version=<v>，
 * home 侧按包内清单 kind 分流：catalog → custom/models/<项目id>/。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { readProject, writeProject, modelsDir, listModels, remoteTarget } = require('./config');
const { buildCatalogManifest, validateCatalog } = require('./catalog-schema');

/* 项目 → { manifest, buf, copied, warnings }
 * 模型只打被条目引用的那些（没引用的留在项目里，不进包）。 */
async function buildCatalogPackage(proj, opts) {
  const o = opts || {};
  const models = Array.isArray(proj.models) ? proj.models : listModels(proj.id);
  const warnings = validateCatalog(proj, models, o.types);
  const errs = warnings.filter((w) => w.level === 'error');
  if (errs.length) {
    throw Object.assign(new Error('配置有问题，无法导出: ' + errs.map((w) => w.msg).join('；')),
      { code: 'INVALID', warnings });
  }

  const manifest = buildCatalogManifest(proj, !!o.bump);
  const zip = new JSZip();
  zip.file('item.json', JSON.stringify(manifest, null, 2) + '\n');

  const copied = [];
  const seen = new Set();
  for (const it of manifest.items) {
    const file = String(it.model || '');
    if (!file || seen.has(file)) continue;
    const src = path.join(modelsDir(proj.id), file);
    if (!fs.existsSync(src)) continue;      // 校验已拦，这里只做兜底
    zip.file(file, fs.readFileSync(src));
    copied.push(file);
    seen.add(file);
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { manifest, buf, copied, warnings };
}

/* 导出/发布共用前置：读项目 → 注入模型清单 → 打包 */
async function prepareCatalogExport(projectId, opts) {
  let proj;
  try { proj = readProject(projectId); }
  catch (e) { throw Object.assign(new Error('project not found'), { code: 'NOT_FOUND' }); }
  if (!proj.plugin || proj.plugin.kind !== 'catalog') {
    throw Object.assign(new Error('这个项目不是家具项目（kind 不是 catalog）'), { code: 'INVALID' });
  }
  proj.models = listModels(projectId);
  const { manifest, buf, copied, warnings } = await buildCatalogPackage(proj, opts);
  return { proj, manifest, buf, copied, warnings };
}

/* 发布到 ha-3d-home：POST {host}/api/plugins/install?id&version（带安装密钥）。
 * 成功后把版本号写回项目（下次 bump 在此基础上 +1）。 */
async function publishCatalog(projectId, bump) {
  const { proj, manifest, buf, copied } = await prepareCatalogExport(projectId, { bump: !!bump });
  const remote = remoteTarget();
  const url = remote.host + '/api/plugins/install'
    + '?id=' + encodeURIComponent(manifest.id)
    + '&version=' + encodeURIComponent(manifest.version);

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/zip',
        'X-Install-Key': remote.key,
        'X-Plugin-Id': manifest.id,
        'X-Plugin-Version': manifest.version,
      },
      body: buf,
    });
  } catch (e) {
    throw new Error(`无法连接 ha-3d-home（${remote.host}）: ${e.message}。请确认主机地址正确、服务已启动`);
  }
  const bodyText = await resp.text();
  if (!resp.ok) {
    let msg = bodyText;
    try { msg = JSON.parse(bodyText).error || bodyText; } catch (e) { /* 非 JSON 原样展示 */ }
    throw new Error(`ha-3d-home 安装接口返回 ${resp.status}: ${msg || resp.statusText}`);
  }

  proj.plugin.version = manifest.version;
  delete proj.models;
  writeProject(projectId, proj);
  return { manifest, copied, remote };
}

module.exports = { buildCatalogPackage, prepareCatalogExport, publishCatalog };
