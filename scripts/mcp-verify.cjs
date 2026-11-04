/* 通过 studio 自带的 MCP over SSE 调用工具（验证链路用）
 * 用法: node scripts/mcp-verify.cjs <tool> [json-args] [outImage]
 */
const fs = require('fs');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const tool = process.argv[2] || 'studio_list_projects';
  const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  const out = process.argv[4] || '';
  const transport = new SSEClientTransport(new URL('http://localhost:8098/mcp/sse'));
  const client = new Client({ name: 'mcp-verify', version: '1.0.0' });
  await client.connect(transport);
  const r = await client.callTool({ name: tool, arguments: args });
  const parts = r.content || [];
  for (const p of parts) {
    if (p.type === 'image') {
      if (out) { fs.writeFileSync(out, Buffer.from(p.data, 'base64')); console.log('IMAGE →', out); }
      else console.log('IMAGE base64 length', p.data.length);
    } else {
      console.log('TEXT:', String(p.text || '').slice(0, 1500));
    }
  }
  await client.close();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
