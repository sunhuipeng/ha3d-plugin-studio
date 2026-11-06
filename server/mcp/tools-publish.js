/* 发布域工具：export_project / publish_project（打包逻辑在 ../plugin-pkg.js，与 REST 接口共用） */
'use strict';

const { z } = require('zod');
const { prepareExportZip, publishProject } = require('../plugin-pkg');
const H = require('./helpers');

function register(server) {
  server.tool(
    'studio_export_project',
    '把项目打包成插件压缩包（plugin.json + plugin.js + models/*.glb），zip 内容以 base64 放在返回的 zipBase64 字段（服务端不落盘、不留存文件）。不发布、不改版本号。配置有 error 级问题时拒绝导出（与页面「导出插件包」同一口径）',
    {
      projectId: z.string().optional().describe('项目 id，缺省用当前打开的项目'),
    },
    async ({ projectId } = {}) => {
      try {
        const pid = H.requirePid(projectId);
        const { built, buf } = await prepareExportZip(pid);
        return H.text({
          ok: true, bytes: buf.length, pluginId: built.manifest.id, version: built.manifest.version,
          zipBase64: buf.toString('base64'),
          hint: 'zip 文件内容 = zipBase64 字段 base64 解码；需要落盘时自行解码保存',
        });
      } catch (e) { return H.fail(e.message); }
    },
  );

  server.tool(
    'studio_publish_project',
    '发布插件到 ha-3d-home：打包 → POST 到远程安装接口（custom/plugins/<id>/ 整体替换）→ 成功后版本号写回项目。等价于页面右上角「发布到 ha-3d-home」按钮',
    {
      projectId: z.string().optional().describe('项目 id，缺省用当前打开的项目'),
      bump: z.boolean().optional().describe('发布前版本号 +1（建议 true，避免浏览器缓存旧 plugin.js）'),
    },
    async ({ projectId, bump } = {}) => {
      try {
        const pid = H.requirePid(projectId);
        const { manifest, copied, remote } = await publishProject(pid, !!bump);
        return H.text({
          ok: true, host: remote.host, pluginId: manifest.id, version: manifest.version, models: copied,
        });
      } catch (e) { return H.fail(e.message); }
    },
  );
}

module.exports = { register };
