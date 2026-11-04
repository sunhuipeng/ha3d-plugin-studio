/* 端到端验证「平开门插件」
 *
 * 语义：门磁是总开关（关着就不开），开门比例只决定「开多大」
 * 流程：拉项目配置 → 写代码并渲染 → 按组合推状态 → 截图
 * 用法：npm start 之后跑 `node scripts/door-e2e.cjs`
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const J = (r) => { try { return JSON.parse(r.content[0].text); } catch (e) { return r.content[0].text; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(__dirname, '../_shots');

async function shot(client, file, args) {
  const r = await client.callTool({ name: 'studio_screenshot', arguments: args });
  const img = (r.content || []).find((c) => c.type === 'image');
  if (!img) throw new Error('截图失败: ' + JSON.stringify(r.content));
  fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
  console.log('  →', path.basename(file), fs.statSync(file).size + ' bytes');
}

function eidOf(list, slug, fallback) {
  const hit = (list || []).find((e) => e.entityId.indexOf(slug) >= 0);
  return (hit && hit.entityId) || fallback;
}

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  const client = new Client({ name: 'door-e2e', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:8098/mcp/sse')));

  /* 0. 项目配置 */
  const cfg = J(await client.callTool({ name: 'studio_get_project', arguments: {} }));
  console.log('PROJECT :', cfg.projectId, '|', cfg.name);
  console.log('SETTINGS:', cfg.settings.id, cfg.settings.kind + '/' + cfg.settings.type, '|', cfg.settings.name);
  cfg.styles.forEach((s) => {
    console.log('STYLE   :', s.id, '「' + s.name + '」',
      'options=' + JSON.stringify(s.options.map((o) => o.key + '=' + o.def)));
  });
  cfg.fields.forEach((f) => console.log('FIELD   :', f.key, '「' + f.label + '」', JSON.stringify(f.domains)));
  console.log('MODELS  :', cfg.models.map((m) => m.file).join(', '));

  /* 1. 写入门插件并渲染 */
  const code = fs.readFileSync(path.join(__dirname, 'examples/door-plugin.js'), 'utf8');
  const w = J(await client.callTool({ name: 'studio_write_code', arguments: { code, view: 'iso' } }));
  console.log('\nWRITE   :', JSON.stringify({ ok: w.ok, ran: w.ran, lines: w.codeLines, err: w.renderError || null }));
  const R = w.render || {};
  console.log('RENDER  : pluginId=' + R.pluginId, 'style=' + R.styleId,
    'styles=' + JSON.stringify((R.styles || []).map((s) => s.id || s)),
    'label=' + JSON.stringify(R.label), 'size=' + JSON.stringify(R.size));
  console.log('OPTIONS :', JSON.stringify(R.instance && R.instance.options));

  const ents = R.entities || [];
  const posEid = eidOf(ents, 'opening_ratio', 'sensor.preview_opening_ratio');
  const doorEid = eidOf(ents, 'door_entity', 'binary_sensor.preview_door_entity');
  console.log('ENTITIES:', ents.map((e) => e.entityId + '(' + e.state + ',' + e.role + ')').join(' '));
  console.log('DOOR    :', doorEid, '| POS:', posEid);

  const set = async (eid, state) => J(await client.callTool({
    name: 'studio_set_entity', arguments: { entityId: eid, state: String(state) },
  }));

  /* 2. 门磁关着：比例 100 也不该开门（门控语义） */
  await set(doorEid, 'off');
  let r = await set(posEid, 100);
  await sleep(900);
  console.log('\n门磁 off + 比例 100 → label=' + JSON.stringify(r.label) + '（应为 已关闭）');
  await shot(client, path.join(OUT, 'door-gated-off.png'), { view: 'iso', width: 900, height: 620, background: 0xf3f6fa });

  /* 3. 门磁打开后，按比例三态 */
  await set(doorEid, 'on');
  for (const [pct, name] of [[0, 'closed'], [50, 'half'], [100, 'open']]) {
    const se = await set(posEid, pct);
    await sleep(900);
    console.log('门磁 on + 比例 ' + String(pct).padStart(3) + '% → label=' + JSON.stringify(se.label));
    await shot(client, path.join(OUT, 'door-' + pct + '-' + name + '.png'),
      { view: 'iso', width: 900, height: 620, background: 0xf3f6fa });
  }

  /* 4. 复位到关闭 */
  await set(doorEid, 'off');
  await set(posEid, 0);

  console.log('\nDONE');
  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
