/* 远程安装的共用段：插件包（plugin-pkg.js）与家具包（catalog-pkg.js）发布时
 * 都要「POST 到 home 安装接口 → 校验应答 → 版本号落盘」，这段逻辑逐字一致，
 * 收在这里避免两份拷贝各自演化（曾经 404 提示文案已经分叉）。
 */
'use strict';

const { writeProject } = require('./config');

/* POST {host}/api/plugins/install?id&version（zip body + 安装密钥头）。
 * remote = assertPublishTarget() 的返回（{ host, key }）。
 * 成功（HTTP 200 且应答是 {"ok":true,...}）静默返回；其余 throw 带可读信息。 */
async function postInstallZip(remote, manifest, buf) {
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
    const notImpl = resp.status === 404 || resp.status === 405;
    throw new Error(`ha-3d-home 安装接口返回 ${resp.status}: ${msg || resp.statusText}`
      + (notImpl ? '（目标地址没有安装接口，请确认填的是 ha-3d-home 的主机地址而不是其它服务）' : ''));
  }
  /* 200 也不一定是安装接口：地址写错时可能命中别的 Web 服务（很多设备/网页对任意 POST 都回 200）。
   * home 安装接口的成功应答固定是 JSON { ok: true, ... }，不符合一律当失败，绝不假装发布成功。 */
  let ack;
  try { ack = JSON.parse(bodyText); } catch (e) { ack = null; }
  if (!ack || ack.ok !== true) {
    throw new Error('目标地址返回了 200，但不是 ha-3d-home 安装接口的应答（应为 {"ok":true,...}）。'
      + `请检查发布目标地址（当前：${remote.host}）是否填成了 ha-3d-home 的主机地址`);
  }
}

/* 安装成功 → 版本号落盘（下次 bump 在此基础上 +1）；models 是运行期注入字段，不写回 */
function savePublishedVersion(projectId, proj, manifest) {
  proj.plugin.version = manifest.version;
  delete proj.models;
  writeProject(projectId, proj);
}

module.exports = { postInstallZip, savePublishedVersion };
