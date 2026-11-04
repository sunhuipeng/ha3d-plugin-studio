/* 兼容性检查：把 ha-3d-home 的官方 door 插件原样丢进 studio 跑一遍
 * 目的：验证移植的简化引擎是否真的兼容真实插件（ctx.frame / glb / binaryRatio / animate / isOn …）
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const J = (r) => { try { return JSON.parse(r.content[0].text); } catch (e) { return r.content[0].text; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REF = '/Users/shp/WorkBuddy/home/ha-3d-home/assets/plugins/door/plugin.js';

(async () => {
  const client = new Client({ name: 'ref-door', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:8098/mcp/sse')));

  const before = J(await client.callTool({ name: 'studio_get_code', arguments: {} }));
  fs.writeFileSync(path.join(__dirname, '../_shots/code-before.js'), String(before.code));
  console.log('BACKUP: _shots/code-before.js', String(before.code).split('\n').length + ' 行');

  /* 原样写入参考插件（一字不改） */
  const refCode = fs.readFileSync(REF, 'utf8');
  const w = J(await client.callTool({ name: 'studio_write_code', arguments: { code: refCode, view: 'iso' } }));
  console.log('WRITE_REF:', JSON.stringify({ ok: w.ok, ran: w.ran, err: w.renderError || null }));
  if (w.render) {
    console.log('  RENDER: pluginId=' + w.render.pluginId, 'kind=' + w.render.kind + '/' + w.render.type,
      'label=' + JSON.stringify(w.render.label), 'size=' + JSON.stringify(w.render.size),
      'entities=' + w.render.entities.length);
  }

  await sleep(600);
  const r = await client.callTool({ name: 'studio_screenshot', arguments: { view: 'iso', width: 900, height: 620 } });
  const img = (r.content || []).find((c) => c.type === 'image');
  if (img) {
    const p = path.join(__dirname, '../_shots/ref-door-closed.png');
    fs.writeFileSync(p, Buffer.from(img.data, 'base64'));
    console.log('SHOT:', p, fs.statSync(p).size + ' bytes');
  } else {
    console.log('SHOT_FAIL:', JSON.stringify(r.content).slice(0, 200));
  }

  /* 门磁开 → 看官方插件的开合动画是否被状态驱动 */
  const main = (w.render && w.render.entities.find((e) => /preview_main/.test(e.entityId)) || {}).entityId;
  if (main) {
    const on = J(await client.callTool({ name: 'studio_set_entity', arguments: { entityId: main, state: 'on' } }));
    await sleep(1000);
    console.log('SENSOR on → label=' + JSON.stringify(on.label));
    const r2 = await client.callTool({ name: 'studio_screenshot', arguments: { view: 'iso', width: 900, height: 620 } });
    const img2 = (r2.content || []).find((c) => c.type === 'image');
    if (img2) {
      const p2 = path.join(__dirname, '../_shots/ref-door-open.png');
      fs.writeFileSync(p2, Buffer.from(img2.data, 'base64'));
      console.log('SHOT:', p2, fs.statSync(p2).size + ' bytes');
    }
    await client.callTool({ name: 'studio_set_entity', arguments: { entityId: main, state: 'off' } });
  }

  /* 还原成我们写的门插件 */
  const back = J(await client.callTool({ name: 'studio_write_code', arguments: { code: String(before.code), view: 'iso' } }));
  console.log('RESTORE:', JSON.stringify({ ok: back.ok, ran: back.ran, err: back.renderError || null }));

  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
