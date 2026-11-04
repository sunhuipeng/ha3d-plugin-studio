#!/usr/bin/env node
/* 通用 MCP 工具调用器（ha3d-plugin-studio）
 *
 * 用法:
 *   node mcp-call.cjs <tool> ['{json 参数}'] [图片输出.png]
 *
 * 示例:
 *   node mcp-call.cjs studio_get_project
 *   node mcp-call.cjs studio_get_project
 *   node mcp-call.cjs studio_write_code "$(cat /tmp/door-plugin.js)"
 *   node mcp-call.cjs studio_set_entity '{"entityId":"binary_sensor.preview_door_entity","state":"on"}'
 *   node mcp-call.cjs studio_screenshot '{"view":"iso","width":720,"height":560}' /tmp/shot.png
 *
 * 说明:
 *   - 文本结果按原文打印（JSON）；studio_screenshot 的图片存到第三个参数（默认 /tmp/mcp-shot.png）。
 *   - 依赖 studio 项目的 @modelcontextprotocol/sdk，用 createRequire 从 studio 根解析，脚本放哪都能跑。
 *   - studio 根自动探测：环境变量 HA3D_STUDIO → 本 skill 所属仓库根（skill 放在 <studio>/skill/ 时）
 *     → ~/WorkBuddy/home/ha3d-plugin-studio → 当前目录。都找不到就 export HA3D_STUDIO=项目根。
 *   - 服务不在线时先启动: cd $HA3D_STUDIO && node server/index.js
 */
'use strict';
const { createRequire } = require('module');
const path = require('path');
const os = require('os');

const fs = require('fs');

/* 找 studio 项目根：认 server/index.js + package.json 同时存在 */
function resolveStudio() {
  const cands = [
    process.env.HA3D_STUDIO,
    path.resolve(__dirname, '../../..'),                                  // <studio>/skill/ha3d-plugin-dev/scripts
    path.resolve(__dirname, '../../../../ha3d-plugin-studio'),            // 与 <本skill> 同级
    path.join(os.homedir(), 'WorkBuddy/home/ha3d-plugin-studio'),
    process.cwd(),
  ].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'server/index.js')) && fs.existsSync(path.join(c, 'package.json'))) return c;
  }
  console.error(
    '找不到 ha3d-plugin-studio 项目根。请设置环境变量后重试，例如：\n' +
    '  HA3D_STUDIO=/path/to/ha3d-plugin-studio node mcp-call.cjs studio_get_project'
  );
  process.exit(1);
}

const STUDIO = resolveStudio();
const req = createRequire(STUDIO + '/package.json');
const { Client } = req('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = req('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const [tool, argsJson, imgOut] = process.argv.slice(2);
  if (!tool) {
    console.error('用法: node mcp-call.cjs <tool> [json-args] [image-out.png]');
    process.exit(1);
  }
  const client = new Client({ name: 'skill-helper', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:8098/mcp/sse')));
  try {
    const r = await client.callTool({ name: tool, arguments: argsJson ? JSON.parse(argsJson) : {} });
    const img = (r.content || []).find((c) => c.type === 'image');
    if (img) {
      const p = imgOut || '/tmp/mcp-shot.png';
      fs.writeFileSync(p, Buffer.from(img.data, 'base64'));
      const meta = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      console.log(JSON.stringify({ imageSaved: p }));
      if (meta) console.log(meta);
    } else if (r.isError) {
      console.error('TOOL_ERROR: ' + (r.content || []).map((c) => c.text).join('\n'));
      process.exit(2);
    } else {
      console.log((r.content || []).map((c) => c.text).join('\n'));
    }
  } finally {
    await client.close();
  }
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
