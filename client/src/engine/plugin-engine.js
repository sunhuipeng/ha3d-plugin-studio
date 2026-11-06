/* 插件引擎（简化移植版 · 源自 ha-3d-home/public/js/plugins.js）
 *
 * 相对原版砍掉的部分（studio 用不上）：
 *   - 多插件造型合并（同 type 多插件聚合样式）：这里一次只跑一个插件
 *   - 材质修复等展示层逻辑
 * 保留的部分（正好是「有状态模型」的核心）：
 *   - register / styles / styleOf / defFor / labelOffset / wantsLabel
 *   - model3d(ctx) 生命周期：group / update / dispose
 *   - 背景插件 kind:'background'：apply(ctx) → { group }，ctx 带 house / safe（与 home 同口径，
 *     原点 = 背景中心、偏移先进 house/safe；见 _spawnBackground）
 *   - ctx 能力集：THREE、glb、frame、box/cyl/sphere、lightKit、状态读取、扩展实体、animate
 *   - 2D 平面符号 plan2d(c, p)：户型图里那个设备/门窗线稿（见 planKit / planOf）
 *   - isOn(obj, get)：唯一「开/合」判定入口（设备与门/窗共用），见 isOnOf
 *   - 点击控制 click：只描述「点下去发什么服务」（on/off/domain/label/defaultOn），不含 isOn
 *   - 每帧 tick（插件动画）、状态变化 updateAll、场景重建 reset
 *
 * 插件分类（与 home 完全一致，只有两类）：
 *   · kind:'device' —— 有状态模型（灯/开关/空调…）**以及门、窗**：门/窗只是
 *     type:'door' / 'window' 的贴墙设备，注册契约、建造/标签/点击/2D 路径全部同构。
 *     kind:'opening' 已废除，旧代码注册时自动归一成 'device'。
 *   · kind:'background' —— 房屋外围地面，走 styles[].apply(ctx)。
 *
 * 与原版的差别：THREE 与实体状态源都由外部注入（studio 用 three npm 包 + 模拟实体），
 * 模型 URL 通过 resolveModelUrl 映射到 studio 的项目模型接口。
 */
import * as THREE_NS from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { applyProjectConfig } from './project-config';

/* 兼容真实插件：ha-3d-home 的插件常写 window.THREE / window.THREE.GLTFLoader 做能力判断，
 * studio 用的是 npm 版 three（不挂全局），这里补一份等价引用，插件不用改就能跑。 */
if (typeof window !== 'undefined' && !window.THREE) {
  try {
    window.THREE = Object.assign({}, THREE_NS, { GLTFLoader });
  } catch (e) { /* 忽略：插件里若依赖全局 THREE，会走自己的兜底分支 */ }
}

/* 造型图标包装：24×24 线性 SVG，颜色跟随主题 */
function ico(inner) {
  return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" '
    + 'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
}

/* 背景刷新率（照搬 ha-3d-home/public/js/plugins.js 的 refreshOf）：
 * 声明 refresh（Hz）；0/非法 = 静态。上限 30，避免插件把主线程写爆 */
function refreshOf(item) {
  const n = Number(item && item.refresh);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.max(1, Math.min(30, Math.round(n)));
}

/* plan2d 的公共绘制原语（照搬 ha-3d-home/public/js/plugins.js 的 planKit）：
 *   p.rrect(x, y, w, h, rad)  只建圆角矩形路径（不填不描），可继续自己 stroke
 *   p.draw(fn, opts)          fn 里只建路径，结束后统一按调色板填色 + 描边
 *                             opts.fill/opts.stroke 传 false 可只填或只描
 * 插件不用各自复制圆角矩形，也不用每次手写 fill+stroke 三行。 */
function planKit(c, p) {
  return Object.assign({}, p, {
    rrect(x, y, w, h, rad) {
      const r = Math.min(rad || 0, w / 2, h / 2);
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    },
    draw(fn, opts) {
      const o = opts || {};
      c.beginPath();
      fn();
      if (o.fill !== false) { c.fillStyle = p.fill || '#fff'; c.fill(); }
      if (o.stroke !== false) { c.strokeStyle = p.ink || '#2a3346'; c.lineWidth = p.lw || 1.6; c.stroke(); }
    },
  });
}

/**
 * @param {object} deps
 *   THREE            three 命名空间（默认用 npm 的 three）
 *   ha               实体状态源，需实现 getState(eid) / isOn(eid) / on(fn)
 *   resolveModelUrl  (file:'models/x.glb') => string  把插件里的相对模型路径映射成可 fetch 的 URL
 *   onRender         () => void  插件主动要求重绘时调用
 *   wallH            视角高度常数（透传给 ctx.wallH，默认 2.8）
 */
export function createPluginEngine(deps) {
  const THREE = deps.THREE || THREE_NS;
  const ha = deps.ha || { getState: () => undefined, isOn: () => false, on: () => () => {} };
  const resolveModelUrl = deps.resolveModelUrl || ((f) => f);
  const onRender = deps.onRender || (() => {});
  const wallH = deps.wallH != null ? deps.wallH : 2.8;

  const gltfLoader = new GLTFLoader();
  const modelCache = new Map();     // url → Promise<THREE.Group|null>

  /* ---------------- 模型加载（按 URL 缓存原型，每次 clone） ---------------- */
  function loadGlb(file) {
    const url = resolveModelUrl(file);
    if (!url) return Promise.resolve(null);
    if (!modelCache.has(url)) {
      modelCache.set(url, new Promise((resolve) => {
        gltfLoader.load(url, (gltf) => resolve(gltf.scene), undefined, () => resolve(null));
      }));
    }
    return modelCache.get(url).then((scene) => (scene ? scene.clone(true) : null));
  }

  /* 光晕贴图（径向渐变，跨实例共享） */
  let glowCache = null;
  function glowTexture() {
    if (!glowCache) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      const g = cv.getContext('2d');
      const rg = g.createRadialGradient(32, 32, 2, 32, 32, 30);
      rg.addColorStop(0, 'rgba(255,220,150,.9)');
      rg.addColorStop(1, 'rgba(255,200,100,0)');
      g.fillStyle = rg;
      g.fillRect(0, 0, 64, 64);
      glowCache = new THREE.CanvasTexture(cv);
    }
    return glowCache;
  }

  const lambert = (color, opts) => new THREE.MeshLambertMaterial(
    Object.assign({ color: new THREE.Color(color) }, opts || {}));

  /* ---------------- 引擎主体 ---------------- */
  const engine = {
    defs: [],
    byId: {},
    instances: [],        // { def, obj, inst, anim, dead }
    _lastError: null,
    /* 查询缓存：2D 预览每次重绘都会走 styleOf / defFor，styles() 聚合不便宜；
       register（插件集变化）与 reset 时整体失效 */
    _defCache: null,
    _styleCache: null,
    /* 项目配置（styles / fields）：注册时覆盖代码里写死的同名字段。
     * 见 project-config.js —— 以项目为准，AI 代码里的常量不作依据 */
    projectConfig: null,

    setProjectConfig(cfg) {
      this.projectConfig = cfg || null;
      return this;
    },

    /* ---------------- 背景插件共享工具（PluginEngine.bgKit） ----------------
     * 与 ha-3d-home/public/js/plugins.js 的 PluginEngine.bgKit 逐字同源：
     * 背景插件（内置 background / 自定义 garden）都写 `const K = PluginEngine.bgKit;`，
     * studio 必须提供同一套，插件才能在预览里跑起来。 */
    bgKit: {
      /* 空白画布（正方形，缺省 256） */
      canvas(size) {
        const cv = document.createElement('canvas');
        cv.width = cv.height = size || 256;
        return cv;
      },
      /* 均匀噪点: 在 canvas 上下文 c 上撒 count 个颜色随机的小圆 */
      speckle(c, colors, count, sizeMin, sizeMax) {
        const S = c.canvas.width;
        for (let i = 0; i < count; i++) {
          c.fillStyle = colors[(Math.random() * colors.length) | 0];
          const r = sizeMin + Math.random() * (sizeMax - sizeMin);
          c.beginPath();
          c.arc(Math.random() * S, Math.random() * S, r, 0, Math.PI * 2);
          c.fill();
        }
      },
      /* 确定性随机（种子 → 可复现序列）: 同一栋房子每次重建道具位置不变 */
      seed(str) {
        let h = 2166136261;
        const s = String(str || '');
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
        return h >>> 0;
      },
      rand(seed) {
        let s = (seed || 1) >>> 0;
        return function () {
          s ^= s << 13; s >>>= 0;
          s ^= s >> 17;
          s ^= s << 5; s >>>= 0;
          return s / 4294967296;
        };
      },
      /* 无缝 tile 铺满: 把 tile 画布 n×n 次画到大画布 cv 上 */
      retile(cv, tile, n) {
        const c = cv.getContext('2d'), S = cv.width, step = S / n;
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            c.drawImage(tile, i * step, j * step, step, step);
          }
        }
        return cv;
      },
      /* tile → 铺满一张 2048² 大图（n = 每边平铺次数，自动夹取 1~40） */
      fullPlane(tile, n) {
        n = Math.max(1, Math.min(40, Math.round(n || 20)));
        return this.retile(this.canvas(2048), tile, n);
      },
      /* 扁平背景 = 平面网格贴画好的整图（ctx.plane 由引擎提供，中心 = 背景中心） */
      flat(ctx, cv, name) {
        const g = new ctx.THREE.Group();
        g.name = name || 'background:flat';
        g.add(ctx.plane(cv));
        return g;
      },
      /* 右侧面板「颗粒密度」参数（range 控件，key 固定 repeat） */
      repeatOpt(def) {
        return { key: 'repeat', label: '颗粒密度', type: 'range', min: 8, max: 40, step: 2, def };
      },
      /* 背景整体偏移参数（引擎保留键 offsetX/offsetZ，米，默认 0 = 房屋落在背景中心） */
      offsetOpts(range) {
        const m = range || 30;
        return [
          { key: 'offsetX', label: '东西偏移', type: 'range', min: -m, max: m, step: 0.5, def: 0, tip: '房屋在背景画面里东/西偏多少米（+西 = 往右拖背景左移，房屋相对偏东）' },
          { key: 'offsetZ', label: '南北偏移', type: 'range', min: -m, max: m, step: 0.5, def: 0, tip: '房屋在背景画面里南/北偏多少米（+北 = 往右拖背景上移，房屋相对偏南）' },
        ];
      },
    },

    /* ---- 注册（插件脚本里 PluginEngine.register({...}) 调的就是它） ---- */
    register(def) {
      if (!def || !def.id) throw new Error('插件缺少 id');
      /* 配置以项目为准：先把项目的 styles / fields 合进来，再校验/登记。
         代码里写死的 styles/options 只当兜底（项目完全没配时才会用到） */
      applyProjectConfig(def, this.projectConfig);
      /* 统一插件类：门/窗不再是独立类别，kind 一律 'device'，只有 type 区分 door/window。
         旧项目代码里残留的 kind:'opening' 静默归一（提示一次），避免作者以为还要改数据 */
      if (def.kind === 'opening') {
        console.warn('[plugins] kind:\'opening\' 已废除，按 device 处理（门/窗用 type: \'door\'/\'window\'）:', def.id);
        def.kind = 'device';
      }
      const isBg = def.kind === 'background';
      if (!isBg && typeof (def.model3d || def.create) !== 'function') {
        throw new Error('插件 ' + def.id + ' 缺少 model3d(ctx)');
      }
      if (!isBg && !def.type) {
        console.warn('[plugins] 插件缺 type（HA 域或 door/window），样式不会归入任何分类:', def.id);
      }
      /* 3D 状态标签开关（注册时定死，实例不可改）：
       *   设备缺省显示；门/窗缺省不显示（门洞上方挂状态牌很怪），要显示就显式 labels:true。
       * 读取走 wantsLabel()，预览标签管线唯一入口。 */
      def.labels = def.labels != null ? !!def.labels : !(def.type === 'door' || def.type === 'window');
      if (this.byId[def.id]) {
        const i = this.defs.indexOf(this.byId[def.id]);
        if (i >= 0) this.defs.splice(i, 1);
      }
      this._defCache = null;     // 插件集变了，defFor / styleOf 查询缓存整体失效
      this._styleCache = null;
      def.base = def.base || '';
      this.byId[def.id] = def;
      this.defs.push(def);
      return def;
    },

    defOf(typeOrId) {
      const same = this.byId[typeOrId];
      if (same) return same;
      return this.defs.find((d) => d.type === typeOrId) || null;
    },

    /* 某个实例最终用哪个插件：样式条目自带 plugin（样式所属插件）时用它，
     * 否则回退同名/同 type 的插件。设备与门/窗共用这一条规则 —— 切样式 = 换插件
     * （含 fields / plan2d / isOn / click）。studio 一次只跑一个插件，这里保留
     * styleId 参数是为了与 home 的调用口径完全一致（将来支持多插件不用改调用方）。 */
    defFor(typeOrId, styleId) {
      if (!this._defCache) this._defCache = new Map();
      const k = typeOrId + '|' + (styleId || '');
      if (this._defCache.has(k)) return this._defCache.get(k);
      const s = this.styleOf(typeOrId, styleId);
      const v = (s && s.plugin && this.byId[s.plugin]) || this.defOf(typeOrId);
      this._defCache.set(k, v);
      return v;
    },

    /* 造型查询：styleId 允许带插件前缀 'door:single'，也允许内部 id 'single'。
     * 聚合时给每条补 plugin / sid（样式所属插件、插件内部原始 id）—— 与 home 的
     * prefixItem 同义，只是 studio 的样式 id 不加前缀（项目配置里就是原始 id）。
     * defFor / planOf 靠 plugin 找「这个样式归哪个插件」，切样式 = 换插件。 */
    styles(typeOrId) {
      const out = [];
      this.defs.forEach((def) => {
        if (def.type !== typeOrId && def.id !== typeOrId) return;
        (def.styles || []).forEach((s) => {
          if (s && s.id) out.push(Object.assign({}, s, { sid: s.id, plugin: def.id }));
        });
      });
      return out;
    },

    /* 某个造型定义（缺省取该类型第一个）。走 Map 缓存：2D 预览每次重绘都会查。
     * '插件id:造型id' 时先按插件过滤 —— 多个插件可能定义同 id 的造型（如 single）。 */
    styleOf(typeOrId, styleId) {
      if (!this._styleCache) this._styleCache = new Map();
      const k = typeOrId + '|' + (styleId || '');
      if (this._styleCache.has(k)) return this._styleCache.get(k);
      const list = this.styles(typeOrId);
      const raw = styleId ? String(styleId) : '';
      const colon = raw.indexOf(':');
      const pref = colon > 0 ? raw.slice(0, colon) : '';
      const id = colon > 0 ? raw.slice(colon + 1) : raw;
      let v = null;
      if (id) {
        v = (pref && list.find((s) => s.plugin === pref && (s.sid === id || s.id === id)))
          || list.find((s) => s.id === id || s.sid === id || String(s.id).split(':').pop() === id)
          || null;
      }
      v = v || list[0] || null;
      this._styleCache.set(k, v);
      return v;
    },

    /* ---- 参数合并 ---- */
    mergeOptions(schema, saved) {
      const out = {};
      (schema || []).forEach((o) => {
        const v = (saved || {})[o.key];
        out[o.key] = (v === undefined || v === null || v === '') ? o.def : v;
      });
      return out;
    },
    styleOptionsOf(style, obj) {
      return this.mergeOptions(style && style.options, obj && obj.styleOpts);
    },

    /* 标签距地高度（米）：造型声明 labelOffset 时用它，否则按类型给缺省
       （设备 0.3；门 1.05 / 窗 1.45 ≈ 模型竖直中心）。
       labelOffset 语义 = 标签相对「设备模型接地面」的高度，不是相对包围盒顶面的偏移；
       预览标签实际锚点见 plugin-preview.labelInfo()（未声明时退回包围盒顶面） */
    labelOffset(typeOrId, styleId) {
      const s = this.styleOf(typeOrId, styleId);
      if (s && s.labelOffset != null) return s.labelOffset;
      const type = s && s.plugin ? (this.byId[s.plugin] || {}).type : (this.defOf(typeOrId) || {}).type;
      if (type === 'window' || typeOrId === 'window') return 1.45;
      if (type === 'door' || typeOrId === 'door') return 1.05;
      return 0.3;
    },

    /* 该类型实例是否显示 3D 状态标签（register 时归一化的 labels，见上方注册）：
     * 设备缺省开、门/窗缺省关（要显示需插件显式 labels:true）。预览标签管线唯一入口。 */
    wantsLabel(typeOrId, styleId) {
      const def = this.defFor(typeOrId, styleId);
      return def ? !!def.labels : true;
    },

    /* ---- 状态文案 / 便捷判定（插件里可直接用 PluginEngine.xxx） ----
     * 注意：下面这些方法是暴露给插件运行时代码的 API（与 ha-3d-home 侧同源），
     * 前端 UI 不直接调用它们 —— 清理死代码时不要当成无引用而误删 */
    ico,
    isOnState(st) { return !!(st && (st.state === 'on' || st.state === 'open')); },
    runningState(st, opts) {
      if (!st || !st.state) return false;
      if (st.state === 'off' && !(opts && opts.countOff)) return false;
      return st.state !== 'unavailable';
    },
    baseStateText(st, map) {
      if (!st) return '';
      const m = map || { on: '已开启', off: '已关闭' };
      return m[st.state] || st.state;
    },
    fieldBits(obj, get, list) {
      if (!obj || typeof get !== 'function') return '';
      const parts = [];
      (list || []).forEach(([key, fmt]) => {
        const eid = obj[key];
        if (!eid) return;
        const st = get(eid);
        if (!st) return;
        const n0 = parseFloat(st.state);
        let t = '';
        try { t = fmt(st, isNaN(n0) ? null : n0) || ''; } catch (e) { t = ''; }
        if (t) parts.push(t);
      });
      return parts.length ? ' · ' + parts.join(' · ') : '';
    },
    fieldsOf(def) { return (def && def.fields) || []; },
    boundEntities(obj, def) {
      const set = new Set();
      if (obj && obj.entityId) set.add(obj.entityId);
      this.fieldsOf(def).forEach((f) => { if (obj && obj[f.key]) set.add(obj[f.key]); });
      return set;
    },

    /* 插件声明的标签文案（MCP 可读，用于判断状态有没有「反映到界面文案上」） */
    labelOf(typeOrId, st, obj, get, styleId) {
      const def = this.defFor(typeOrId, styleId);
      if (!def || typeof def.stateText !== 'function' || !st) return null;
      const read = typeof get === 'function' ? get : (eid) => ha.getState(eid);
      try { return def.stateText(st, obj || {}, read) || null; } catch (e) { return null; }
    },

    /* ---------------- 点击控制（口径同 ha-3d-home） ----------------
     * 点击设备 / 标签 → 按插件的 click 声明切主实体状态 → HA 推送 → update() 重渲染。
     * 未声明 click 时按 type 取内置默认；on/off 是服务名（'toggle'/'turn_on'/'turn_off'）
     * 或 { service, domain }；defaultOn=false = 默认不可点。
     * **click 只描述「点下去发什么」**：「当前算不算开着」统一由顶层 isOn(obj, get) 判定
     * （见 isOnOf），click 里不再有 isOn 字段。
     * 门/窗（type:'door'/'window'）没有内置默认 —— 不写 click 即不可点（门磁是只读实体，
     * 点门没意义；车库门卷帘这类可遥控的才声明 open_cover/close_cover）。 */
    CLICK_DEFAULTS: {
      light: { on: 'toggle', off: 'toggle', label: '开 / 关' },
      switch: { on: 'toggle', off: 'toggle', label: '开 / 关' },
      fan: { on: 'toggle', off: 'toggle', label: '开 / 关' },
      cover: { on: 'toggle', off: 'toggle', label: '开 / 关' },
      water_heater: { on: 'turn_on', off: 'turn_off', label: '开 / 关' },
      climate: { on: 'turn_on', off: 'turn_off', label: '开 / 关' },
    },
    clickSpec(typeOrId, styleId) {
      const def = this.defFor(typeOrId, styleId);
      const raw = (def && def.click) || this.CLICK_DEFAULTS[def && def.type];
      if (!raw) return null;
      /* on/off 支持「自定义函数」形态（与 home 引擎同口径）：
       *   fn(obj, api) — obj 实例数据，api = { call(dom,svc,data), get(eid), toast(msg), obj }
       * 方向仍由顶层 isOn 驱动（isOnOf → isOnNow），函数只决定「怎么做」；
       * 预览层 toggleDevice 识别函数并注入 mock api（见 plugin-preview） */
      const svc = (v, fb) => (typeof v === 'function' ? v : typeof v === 'string' ? v : (v && v.service) || fb);
      return {
        on: svc(raw.on, 'toggle'),
        off: svc(raw.off, 'toggle'),
        label: raw.label || '开 / 关',
        defaultOn: raw.defaultOn !== false,
      };
    },

    /* ---------------- 2D 平面符号 plan2d(c, p) ----------------
     * 户型图里的门窗符号 / 设备简笔：编辑器已把画布 translate 到中心、rotate 到墙方向，
     * 插件只以原点为中心画中性线稿（颜色只用 p.fill / p.ink / p.accent / p.lw）。
     * p.type = 插件归属的类型键（HA 域或 'door'/'window'），与 home 的 devicePlan 同口径。
     * 返回 (c, p) => 包围半径|void；插件没写 plan2d 时返回 null，调用方用兜底符号。 */
    planOf(typeOrId, styleId, obj) {
      const def = this.defFor(typeOrId, styleId);
      if (!def || typeof def.plan2d !== 'function') return null;
      const style = this.styleOf(typeOrId, styleId);
      const sid = style ? (style.sid || style.id) : String(styleId || '').split(':').pop();
      const type = def.type || '';
      return (c, p) => {
        try {
          const pp = planKit(c, Object.assign({
            style: sid,
            type,
            /* 样式参数（内开/外开…）：样式条目默认值 ∪ 实例已存值，2D 据此画差异 */
            options: this.styleOptionsOf(style, (p && p.obj) || obj),
          }, p));
          return def.plan2d(c, pp);
        } catch (e) {
          console.warn('[plugins] plan2d 绘制失败:', def.id, sid, e);
          return null;
        }
      };
    },

    hasPlan(typeOrId) {
      const def = this.defOf(typeOrId);
      return !!(def && typeof def.plan2d === 'function');
    },

    /* ---------------- 「开 / 合」判定的唯一入口 ----------------
     * 插件只能声明一个判定函数：register 顶层的 isOn(obj, get)（与 plan2d 同级）。
     *   obj  放置数据（obj.entityId / fields 里声明的拓展实体 key 都在上面）
     *   get  (entityId) => 状态对象|null；不传时默认走注入的 ha.getState
     * 设备、门、窗共用：
     *   设备 → isOn(obj,get) { return PluginEngine.runningState(get(obj.entityId)); }
     *   门窗 → 按 fields 绑定的多个实体组合（窗 = 开关 on 且开度>0 这类）
     * 返回 boolean|null：插件没实现（或返回 null）→ 调用方继续走默认规则。
     * 插件实现抛异常时 warn 并回退，不会中断渲染。
     * 调用方：plugin-preview.isOnNow / planOn（标签高亮、2D 填充、点击方向同一结论）。 */
    isOnOf(typeOrId, styleId, obj, get) {
      const def = this.defFor(typeOrId, styleId);
      if (def && typeof def.isOn === 'function') {
        const read = typeof get === 'function' ? get : (eid) => ha.getState(eid);
        try {
          const r = def.isOn(obj || {}, read);
          return r == null ? null : !!r;   // 插件返回 null/undefined = 我不判定，继续往下兜底
        } catch (e) {
          console.warn('[plugins] isOn 判定失败:', def.id, e);
        }
      }
      return null;
    },

    /* 设备 2D 调色板：状态/选中视觉由引擎接管，插件只画中性线稿 */
    devicePalette(st) {
      const on = !!(st && st.on);
      const has = !(st && st.hasState === false);
      return {
        fill: on ? '#fdeecb' : '#fff',
        ink: has ? '#6b7280' : '#d94f4f',
        accent: '#c3cad6',
        accent2: '#9aa3b2',
        lw: 1.6,
      };
    },

    /* ---------------- ctx：交给插件 model3d 的全套能力 ---------------- */
    _makeCtx(def, obj, extra) {
      const state = { anim: null, rec: null };

      const ctx = Object.assign({
        THREE,
        obj,
        style: extra && extra.style ? extra.style : null,
        options: (extra && extra.options) || {},
        wallH,
        baseUrl: def.base || '',
        /* View3D 垫片：真实引擎里 ctx.view 是编辑器视图，插件会用 view.loadModel / view.render。
           studio 没有那套视图，这里用等价能力顶上，插件代码不用区分跑在哪。 */
        view: {
          wallH,
          render: () => onRender(),
          loadModel: (url) => loadGlb(url),
        },

        /* 读插件目录下的 GLB（内部已 clone，可安全多实例共用） */
        glb(file) { return loadGlb(file); },

        /* 门窗框：优先 models/frame.glb，缺失时用代码门套/窗套兜底 */
        async frame(g, L, ref, fallback) {
          const proto = await loadGlb('models/frame.glb');
          const r = ref || 1.2;
          if (proto) { proto.scale.x = L / r; g.add(proto); return true; }
          const fb = typeof fallback === 'function' ? fallback : frameFallback(ctx, g, r);
          fb(L);
          return false;
        },

        lambert,
        box(parent, w, h, d, x, y, z, color, opts) {
          const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), lambert(color, opts));
          m.position.set(x, y, z);
          parent.add(m);
          return m;
        },
        cyl(parent, rt, rb, h, seg, x, y, z, color, opts) {
          const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), lambert(color, opts));
          m.position.set(x, y, z);
          parent.add(m);
          return m;
        },
        sphere(parent, r, x, y, z, color, opts) {
          const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 10), lambert(color, opts));
          m.position.set(x, y, z);
          parent.add(m);
          return m;
        },
        glowTexture,

        /* 灯具光效：灯泡 + 光晕 + 点光源（+ 方向聚光），kit.set(on, rgb) 一键切换 */
        lightKit(parent, y, glowSize, opts) {
          const dir = opts && opts.dir ? opts.dir : 'omni';
          const bulbMat = lambert(0xfff3d6);
          const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12), bulbMat);
          bulb.position.y = y;
          const glowMat = new THREE.SpriteMaterial({
            map: glowTexture(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
          });
          const glow = new THREE.Sprite(glowMat);
          const gs = glowSize || 0.8;
          glow.scale.set(gs, gs, 1);
          glow.position.y = y;
          const plight = new THREE.PointLight(0xffc247, 0, 4.5);
          plight.position.y = y - 0.05;
          parent.add(bulb, glow, plight);

          let spot = null;
          if (dir === 'down' || dir === 'wall') {
            spot = new THREE.SpotLight(0xffc247, 0, (opts && opts.dist) || 5.5, (opts && opts.angle) || 1.0, 0.55, 1.1);
            spot.position.set(0, y, dir === 'wall' ? 0.15 : 0);
            const tgt = new THREE.Object3D();
            if (dir === 'wall') tgt.position.set(0, y - 0.9, 2.6);
            else tgt.position.set(0, y - 2.8, 0);
            parent.add(tgt);
            spot.target = tgt;
            parent.add(spot);
          }
          const ptBase = dir === 'omni' ? 0.9 : dir === 'wall' ? 0.3 : 0.35;
          const extraMats = [];
          const kit = {
            bulbMat, glowMat, plight, spot,
            addMat(m) { extraMats.push(m); return m; },
            set(on, rgb) {
              bulbMat.emissive.setHex(on ? 0xffc247 : 0x000000);
              if (on && rgb && rgb.length >= 3) bulbMat.emissive.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
              glowMat.opacity = on ? 0.85 : 0;
              plight.intensity = on ? ptBase : 0;
              if (spot) spot.intensity = on ? (opts && opts.strength) || 0.9 : 0;
              if (on && rgb && rgb.length >= 3) {
                plight.color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
                if (spot) spot.color.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
              }
              extraMats.forEach((m) => {
                m.emissive.setHex(on ? 0xffc247 : 0x000000);
                if (on && rgb && rgb.length >= 3) m.emissive.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
              });
            },
          };
          parent.userData.pluginLightKit = kit;
          return kit;
        },

        /* ---- 读实体状态 ---- */
        getState(eid) { return ha.getState(eid); },
        isOn(eid) { return ha.isOn(eid); },
        binaryRatio(eid) {
          const st = eid ? ha.getState(eid) : null;
          if (!st) return null;
          return (st.state === 'on' || st.state === 'open') ? 1 : 0;
        },
        toNum(v) {
          if (v == null) return null;
          const s = String(v);
          if (s === '' || s === 'unknown' || s === 'unavailable') return null;
          const n = parseFloat(s);
          return isNaN(n) ? null : n;
        },

        /* ---- 扩展实体字段（fields 声明，值挂在 obj[key]） ---- */
        field(key) { return (obj && obj[key]) || null; },
        hasField(key) { return !!(obj && obj[key]); },
        fieldState(key) { const eid = obj && obj[key]; return eid ? ha.getState(eid) : null; },
        fieldOn(key) { const eid = obj && obj[key]; return eid ? ha.isOn(eid) : false; },
        fieldNum(key) {
          const st = ctx.fieldState(key);
          if (!st || st.state == null) return null;
          return ctx.toNum(st.state);
        },
        fieldText(key) {
          const st = ctx.fieldState(key);
          if (!st) return '';
          const unit = (st.attributes && st.attributes.unit_of_measurement) || '';
          return st.state + (unit ? ' ' + unit : '');
        },

        render() { onRender(); },
        animate(fn) { state.anim = fn; },
      }, (extra && extra.ctx) || {});

      return { ctx, state };
    },

    /* ---------------- 实例生命周期 ---------------- */
    /**
     * 背景插件（kind:'background'）：调样式条目的 apply(ctx) → { group, refresh?, update? }。
     * refresh>0 时由 tick() 按频率回调 update(t, api)（口径同 home：钳 1..30Hz、首帧立即、
     * 连续 3 次异常自动停刷）；0/缺省 = 静态只画一次，不进调度。
     * 口径与 ha-3d-home 的 applyBackground 完全一致（原点 = 背景中心）：
     *   · ctx 里的 house / safe 都是「背景坐标系」—— 房屋可以不在画面正中
     *   · studio 没有真实房屋，由「左下角卡片的安全范围（长×宽，米）」画一个半透明长方体占位，
     *     盒子固定在世界原点（= 真实房屋在 home 里的位置），长 = safeW、宽 = safeD、高 8m
     *   · offsetX/offsetZ（保留键）：房屋相对背景中心的偏移（米）。先算进 house / safe，
     *     再据此把背景 group 摆到「房屋世界中心 − 偏移」，于是房子不动、背景绕着它偏
     * home 侧同源实现：ha-3d-home / public/js/plugins.js → PluginEngine.applyBackground
     */
    _spawnBackground(style, options, o) {
      const T = THREE;
      const o2 = o || {};
      const W = Math.min(100, Math.max(2, Number(o2.safeW) || 8));    /* 长（米，X 向） */
      const D = Math.min(100, Math.max(2, Number(o2.safeD) || 8));    /* 宽（米，Z 向） */
      const H = 8;                                                    /* 占位高（米） */

      /* 背景参数（含引擎保留偏移键 offsetX / offsetZ，米）：
       * = 房屋相对「背景中心」的偏移，0 = 房屋居中。
       * 正值手感沿用「往右拖 = 背景往左/往上」：+X = 房屋偏东、+Z = 房屋偏南，钳 ±60。 */
      const bgOpts = options || {};
      const clampOff = (v) => Math.max(-60, Math.min(60, Number(v) || 0));
      const offX = clampOff(bgOpts.offsetX);
      const offZ = clampOff(bgOpts.offsetZ);

      /* house：背景坐标系里的房屋（cx/cy = 偏移量本身，不再是房屋世界中心） */
      const house = {
        minX: -W / 2 + offX, maxX: W / 2 + offX,
        minY: -D / 2 + offZ, maxY: D / 2 + offZ,
        w: W, d: D,
        cx: offX, cy: offZ,
        floors: 1,
        hash: 'studio-' + W + 'x' + D + '@' + offX + ',' + offZ,
      };
      /* 与 home 的 PluginEngine.safeZone 同口径（plugins.js safeZone）：
       * forbidden = 房屋占地 + inner 走廊；allowed = 走廊外 + 距房屋中心 ≤ outer。
       * 全部由上面带偏移的 house 派生 —— 房屋偏到哪，安全区就跟到哪。 */
      const safe = {
        inner: 1.5, outer: 45,
        x0: house.minX - 1.5, x1: house.maxX + 1.5,
        y0: house.minY - 1.5, y1: house.maxY + 1.5,
        forbidden(x, z) { return x > safe.x0 && x < safe.x1 && z > safe.y0 && z < safe.y1; },
        allowed(x, z) {
          if (safe.forbidden(x, z)) return false;
          const dx = x - house.cx, dz = z - house.cy;
          return dx * dx + dz * dz <= safe.outer * safe.outer;
        },
      };
      /* 平面默认边长：至少 120m；偏移把房子推到边缘时才自动放大，保证房屋整块踩在地面上 */
      const needHalf = Math.max(Math.abs(offX) + W / 2, Math.abs(offZ) + D / 2) + 4;
      const planeM = Math.max(120, needHalf * 2);

      const plane = (src, sizeM) => {
        const tex = (src && src.isTexture) ? src : new T.CanvasTexture(src);
        tex.anisotropy = 8;
        tex.needsUpdate = true;
        const m = sizeM || planeM;
        const mesh = new T.Mesh(
          new T.PlaneGeometry(m, m),
          /* 用不受光照的 Basic 材质：底图画什么样显示什么样，
             不会被场景灯光过曝洗白 */
          new T.MeshBasicMaterial({ map: tex })
        );
        mesh.rotation.x = -Math.PI / 2;
        /* 平面中心 = 背景中心（原点），不是房屋中心：房屋按 house.cx/cy 偏到一边 */
        mesh.position.set(0, -0.05, 0);   // 压到地板下方一点，避免 z-fighting
        return mesh;
      };
      const bgCtx = {
        THREE: T,
        size: 512,
        house, safe,
        options: bgOpts,
        refresh: refreshOf(style),
        plane,
        planeSize: planeM,   // 默认平面边长（米）：画布 ↔ 米 的换算用得上
      };
      const ret = (typeof style.apply === 'function' ? style.apply(bgCtx) : null) || {};
      if (!ret.group) throw new Error('背景 apply 没有返回 { group }，引擎将清空背景');
      /* 刷新率: 样式声明 refresh（Hz），apply 返回值可覆盖（与 home plugins.js 同口径）；0 = 静态 */
      const hz = refreshOf(ret.refresh != null ? ret : style);
      const upd = typeof ret.update === 'function' ? ret.update : null;

      /* 落位：group 的局部原点 = 背景中心，摆到世界里的「房屋中心 − 偏移」。
       * studio 的房屋恒在世界原点，故为 (−offX, 0, −offZ)：房屋纹丝不动，背景整体绕着它偏。 */
      ret.group.position.set(-offX, 0, -offZ);

      /* 房屋占位：半透明长方体（长×宽 = 安全范围）。
       * 用单位几何 + scale —— 预览层改安全范围时直接改 scale 实时挪盒子，不用重跑 apply。
       * 关键：盒子挂在 root 上（不随背景平移），永远钉在世界原点 ——
       * 和 home 里「房子不动、背景偏移」同一套关系，插件按 house/safe 撒的点才对得上。 */
      const root = new T.Group();
      const box = new T.Mesh(
        new T.BoxGeometry(1, H, 1),
        new T.MeshLambertMaterial({ color: 0x9db8d9, transparent: true, opacity: 0.22, depthWrite: false })
      );
      box.scale.set(W, 1, D);
      box.position.y = H / 2 + 0.02;    // 略高于底图，避免与贴图闪面
      root.add(box);
      root.add(ret.group);

      return {
        group: root,
        safeBox: box,          /* 预览层改安全范围时直接 scale 它，实时预览不重绘背景 */
        bgGroup: ret.group,    /* 预览层改 offsetX/offsetZ 时直接平移它，实时预览不重绘背景 */
        update: upd,           /* refresh>0 时由 tick() 按频率回调 update(t, api) */
        hz,                    /* 0 = 静态（不进调度，零每帧开销）；1..30 = 每秒回调这么多次 */
        _bgApi: { group: ret.group, mesh: null, size: ret.size || 512 },
        dispose: () => {},
      };
    },

    /**
     * 创建并挂载一个插件实例。
     * @returns {Promise<{group, update, dispose}>}  异步（model3d 可能是 async）
     */
    async spawn(def, obj, opts) {
      const o = opts || {};
      if (!def) throw new Error('没有可用的插件定义');
      const style = o.style || (def.styles && def.styles[0]) || { id: 'default', name: def.name || def.id };
      const options = this.styleOptionsOf(style, obj);
      const { ctx, state } = this._makeCtx(def, obj, { style, options, ctx: o.ctx });
      const rec = { def, obj, inst: null, anim: null, dead: false };
      state.rec = rec;

      let inst;
      try {
        if (def.kind === 'background') {
          /* 背景插件不走 model3d：直接调样式条目的 apply(ctx) 拿渲染好的 3D 内容 */
          inst = this._spawnBackground(style, options, o);
        } else {
          inst = (def.model3d || def.create)(ctx);
        }
      } catch (e) {
        throw new Error(def.kind === 'background' ? '背景 apply 执行出错: ' + e.message : 'model3d 执行出错: ' + e.message);
      }
      const it = await Promise.resolve(inst);
      /* 异步 model3d（await glb）期间可能已经 reset() 换代，过期实例不能塞回新场景 */
      if (rec.dead) {
        return { group: new THREE.Group(), update: null, dispose: () => {}, stale: true };
      }
      if (!it) throw new Error('model3d 没有返回对象');
      if (!it.group) throw new Error('model3d 返回值缺少 group');

      const api = Object.assign({}, it, {
        group: it.group,
        update: typeof it.update === 'function' ? it.update : null,
        dispose: typeof it.dispose === 'function' ? it.dispose : () => {},
      });
      rec.inst = api;
      rec.anim = state.anim;
      this.instances.push(rec);

      if (api.update) {
        try {
          /* 背景实例按 home 口径首帧立即画一次（update(0, api)），避免首帧空白 */
          if (api._bgApi) api.update(0, api._bgApi);
          else api.update();
        } catch (e) { console.warn('[plugin:' + def.id + '] update 出错:', e); }
      }
      onRender();
      return api;
    },

    updateAll() {
      this.instances.forEach((rec) => {
        if (rec.dead || !rec.inst || !rec.inst.update) return;
        const it = rec.inst;
        try {
          /* 背景实例按 home 口径传 (t, api)，t 取已累计的运行时长 */
          if (it._bgApi) it.update((it._bgState && it._bgState.t) || 0, it._bgApi);
          else it.update();
        } catch (e) { console.warn('[plugin:' + rec.def.id + '] update 出错:', e); }
      });
      onRender();
    },

    /* 每帧驱动：插件动画 anim(dt) + 动态背景按各自 refresh(Hz) 节流回调 update(t, api)。
     * 背景节流与 ha-3d-home tickBackground 同款——用「下一次触发时刻」而不是累加器：
     * 60fps 下跑 10Hz 不会因为浮点漂移少触发；掉帧只补一次并对齐下一间隔，避免补帧雪崩。 */
    tick(dt) {
      const d = Math.min(0.25, Math.max(0, dt || 0));   // 切回标签页的长 dt 不追帧
      this.instances.forEach((rec) => {
        if (rec.dead) return;
        if (rec.anim) { try { rec.anim(d); } catch (e) { /* 单帧异常忽略 */ } }
        const it = rec.inst;
        if (it && it.hz > 0 && typeof it.update === 'function') this._tickBg(rec, it, d);
      });
    },

    _tickBg(rec, it, dt) {
      const st = it._bgState || (it._bgState = { t: 0, next: 1 / it.hz, errs: 0 });
      st.t += dt;
      if (st.t < st.next) return;
      const iv = 1 / it.hz;
      const steps = Math.floor((st.t - st.next) / iv) + 1;
      st.next = steps > 2 ? st.t + iv : st.next + steps * iv;
      try { it.update(st.t, it._bgApi); }
      catch (e) {
        st.errs++;
        if (st.errs === 1) console.warn('[plugin:' + rec.def.id + '] 背景刷新出错:', e);
        if (st.errs >= 3) {
          console.warn('[plugin:' + rec.def.id + '] 背景连续出错，已停止刷新');
          it.hz = 0;   // 坏插件自动退出调度，不拖垮整个预览
        }
      }
    },

    /** 只清实例（几何/动画/刷新调度），保留 defs —— 改参数后的快速重生（respawn）用：
     *  代码不重新执行、def 原地复用，几何按内存里的新参数值重画 */
    clearInstances() {
      this.instances.forEach((rec) => {
        rec.dead = true;
        if (rec.inst && rec.inst.dispose) { try { rec.inst.dispose(); } catch (e) { /* ignore */ } }
      });
      this.instances = [];
    },

    /** 清空所有实例（场景重建 / 重新预览前调用），并通知插件 dispose */
    reset() {
      this.clearInstances();
      this.defs = [];
      this.byId = {};
      this._defCache = null;
      this._styleCache = null;
    },
  };

  return engine;
}

/* ctx.frame 的内置兜底：ref ≤ 1m 按门套（通高），否则按窗套 */
function frameFallback(ctx, g, ref) {
  const door = ref <= 1.0;
  const col = door ? '#d9d4c8' : '#9aa7b5';
  const d = door ? 0.12 : 0.1;
  return (W) => {
    if (door) {
      ctx.box(g, 0.07, 2.1, d, -W / 2 - 0.035, 1.05, 0, col);
      ctx.box(g, 0.07, 2.1, d, W / 2 + 0.035, 1.05, 0, col);
      ctx.box(g, W + 0.14, 0.07, d, 0, 2.085, 0, col);
    } else {
      ctx.box(g, W + 0.08, 0.07, d, 0, 0.925, 0, col);
      ctx.box(g, W + 0.08, 0.07, d, 0, 2.075, 0, col);
      ctx.box(g, 0.07, 1.22, d, -W / 2 - 0.035, 1.5, 0, col);
      ctx.box(g, 0.07, 1.22, d, W / 2 + 0.035, 1.5, 0, col);
      ctx.box(g, 0.05, 1.1, 0.07, 0, 1.5, 0, col);
    }
  };
}
