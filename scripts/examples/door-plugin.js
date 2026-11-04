/*
 * 平开门插件（studio 示例，对齐项目 pabbe02e8 的实际配置）
 *
 * ── 这个项目里有什么 ─────────────────────────────────────────────
 *   设置      id=demo  name=门窗  kind=opening  type=door
 *   字段      doorEntity     门磁     on/off
 *             opening_ratio  开门比例  0~100
 *   样式      ping「单开门」 parts: frame.glb + leaf.glb
 *             options: direction = inside(里面) / out(外)
 *   模型      models/frame.glb  门框 1.04 × 2.12 × 0.12，原点在底部中心
 *             models/leaf.glb   门扇 0.86 × 1.98 × 0.098，几何 x: 0~0.86
 *                               —— 原点正好落在铰链侧
 *
 * ── 怎么动起来 ───────────────────────────────────────────────────
 *   · 洞口宽 L 取 ctx.obj.w（预览给 0.9，正式渲染按墙段算）
 *   · ctx.frame(g, L, 0.9) 加载门框并按洞宽缩放；缺模型时引擎自动用门套兜底
 *   · 门扇按 (L-0.08)/0.86 缩放后挂到「位于铰链处的 Group」，转这个 Group 就是开门
 *   · 开度 0~1 乘最大开角得到目标角度，ctx.animate 里逐帧插值 → 开关门有过渡
 *
 * ── 开度怎么算（门磁是总开关）───────────────────────────────────
 *   · doorEntity 门磁是 off/closed/0 → 门关死，开门比例填多少都不动
 *                                     （门磁 unavailable/unknown 视为没接这个字段）
 *   · 门磁 on/open，或压根没配门磁：
 *       opening_ratio 开门比例 0~100 → 门开到对应角度（也认 current_position / open / closed）
 *       没配比例 → 全开；两种都没配 → 关闭
 *
 * ── 包一层 IIFE 的原因 ──────────────────────────────────────────
 *   同一份代码要能原样搬到 ha-3d-home 的 assets/plugins/door/ 当独立 <script> 加载，
 *   那边顶层 const 会共享全局作用域，重名直接 SyntaxError。
 */
(function () {
  'use strict';

  const D2R = Math.PI / 180;
  const LEAF_W = 0.86;        // leaf.glb 门扇原始宽度
  const LEAF_H = 1.98;        // leaf.glb 门扇原始高度
  const FRAME_REF = 0.9;      // frame.glb 对应的标准洞宽
  const MAX_ANGLE = 95;       // 默认最大开角（度）
  const GAP = 0.08;           // 门扇两侧预留的缝

  const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
  const num = (v) => {
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  };

  /* 单个实体状态 → 0~1 开度；判断不出来返回 null */
  function ratioOfState(st) {
    if (!st) return null;
    const s = st.state;
    if (s === 'open' || s === 'opening' || s === 'on' || s === 'true') return 1;
    if (s === 'closed' || s === 'closing' || s === 'off' || s === 'false') return 0;
    const n = num(s);
    if (n != null) return clamp01(n / 100);
    const cp = num(st.attributes && st.attributes.current_position);
    if (cp != null) return clamp01(cp / 100);
    return null;
  }

  /* 实体在不在、能不能用：unavailable / unknown 视为没接这个字段 */
  function usable(st) {
    return !!(st && st.state && st.state !== 'unavailable' && st.state !== 'unknown');
  }

  /* 引擎 ctx.isOn 的等价判断：stateText(st, obj, get) 里只拿得到 get，没有 ctx */
  function isOnState(st) {
    return usable(st)
      && (st.state === 'on' || st.state === 'open' || st.state === 'opening' || st.state === 'true');
  }

  /* 开度 0~1。
     read(eid) 读实体状态；isOn(eid) 用引擎的 ctx.isOn（HA 语义：on/open 才算开）。
     门磁是总开关：门磁关着 → 门就是关的，开门比例填什么都不开；
     门磁开着（或没配门磁）→ 才由「开门比例」决定开多大，没比例就全开。 */
  function openRatio(obj, read, isOn) {
    const doorEid = obj.doorEntity || obj.entityId || '';
    const hasDoor = usable(read(doorEid));

    if (hasDoor && !isOn(doorEid)) return 0;

    const posEid = obj.opening_ratio || obj.posEntityId || obj.positionEntityId || '';
    const r = ratioOfState(read(posEid));
    if (r != null) return r;

    return hasDoor ? 1 : 0;
  }

  /* ── 2D 平面符号（plan2d）：户型图里画在墙上的那扇门 ─────────────────
     编辑器已经把画布 translate 到洞口中心、rotate 到墙方向，所以只以原点为中心画线：
       p.L      洞口在屏幕上的像素宽度（= 洞宽 × ppm）
       p.fill   开=暖琥珀 / 关=白，只能填进封闭形状内部（这里就是门框那一段）
       p.ink    描边色（门深灰 / 窗浅蓝，选中时编辑器自己画虚线圈，不用管）
       p.options 样式参数（direction = inside 内开 / out 外开）
     画法：门框一段矩形 + 门扇 90° 开启线 + 从门扇端点扫到对侧门框的开启弧。
     direction=out 上下镜像；以后加 hand=right 左右镜像也走同一套。 */
  function planDoor(c, p) {
    const L = p.L || 40;
    const ink = p.ink || '#2a3346';
    const o = p.options || {};

    /* 门框：洞口那一段墙（和墙同色填充 → 关着的时候就是一段白墙） */
    c.fillStyle = p.fill || '#fff';
    c.strokeStyle = ink;
    c.lineWidth = 1.6;
    c.fillRect(-L / 2, -3, L, 5);
    c.strokeRect(-L / 2, -3, L, 5);

    /* 门扇 + 开启弧：铰链在左端，门扇开 90° 指向 +Y（画布向下 = 室内侧） */
    const mx = o.hand === 'right' ? -1 : 1;
    const my = (o.direction === 'out' || o.open === 'out') ? -1 : 1;
    c.save();
    c.scale(mx, my);
    c.strokeStyle = ink;
    c.lineWidth = 1.6;
    c.beginPath();
    c.moveTo(-L / 2, 0);
    c.lineTo(-L / 2, L);
    c.arc(-L / 2, 0, L, Math.PI / 2, 0, true);
    c.stroke();
    c.restore();
  }

  PluginEngine.register({
    id: 'demo',
    name: '门窗',
    kind: 'opening',
    type: 'door',
    version: '1.0.0',

    /* 状态文案：显示在 2D 平面图与 MCP 返回里 */
    stateText(st, obj, get) {
      const read = typeof get === 'function' ? get : () => null;
      const r = openRatio(obj || {}, read, (eid) => isOnState(read(eid)));
      const pct = Math.round(r * 100);
      if (pct <= 0) return '已关闭';
      if (pct >= 99) return '已打开';
      return '开 ' + pct + '%';
    },

    /* 2D 平面的「开」判定：门磁开 + 开度 > 0 才算开（决定线稿填不填暖色）。
       3D 用不上它，门扇角度由 model3d 自己按开度算。 */
    isOn(obj, get) {
      const read = (eid) => (eid && typeof get === 'function' ? get(eid) : null);
      return openRatio(obj || {}, read, (eid) => isOnState(read(eid))) > 0.001;
    },

    /* 户型图线稿（见上方 planDoor） */
    plan2d: planDoor,

    async model3d(ctx) {
      const T = ctx.THREE;
      const obj = ctx.obj || {};
      const o = ctx.options || {};
      const L = Number(obj.w) || 0.9;

      /* 手向 / 开向 / 最大开角都从样式参数读，没配就用默认，以后加参数不用改代码 */
      const hand = o.hand === 'right' ? 'right' : 'left';
      const outward = o.direction === 'out' || o.open === 'out';
      const maxAngle = Math.abs(num(o.openAngle) != null ? num(o.openAngle) : MAX_ANGLE);

      const g = new T.Group();

      /* 1) 门框：models/frame.glb 按洞宽缩放，缺模型时引擎用门套兜底 */
      await ctx.frame(g, L, FRAME_REF);

      /* 2) 门扇：leaf.glb 的原点在铰链侧，所以整扇挂到「铰链 Group」上，
            转这个 Group 就是绕铰链开门 */
      const hinge = new T.Group();
      hinge.position.set(hand === 'right' ? L / 2 : -L / 2, 0, 0);

      const leaf = await ctx.glb('models/leaf.glb');
      if (leaf) {
        leaf.scale.x = (L - GAP) / LEAF_W;
        /* 右铰链：门板要从铰链向 -X 伸展，绕 Y 轴 180° 镜像过来 */
        if (hand === 'right') leaf.rotation.y = Math.PI;
        hinge.add(leaf);
      } else {
        /* 没有模型时用一块薄板顶上，至少能看出开合 */
        const w = L - GAP;
        ctx.box(hinge, w, LEAF_H, 0.045, hand === 'right' ? -w / 2 : w / 2, LEAF_H / 2, 0, '#8a6f52');
      }
      g.add(hinge);

      /* 3) 开度 → 目标角度。
            左铰链内开向 -Z 侧倒（负角），外开反过来；右铰链整体再翻一次符号 */
      const sign = (hand === 'right' ? -1 : 1) * (outward ? 1 : -1);
      const fullAngle = sign * maxAngle * D2R;

      let target = 0;
      let first = true;

      const api = {
        group: g,
        update() {
          const r = openRatio(obj, (eid) => ctx.getState(eid), (eid) => ctx.isOn(eid));
          target = fullAngle * r;
          /* 首次挂上场景时直接到位，避免预览一打开就从关到开演一遍 */
          if (first) {
            hinge.rotation.y = target;
            first = false;
          }
        },
      };

      /* 逐帧向目标角度靠拢，dt 单位是秒，5.5 → 约 0.3s 到位 */
      ctx.animate((dt) => {
        const k = Math.min(1, dt * 5.5);
        hinge.rotation.y += (target - hinge.rotation.y) * k;
      });

      return api;
    },
  });
})();
