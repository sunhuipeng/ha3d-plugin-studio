const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const J = (r) => { try { return JSON.parse(r.content[0].text); } catch (e) { return r.content[0].text; } };

(async () => {
  const client = new Client({ name: 'e2e', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:8098/mcp/sse')));

  const tools = await client.listTools();
  console.log('TOOLS(' + tools.tools.length + '):', tools.tools.map((t) => t.name).join(', '));

  /* 1. 读代码（自动定位项目） */
  const got = J(await client.callTool({ name: 'studio_get_code', arguments: {} }));
  if (got.content) { console.log('GET_CODE_FAIL:', got.content[0].text); process.exit(1); }
  const pid = got.projectId;
  console.log('GET_CODE: pid=' + pid, 'name=' + got.name, 'plugin=' + got.plugin.id,
    'lines=' + got.codeLines, 'source=' + got.source, 'models=' + got.models.length);

  const raw = String(got.code);

  /* 2. 语法错误必须拦住 */
  const bad = await client.callTool({ name: 'studio_write_code', arguments: { code: 'function (' } });
  console.log('WRITE_BAD_BLOCKED:', bad.isError === true);

  /* 3. 写入并立即运行（合法但简单的探针代码） */
  const probe = "PluginEngine.register({ id:'e2e_probe', kind:'device', type:'light', name:'探测', styles:[{id:'a',name:'A'}], model3d(ctx){ const g=new ctx.THREE.Group(); ctx.box(g,0.4,0.4,0.4,0,0.2,0,'#8ab4f8'); return { group:g }; } });";
  const w = J(await client.callTool({ name: 'studio_write_code', arguments: { code: probe, view: 'iso' } }));
  console.log('WRITE_RUN:', JSON.stringify({ ok: w.ok, source: w.source, ran: w.ran, err: w.renderError || null }));
  if (w.render) {
    console.log('  RENDER: pluginId=' + w.render.pluginId, 'size=' + JSON.stringify(w.render.size),
      'camera=' + JSON.stringify(w.render.camera));
  }

  /* 4. 读回一致 */
  const got2 = J(await client.callTool({ name: 'studio_get_code', arguments: {} }));
  console.log('READBACK_MATCH:', String(got2.code).trim() === probe, 'source=' + got2.source);

  /* 5. 摆姿态：转模型 + 转相机 */
  const v = J(await client.callTool({ name: 'studio_view', arguments: { modelRotate: [0, 30, 0], modelMove: [0, 0.1, 0], orbitAzimuth: 20, zoomFactor: 0.85 } }));
  console.log('VIEW:', JSON.stringify(v.model), JSON.stringify(v.camera));

  /* 6. 截图（指定角度） */
  const shot = await client.callTool({ name: 'studio_screenshot', arguments: { view: 'detail', width: 800, height: 560 } });
  const img = (shot.content || []).find((c) => c.type === 'image');
  console.log('SHOT:', img ? img.data.length + ' bytes b64' : 'FAIL ' + JSON.stringify(shot.content));

  /* 7. 实体状态（探针没有 fields，看返回结构即可） */
  const se = await client.callTool({ name: 'studio_set_entity', arguments: { entityId: 'light.preview_main', state: 'on' } });
  console.log('SET_ENTITY:', se.isError ? 'ERR ' + se.content[0].text : String(se.content[0].text).slice(0, 160));

  /* 8. 恢复原始代码并运行（原本是模板模式就写空串回退模板，否则原样写回） */
  const restoreCode = got.source === 'template' ? '' : raw;
  const back = J(await client.callTool({ name: 'studio_write_code', arguments: { code: restoreCode } }));
  console.log('RESTORE:', JSON.stringify({ ok: back.ok, source: back.source, ran: back.ran, err: back.renderError || null }));

  await client.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
