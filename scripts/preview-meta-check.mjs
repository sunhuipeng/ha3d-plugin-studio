/* 回归：左下角「样式」卡片两项元信息的预览生效链路
 *   1. 离地高度 z —— _applyGroundLift 把设备实例 group 抬到 obj.z（门恒 0 / 背景不抬）
 *   2. 标签高度 labelOffset —— labelInfo 读 live 样式引用（this.style），
 *      不走 engine.styleOf 的查询缓存（缓存返回快照拷贝，即时改值看不到）
 * 用 vite SSR 装载真实 plugin-preview.js，host 全部用桩，不起浏览器。
 */
import { createRequire } from 'module';

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  PASS', msg); }
  else { fail++; console.log('  FAIL', msg); }
};

/* vite 装在 client/ 子目录：从那边解析（CJS 入口自带 createServer） */
const clientRequire = createRequire(new URL('../client/package.json', import.meta.url));
const _vite = clientRequire('vite');
const createServer = _vite.createServer || (_vite.default && _vite.default.createServer);

const server = await createServer({
  root: new URL('../client', import.meta.url).pathname,
  server: { middlewareMode: true }, appType: 'custom', logLevel: 'error',
});
const { PluginPreview } = await server.ssrLoadModule('/src/engine/plugin-preview.js');

/* ---- 桩 host：bounds 固定 0.4~1.0m 高的盒子 ---- */
let lastProjected = null;
const host = {
  addTick() { return () => {}; },
  bounds() {
    return { min: { x: -0.2, y: 0.4, z: -0.2 }, max: { x: 0.2, y: 1.0, z: 0.2 } };
  },
  projectToScreen(p) { lastProjected = { ...p }; return { x: 100, y: 200, behind: false }; },
  renderer: { domElement: { clientWidth: 800, clientHeight: 600 } },
  setModel() {}, clearModel() {}, setGrid() {}, setAxes() {},
};

const preview = new PluginPreview(host);

/* 注册一个最小设备插件定义（同 register 契约：labels:true 让标签管线走通） */
preview.engine.reset();
preview.engine.setProjectConfig({ styles: [], fields: [] });
preview.engine.register({
  id: 'meta_probe', kind: 'device', type: 'light', name: '元信息探针',
  labels: true, click: { on: 'turn_on', off: 'turn_off' },
  styles: [{ id: 'a', name: '样式A' }],
  model3d() { return { group: {} }; },
});
preview.def = preview.engine.defs[0];
preview.style = preview.def.styles[0];
preview.styleId = 'a';
preview.obj = { id: 'preview', entityId: 'light.probe', z: 0 };
preview.ha.setState('light.probe', 'on');
preview._clickSpec = preview.engine.clickSpec('light', 'a');

/* ===== 1. 离地高度：_applyGroundLift ===== */
console.log('\n[1] _applyGroundLift 把设备实例抬到 obj.z');
const group = { position: { y: 0 } };
preview.obj.z = 0.75;
preview._applyGroundLift(group);
ok(Math.abs(group.position.y - 0.75) < 1e-9, '设备 obj.z=0.75 → group.position.y=0.75');
preview.obj.z = 0;
preview._applyGroundLift(group);
ok(group.position.y === 0, '设备 obj.z=0 → 贴地');
preview.obj.z = 1.2;
preview._applyGroundLift(group);
ok(Math.abs(group.position.y - 1.2) < 1e-9, '窗 obj.z=1.2 → 抬到 1.2');

/* 门：_makeObj 不给 door 设 z，obj.z 缺省 0 → 不抬 */
preview.def.type = 'door';
preview.obj.z = undefined;
preview._applyGroundLift(group);
ok(group.position.y === 0, '门 obj.z 缺省 → 贴地（门恒 0 口径）');
preview.def.type = 'light';

/* 背景插件不抬（背景自己管 offsetX/offsetZ） */
preview.def.kind = 'background';
preview.obj.z = 3;
preview._applyGroundLift(group);
ok(group.position.y === 0, '背景插件不抬 group');
preview.def.kind = 'device';
preview.obj.z = 0;

/* ===== 2. 标签高度：labelInfo 读 live 样式 ===== */
console.log('\n[2] labelInfo 实时读样式 labelOffset（live 引用，不吃缓存快照）');
delete preview.style.labelOffset;
lastProjected = null;
preview.labelInfo();
ok(lastProjected && Math.abs(lastProjected.y - 1.0) < 1e-9,
  '无 labelOffset → 锚点 = 包围盒顶面 box.max.y=1.0');

preview.style.labelOffset = 1.3;          // 模拟左下卡片即时改值（写 live 对象）
lastProjected = null;
preview.labelInfo();
ok(lastProjected && Math.abs(lastProjected.y - (0.4 + 1.3)) < 1e-9,
  'labelOffset=1.3（live 改值）→ 锚点 = box.min.y+1.3 = 1.7（缓存快照下会是 1.0）');

preview.style.labelOffset = 0.6;
lastProjected = null;
preview.labelInfo();
ok(lastProjected && Math.abs(lastProjected.y - (0.4 + 0.6)) < 1e-9,
  'labelOffset 改 0.6 → 锚点跟着变 = 1.0');

/* 离地高度联动：group 抬高后包围盒 min.y 含 z，标签锚点 = z + labelOffset */
preview.style.labelOffset = 1.3;
preview.obj.z = 0.75;
preview._applyGroundLift({ position: { y: 0 } });   // 仅验证函数本身，bounds 桩不含 z
preview.obj.z = 0;

console.log('\n[3] 想要 labelOffset 的缺省回退仍在');
ok(preview.engine.labelOffset('light', 'a') === 0.3, '引擎缺省 labelOffset（设备 0.3）不受影响');

/* ===== 4. click 自定义函数（与 home 引擎同口径） ===== */
console.log('\n[4] click on/off 支持自定义函数');
const fnSpec = preview.engine.clickSpec('light', 'a');
ok(fnSpec && fnSpec.on === 'turn_on', '字符串 on/off 照常归一');
preview.engine.defs[0].click = {
  on(obj, api) { throw new Error('boom'); },   // 先测抛错拦截
  off: 'turn_off',
};
const errSpec = preview.engine.clickSpec('light', 'a');
ok(typeof errSpec.on === 'function', 'clickSpec 放行函数 on');
preview._clickSpec = errSpec;
preview.ha.setState('light.probe', 'off');
const caught = preview.toggleDevice();          // 关着 → 调 on 函数 → 同步抛错
ok(caught === null || caught === undefined || (caught && typeof caught.catch === 'function'),
  '函数同步抛错被引擎拦住（不外泄）');

/* 正常执行：函数里 api.call 改状态、api.get 读状态、api.toast 不炸 */
const seen = { calls: [], toasts: [] };
const origLog = console.log, origWarn = console.warn;
console.log = (...a) => { if (String(a[0]).includes('[预览]')) seen.toasts.push(a.slice(1).join(' ')); else origLog(...a); };
preview.engine.defs[0].click = {
  on(obj, api) {
    const st = api.get(obj.entityId);
    seen.calls.push(['get', st ? String(st.state) : null]);   // 取快照：mock-ha 原地改同一对象
    api.call('light', 'turn_on', { entity_id: obj.entityId });
    api.toast('已开灯');
  },
  off: 'turn_off',
};
preview._clickSpec = preview.engine.clickSpec('light', 'a');
preview.toggleDevice();
console.log = origLog; console.warn = origWarn;
ok(seen.calls.length === 1 && seen.calls[0][0] === 'get' && seen.calls[0][1] === 'off',
  'api.get(eid) 拿到 mock 状态（off）');
ok(preview.ha.getState('light.probe').state === 'on', 'api.call turn_on → mock 状态翻转 on（HA 推送链路生效）');
ok(seen.toasts.some((t) => t === '已开灯'), 'api.toast 走 console 落地');

/* 无主实体也可执行函数（函数可能操作任意实体）；字符串形态仍拦 */
preview.obj.entityId = '';
preview.engine.defs[0].click = { on(obj, api) { seen.calls.push(['noent']); }, off: 'turn_off' };
preview._clickSpec = preview.engine.clickSpec('light', 'a');
preview.ha.setState('light.probe', 'off');
preview.toggleDevice();
ok(seen.calls.some((c) => c[0] === 'noent'), '函数形态无主实体也可执行');
preview.engine.defs[0].click = { on: 'turn_on', off: 'turn_off' };
preview._clickSpec = preview.engine.clickSpec('light', 'a');
ok(preview.toggleDevice() === null, '字符串形态无主实体仍拦截不发');
preview.obj.entityId = 'light.probe';

await server.close();
console.log(`\n结果: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
