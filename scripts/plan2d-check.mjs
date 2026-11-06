/* 1) 用真引擎跑一遍插件代码 → 拿到 def.plan2d
 * 2) 用「记录型 2D 上下文」把 plan2d 画出来的点全部记下来，算包围盒
 * 3) 再跑一遍 studio 的 drawPlan（离屏量包围盒 → 等比缩放居中 → 矢量重画），
 *    确认缩放后的内容都落在右上角那块画布里
 *
 * 用法：node scripts/plan2d-check.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

globalThis.window = { devicePixelRatio: 2 };

const here = path.dirname(fileURLToPath(import.meta.url));
const { createPluginEngine } = await import('../client/src/engine/plugin-engine.js');
const { drawPlan } = await import('../client/src/engine/plan-draw.js');

/* ---------- 记录型 canvas ---------- */
function makeCtx(W, H) {
  const pts = [];
  let m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const stack = [];
  const txt = [];
  const put = (x, y) => {
    pts.push([m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f]);
  };
  const mul = (a2, b2, c2, d2, e2, f2) => {
    m = {
      a: m.a * a2 + m.c * b2, b: m.b * a2 + m.d * b2,
      c: m.a * c2 + m.c * d2, d: m.b * c2 + m.d * d2,
      e: m.a * e2 + m.c * f2 + m.e, f: m.b * e2 + m.d * f2 + m.f,
    };
  };
  const ctx = {
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt',
    font: '10px sans-serif', textAlign: 'left', textBaseline: 'alphabetic',
    setTransform: (a2, b2, c2, d2, e2, f2) => { m = { a: a2, b: b2, c: c2, d: d2, e: e2, f: f2 }; },
    save: () => stack.push({ ...m }),
    restore: () => { if (stack.length) m = stack.pop(); },
    translate: (x, y) => mul(1, 0, 0, 1, x, y),
    rotate: (r) => mul(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0),
    scale: (x, y) => mul(x, 0, 0, y, 0, 0),
    clearRect() {}, fillRect(x, y, w, h) { put(x, y); put(x + w, y + h); },
    strokeRect(x, y, w, h) { put(x, y); put(x + w, y + h); },
    beginPath() {}, closePath() {}, fill() {}, stroke() {}, setLineDash() {},
    moveTo: put, lineTo: put,
    arcTo(x1, y1, x2, y2) { put(x1, y1); put(x2, y2); },
    arc(cx, cy, r, a0, a1) {
      const n = 24;
      for (let i = 0; i <= n; i++) {
        const a = a0 + (a1 - a0) * (i / n);
        put(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
    },
    fillText: (t, x, y) => txt.push({ t, x, y }),
    measureText: (t) => ({ width: String(t).length * 6 }),
    /* drawPlan 量包围盒时会读 alpha 通道：按记录到的点回填一张假的像素图；
       顺便记下「到这里为止是试画内容」，脚本据此切出正式绘制的点 */
    getImageData(x0, y0, w, h) {
      this.__measureEnd = pts.length;
      const data = new Uint8ClampedArray(w * h * 4);
      pts.forEach(([px, py]) => {
        const ix = Math.round(px - x0);
        const iy = Math.round(py - y0);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const jx = ix + dx;
            const jy = iy + dy;
            if (jx >= 0 && jx < w && jy >= 0 && jy < h) data[(jy * w + jx) * 4 + 3] = 255;
          }
        }
      });
      return { data, width: w, height: h };
    },
  };
  return { ctx, pts, txt, W, H };
}


function makeCanvas(W, H) {
  const rec = makeCtx(W, H);
  return {
    rec,
    canvas: {
      clientWidth: W, clientHeight: H, width: W * 2, height: H * 2, style: {},
      getContext: () => rec.ctx,
    },
  };
}

/* ---------- 假 HA ---------- */
const states = new Map();
const set = (id, s) => { states.set(id, { entity_id: id, state: String(s), attributes: {} }); };
const ha = {
  getState: (id) => states.get(id),
  isOn: (id) => {
    const st = states.get(id);
    return !!st && ['on', 'open', 'opening', 'true'].includes(st.state);
  },
  on: () => () => {},
};

/* ---------- 跑插件 ---------- */
const engine = createPluginEngine({ ha });
const code = fs.readFileSync(path.join(here, 'examples/door-plugin.js'), 'utf8');
new Function('PluginEngine', code)(engine);   // eslint-disable-line no-new-func
const def = engine.defs[0];
/* 样式/字段在 studio 里是「项目配置」，代码里只写 model3d —— 这里手补一份，
   等价于 plugin-preview._mergeProjectDef 干的事 */
def.styles = [{
  id: 'ping', name: '单开门',
  options: [{ key: 'direction', label: '开门方向', type: 'select', def: 'inside',
    choices: [{ value: 'inside', label: '里面' }, { value: 'out', label: '外' }] }],
}];
console.log('PLUGIN  :', def.id, def.kind + '/' + def.type, '| styles=' + def.styles.map((s) => s.id).join(','));
console.log('plan2d  :', typeof def.plan2d === 'function' ? '已实现' : '缺失！');
console.log('isOn    :', typeof def.isOn === 'function' ? '已实现' : '缺失！');

const obj = { id: 'preview', w: 0.9, style: 'ping', styleOpts: {}, doorEntity: 'binary_sensor.door', opening_ratio: 'sensor.ratio' };
set('binary_sensor.door', 'on');
set('sensor.ratio', '50');

function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  pts.forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); });
  return [x0, y0, x1, y1].map((n) => Math.round(n * 10) / 10);
}

/* 1) 单看插件 plan2d（画布已居中，L=120px） */
const plan = engine.planOf(def.id, 'ping', obj);
const a = makeCtx(400, 400);
plan(a.ctx, {
  L: 120, sel: false, on: true, ppm: 133, ink: '#2a3346', fill: '#fdeecb',
  obj, state: states.get('binary_sensor.door'), getState: (id) => states.get(id),
});
console.log('\n[plan2d 包围盒] x:', bbox(a.pts)[0], '→', bbox(a.pts)[2], ' y:', bbox(a.pts)[1], '→', bbox(a.pts)[3]);
console.log('  （洞口 L=120，门扇+弧应到 y=120，门框应在 y=-3..2）');

/* 2) 内外开两种取值：镜像方向应相反 */
['inside', 'out'].forEach((dir) => {
  obj.styleOpts = { direction: dir };
  const c = makeCtx(400, 400);
  plan(c.ctx, { L: 120, on: true, ppm: 133, ink: '#000', fill: '#fff', obj, getState: (id) => states.get(id) });
  console.log('  direction=' + dir, '→ 包围盒 y:', bbox(c.pts)[1], '→', bbox(c.pts)[3]);
});

/* 3) isOn：门磁关 / 比例 0 / 比例 50 三种 */
obj.styleOpts = {};
const onOf = () => engine.isOnOf(def.id, 'ping', obj, (id) => states.get(id));
set('binary_sensor.door', 'off'); set('sensor.ratio', '100');
console.log('\n[isOn] 门磁 off + 比例 100 →', onOf());
set('binary_sensor.door', 'on'); set('sensor.ratio', '0');
console.log('[isOn] 门磁 on  + 比例 0   →', onOf());
set('sensor.ratio', '50');
console.log('[isOn] 门磁 on  + 比例 50  →', onOf());

/* 4) 走一遍 studio 的 drawPlan（262×164 的右上角小窗）：
      离屏量包围盒 → 等比缩放居中 → 真画布上矢量重画 */
const pv = {
  planInfo: () => ({
    ready: true, kind: 'device', type: 'door', hasPlan: true, on: onOf(), w: 0.9,
    styleId: 'ping', options: {}, entityId: 'binary_sensor.door', state: states.get('binary_sensor.door'),
    obj, getState: (id) => states.get(id), label: '开 50%',
  }),
  planSymbol: () => plan,
};
const W = 262, H = 164;
const { rec, canvas } = makeCanvas(W, H);
const ok = drawPlan(canvas, pv);
/* 记录到的是设备像素（setTransform 里乘过 dpr=2），换算回 CSS 像素看是否越界。
   切法：__measureEnd 之前的点是「试画」用的，之后先是一次白底 fillRect（2 个角点），
   再往后才是正式绘制的线稿 */
const mark = rec.ctx.__measureEnd || 0;
const bb = bbox(rec.pts.slice(mark + 2)).map((n) => Math.round((n / 2) * 10) / 10);
console.log('\n[drawPlan] ok=' + ok, '画布 ' + W + '×' + H, '内容包围盒:', bb);
const inside = bb[0] >= 4 && bb[1] >= 4 && bb[2] <= W - 4 && bb[3] <= H - 4;
console.log('  是否被缩放居中、全部落在画布内:', inside ? '是' : '否 ← 会被裁掉');
console.log('  文字:', rec.txt.length ? rec.txt.map((t) => t.t).join(' | ') : '（无，线稿不带角标）');
