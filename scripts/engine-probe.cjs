/* 引擎移植检查：验证补上的兼容垫片是否生效
 *   ctx.view.loadModel  —— 真实引擎里 ctx.view 是 View3D，插件（如 light）会用它加载自定义模型
 *   window.THREE / GLTFLoader —— 真实插件常拿它做能力判断
 * 探针插件只要有一处缺失就抛错，错误会从 studio_write_code 的 renderError 返回。
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const J = (r) => { try { return JSON.parse(r.content[0].text); } catch (e) { return r.content[0].text; } };

const PROBE = `
PluginEngine.register({
  id: 'engine_probe', kind: 'device', type: 'switch', name: '引擎探针',
  styles: [{ id: 'a', name: '探针' }],
  async model3d(ctx) {
    const T = ctx.THREE;
    if (!ctx.view || typeof ctx.view.loadModel !== 'function') throw new Error('ctx.view.loadModel 缺失');
    if (!ctx.view.render) throw new Error('ctx.view.render 缺失');
    if (!window.THREE || !window.THREE.GLTFLoader) throw new Error('window.THREE.GLTFLoader 缺失');
    const proto = await ctx.view.loadModel('models/leaf.glb');
    if (!proto) throw new Error('ctx.view.loadModel 没加载到模型');
    const g = new T.Group();
    proto.scale.setScalar(0.3);
    g.add(proto);
    return { group: g, update() {} };
  },
});
`;

(async () => {
  const client = new Client({ name: 'probe', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:8098/mcp/sse')));

  const before = J(await client.callTool({ name: 'studio_get_code', arguments: {} }));
  const w = J(await client.callTool({ name: 'studio_write_code', arguments: { code: PROBE, view: 'iso' } }));
  console.log('PROBE:', JSON.stringify({ ran: w.ran, err: w.renderError || null, pluginId: w.render && w.render.pluginId }));

  const back = J(await client.callTool({ name: 'studio_write_code', arguments: { code: String(before.code), run: false } }));
  console.log('RESTORE:', JSON.stringify({ ok: back.ok, source: back.source }));

  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
