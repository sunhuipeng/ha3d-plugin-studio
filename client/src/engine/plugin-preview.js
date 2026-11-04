/* PluginPreview — 插件预览控制台
 *
 * 串起三件东西：ThreeHost（渲染）+ PluginEngine（插件生命周期）+ MockHa（实体状态）。
 * 对外提供「清空旧渲染 → 执行最新 plugin.js → 重新渲染」这一条主链路，
 * 以及供 MCP 使用的：视角、旋转/平移、截图、实体状态注入。
 */
import { createPluginEngine } from './plugin-engine';
import { createMockHa, guessEntityId } from './mock-ha';
import { clamp } from './math';

/* 设备类型 → 默认主实体域（预览时随便给一个能跑通的实体） */
const TYPE_DOMAIN = {
  light: 'light', switch: 'switch', fan: 'fan', cover: 'cover',
  climate: 'climate', water_heater: 'water_heater', media_player: 'media_player',
  vacuum: 'vacuum', camera: 'camera', sensor: 'sensor', other: 'switch',
};

/* 门窗类里「哪个字段代表门/窗的开合状态」：按 key 语义猜，排除掉比例类字段
   （opening_ratio 名字里也有 open，必须先排除） */
const OPENING_MAIN_RE = /^(?!.*(ratio|position|percent|pct|progress)).*(entity|door|window|contact|state|open)/i;

export class PluginPreview {
  /**
   * @param {import('./three-host').ThreeHost} host
   */
  constructor(host) {
    this.host = host;
    this.ha = createMockHa();
    this.project = null;
    this.projectId = '';
    this.def = null;
    this.obj = null;
    this.style = null;
    this.styleId = '';
    this.code = '';
    this.error = '';
    this.loading = false;
    this.lastLoadedAt = 0;
    this.safeBox = null;   /* 背景插件的房屋占位长方体（实时改 scale 用） */
    /* 点击控制：设备/标签 → 按 click 配置切主实体状态 */
    this._clickRoot = null;      /* 当前设备 group（收集可点网格 + 标签锚点） */
    this._clickMeshes = [];      /* 参与射线拾取的网格 */
    this._clickSpec = null;      /* 引擎 clickSpec 结果；null = 不可点 */

    this.engine = createPluginEngine({
      ha: this.ha,
      wallH: 2.8,
      resolveModelUrl: (file) => this.modelUrl(file),
      onRender: () => { /* 主循环每帧渲染，这里无需额外动作 */ },
    });

    /* 每帧驱动插件动画 */
    this._untick = this.host.addTick((dt) => this.engine.tick(dt));
    /* 实体状态变化 → 所有实例 update() */
    this.ha.on(() => { this.engine.updateAll(); });
  }

  /* ---------------- 模型 URL ---------------- */
  modelUrl(file) {
    const pid = this.projectId;
    if (!pid) return '';
    const base = String(file || '').replace(/^\.?\//, '').split('/').pop();
    if (!base) return '';
    return `/api/projects/${pid}/models/${encodeURIComponent(base)}`;
  }

  /* ---------------- 主链路：清空 → 执行代码 → 重建 ---------------- */
  /**
   * @param {object} o
   *   project  项目对象（含 styles / fields / plugin）
   *   code     生成的 plugin.js 源码
   *   styleId  要预览的样式（缺省用第一个）
   *   view     载入后套用的视角预设（缺省 iso）
   */
  async load(o) {
    const opts = o || {};
    this.loading = true;
    this.error = '';
    try {
      if (opts.project) this.project = opts.project;
      if (!this.project) throw new Error('没有项目数据');
      this.projectId = this.project.id || this.projectId;

      const code = String(opts.code || '');
      if (!code.trim()) throw new Error('plugin.js 是空的 —— 用 MCP studio_write_code 生成代码，或在代码面板里写');

      /* 1) 清空上一轮渲染（几何/贴图/实例全部释放）。
         软重渲（改参数 / 改样式）不该把推过的实体状态清掉：先记下，造完预览实例再推回去 */
      const prevStates = (this.ha.list() || []).map((e) => ({
        entityId: e.entityId, state: e.state, attributes: e.attributes,
      }));
      this.engine.reset();
      this.host.clearModel();
      this.ha.reset();

      /* 2) 执行最新代码，注册插件定义。
         注册前把项目配置交给引擎：styles / fields 以项目为准，代码里写死的不作依据 */
      this.engine.setProjectConfig({
        styles: this.project.styles || [],
        fields: this.project.fields || [],
      });
      const factory = new Function('PluginEngine', code);   // eslint-disable-line no-new-func
      factory(this.engine);
      const def = this.engine.defs[0];
      if (!def) throw new Error('代码执行完毕但没有调用 PluginEngine.register(...)');
      this.def = def;
      this.code = code;

      /* 3) 造一个预览实例：主实体 + fields 绑定的扩展实体 */
      const style = this._resolveStyle(def, opts.styleId);
      this.style = style || null;
      this.styleId = style ? style.id : '';
      this.obj = this._makeObj(def, style);
      /* 参数值只有一个来源：样式 options 的 def（合并后已来自项目配置）。
         不再接受调用方传 styleOpts —— 两份值并存会出现「面板改了、预览还是旧值」 */
      this._defineEntities(def, this.obj);
      /* 把上一轮推过的状态推回去（新实体 id 不存在就跳过，字段被改过时自然忽略） */
      for (const p of prevStates) {
        if (!p.entityId || !this.ha.has(p.entityId)) continue;
        try { this.ha.setState(p.entityId, p.state, p.attributes); } catch (e) { /* 忽略单条失败 */ }
      }

      /* 4) 渲染（背景插件多带 safeW/safeD：房屋占位长×宽，米） */
      const api = await this.engine.spawn(def, this.obj, { style, safeW: opts.safeW, safeD: opts.safeD });
      if (api && api.stale) {
        /* 加载期间被下一次刷新取代，别把过期模型塞进场景 */
        this.loading = false;
        return this.describe();
      }
      this.host.setModel(api.group);
      /* 设备类：准备点击控制与标签（背景/门窗没有这个概念） */
      this._setupClick(def, api.group);
      /* 背景插件：藏掉网格/坐标轴（120m 地面下它们只会添乱），换回设备/门窗预览时恢复。
         safeBox = 房屋占位长方体，左下角改安全范围时实时 scale 它 */
      this.safeBox = api.safeBox || null;
      this.bgGroup = api.bgGroup || null;   /* 背景本体 group：offsetX/offsetZ 实时平移用 */
      const isBg = def.kind === 'background';
      if (isBg) { this.host.setGrid(false); this.host.setAxes(false); }
      await this._frameWhenReady(opts.view || 'iso');

      this.lastLoadedAt = Date.now();
      this.loading = false;
      return this.describe();
    } catch (e) {
      this.error = e && e.message ? e.message : String(e);
      this.loading = false;
      this.engine.reset();
      this.host.clearModel();
      this.safeBox = null;
      this.bgGroup = null;
      this._clearClick();
      throw e;
    }
  }

  /* 等 GLB 异步加载进来（包围盒出现）后再取景，否则会框住一个空盒子 */
  _frameWhenReady(view) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        const box = this.host.bounds();
        if (box || performance.now() - t0 > 2500) {
          this.host.applyView(view);
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  /* 项目配置 → def 的合并由 PluginEngine.register 完成（见 engine/project-config.js），
     这里只负责把项目数据交给引擎（load 里 setProjectConfig） */

  _resolveStyle(def, styleId) {
    const list = (def && def.styles) || [];
    if (!list.length) return { id: 'default', name: (def && def.name) || 'default' };
    const want = styleId ? String(styleId).split(':').pop() : '';
    return list.find((s) => s.id === want) || list[0];
  }

  _mainDomain(def) {
    /* 门窗的开合状态来自字段（binary_sensor 门磁 / 开度），不绑主实体 */
    if (def.kind === 'opening') return 'binary_sensor';
    return TYPE_DOMAIN[def.type] || 'switch';
  }

  /** 构造预览实例数据（等价于 ha-3d-home 里一台设备 / 一扇门窗的 obj） */
  _makeObj(def, style) {
    const isOpening = def.kind === 'opening';
    const mainDomain = this._mainDomain(def);
    const obj = {
      id: 'preview',
      x: 0, y: 0, z: 0, rot: 0,
      pct: 100,
      style: style ? style.id : 'default',
      styleOpts: {},
      /* 设备类可以绑一台真实设备（设置里填）；门窗类没有这个概念，稍后指向门磁字段 */
      entityId: isOpening
        ? ''
        : (((this.project && this.project.plugin && this.project.plugin.entityId) || '').trim()
          || `${mainDomain}.preview_main`),
      swing: 1.1,
    };
    if (isOpening) {
      obj.w = def.type === 'window' ? 1.2 : 0.9;
    } else if (style && style.z != null) {
      obj.z = Number(style.z) || 0;
    }

    /* fields 声明的拓展实体：插件里通过 ctx.field('xxx') 读，值就是 entity id */
    const fields = (def.fields && def.fields.length) ? def.fields : ((this.project && this.project.fields) || []);
    fields.forEach((f) => {
      if (!f || !f.key) return;
      if (f.key === 'entityId') return;   // 主实体已单独给
      obj[f.key] = guessEntityId(f.key, f.domains, this._fieldDomain(def, f));
    });

    /* 项目里已保存的实际绑定值优先（这样预览用的就是作者配的实体） */
    const saved = (this.project && this.project.fields) || [];
    saved.forEach((f) => {
      if (f && f.key && f.entityId) obj[f.key] = f.entityId;
    });

    /* 门窗类没有「实体绑定」—— 状态全部来自字段（门磁 / 开门比例）。
       不再造 binary_sensor.preview_main 这种假主实体；把 entityId 指向门磁字段，
       让按官方写法（ctx.obj.entityId）写的插件也能跑，但界面上不出现「主实体」。 */
    if (isOpening) {
      const door = fields.find((f) => f && f.key && OPENING_MAIN_RE.test(f.key))
        || fields.find((f) => f && Array.isArray(f.domains) && f.domains.includes('binary_sensor'))
        || null;
      obj.entityId = door ? (obj[door.key] || '') : '';
    }
    return obj;
  }

  _fieldDomain(def, field) {
    const doms = Array.isArray(field.domains) ? field.domains : [];
    if (doms.length) return doms[0];
    if (def.kind === 'opening') return 'binary_sensor';
    return 'sensor';
  }

  _defineEntities(def, obj) {
    /* 主实体：门窗可能没有（entityId 为空），空串别往状态表里塞 */
    if (obj.entityId) this.ha.define(obj.entityId);
    /* 拓展实体 */
    this.engine.fieldsOf(def).forEach((f) => {
      const eid = obj[f.key];
      if (eid) this.ha.define(eid);
    });
    (this.project && this.project.fields || []).forEach((f) => {
      const eid = f && obj[f.key];
      if (eid) this.ha.define(eid);
    });
  }

  /* ---------------- 供 MCP / UI 使用的能力 ---------------- */

  /** 列出当前预览的实体（可改的那些） */
  listEntities() {
    const def = this.def;
    const main = this.obj ? this.obj.entityId : '';
    /* 门窗类没有「实体绑定」，entityId 只是指向门磁字段的别名，不标成主实体 */
    const isOpening = !!(def && def.kind === 'opening');
    const out = [];
    (this.ha.list() || []).forEach((e) => {
      let role = 'field';
      if (main && e.entityId === main && !isOpening) role = 'main';
      let label = '';
      let fieldKey = '';
      let fieldTip = '';
      (def && def.fields || []).forEach((f) => {
        if (this.obj && f && this.obj[f.key] === e.entityId) {
          label = f.label || f.key;
          fieldKey = f.key;
          fieldTip = f.tip || '';
        }
      });
      if (role === 'main') label = '主实体';
      /* fieldKey 让界面能判断这个字段是「开关量」还是「百分比」 */
      out.push({ ...e, role, label, fieldKey, fieldTip });
    });
    return out;
  }

  /** 改实体状态 → 触发插件 update() */
  setEntity(entityId, state, attributes) {
    if (!entityId) throw new Error('缺少 entityId');
    if (!this.ha.has(entityId)) this.ha.define(entityId);
    const st = this.ha.setState(entityId, state, attributes);
    this.engine.updateAll();
    return { ...st };
  }

  /** 当前主实体的插件标签文案（stateText 结果，没声明则为空） */
  labelText() {
    const def = this.def;
    if (!def || !this.obj) return '';
    const st = this.ha.getState(this.obj.entityId);
    if (!st) return '';
    return this.engine.labelOf(def.id, st, this.obj, null, this.styleId) || '';
  }

  /* ---------------- 点击控制（设备/标签 → 切实体状态，口径同 ha-3d-home） ---------------- */

  /** 载入成功后调用：算 click 规格、收集可点网格、算标签锚点 */
  _setupClick(def, group) {
    this._clearClick();
    this._clickRoot = group || null;
    if (!def || def.kind !== 'device' || !group) return;
    const spec = this.engine.clickSpec(def.id, this.styleId);
    if (!spec || spec.defaultOn === false) return;
    this._clickSpec = spec;
    group.traverse((n) => { if (n.isMesh) this._clickMeshes.push(n); });
    /* 标签锚点不在这里算死：包围盒会随插件动画/光效收敛变化，
       labelInfo() 每帧按当前包围盒实时取「中心正上方、距地 labelOffset 米」 */
  }

  _clearClick() {
    this._clickRoot = null;
    this._clickMeshes = [];
    this._clickSpec = null;
  }

  /** 射线拾取：这个点击位置命中设备模型了吗 */
  pickDevice(e) {
    if (!this._clickSpec || !this._clickMeshes.length) return false;
    return !!this.host.pickAt(e.clientX, e.clientY, this._clickMeshes);
  }

  /** 当前是否「开着」：插件 click.isOn 优先，缺省 state 非 off/unavailable 即开 */
  isOnNow() {
    const spec = this._clickSpec;
    const st = this.obj && this.obj.entityId ? this.ha.getState(this.obj.entityId) : null;
    if (spec && spec.isOn) return !!spec.isOn(st);
    return !!(st && st.state && st.state !== 'off' && st.state !== 'unavailable');
  }

  /** 点击切换：按 click.on/off 服务名改主实体状态 → HA 推送 → update() 重渲染 */
  toggleDevice() {
    const spec = this._clickSpec;
    if (!spec || !this.obj || !this.obj.entityId) return null;
    const onNow = this.isOnNow();
    const svc = onNow ? spec.off : spec.on;
    /* studio 里 mock-ha 直接吃状态值：服务名 → 状态映射（toggle = 翻转） */
    const MAP = { turn_off: 'off', turn_on: 'on', close: 'closed', close_cover: 'closed', open_cover: 'open' };
    const next = svc === 'toggle' ? (onNow ? 'off' : 'on')
      : MAP[svc] || (/off|close/.test(svc) ? 'off' : 'on');
    return this.setEntity(this.obj.entityId, next);
  }

  /** 标签当前该显示什么 / 在哪（PluginStage 每帧取一次去更新 DOM） */
  labelInfo() {
    const def = this.def;
    const obj = this.obj;
    if (!def || !obj || def.kind !== 'device' || !this._clickSpec) return null;
    const box = this.host.bounds();          // 每帧实时取：包围盒会随动画/光效变化
    if (!box) return null;
    const st = obj.entityId ? this.ha.getState(obj.entityId) : null;
    const name = def.name || obj.entityId || '';
    const unit = st && st.attributes ? (st.attributes.unit_of_measurement || '') : '';
    const text = this.engine.labelOf(def.id, st, obj, (eid) => this.ha.getState(eid), this.styleId)
      || (!st ? '' : st.state === 'on' ? '已开启' : st.state === 'off' ? '已关闭' : st.state + (unit ? ' ' + unit : ''));
    if (!name && !text) return null;
    /* 标签锚点 = 设备包围盒中心正上方，高度 = 接地面 + labelOffset。
       labelOffset 语义：标签相对「设备模型接地面」的距地高度（米，等同 ha-3d-home 的 labelOffset）；
       造型没声明时退回包围盒顶面，保证标签默认落在模型上方而不是插在模型里。
       （包围盒每帧现取：会随动画/光效变化） */
    const s = this.engine.styleOf(def.id, this.styleId);
    const decl = s && s.labelOffset != null && s.labelOffset !== '' ? Number(s.labelOffset) : null;
    const anchorY = decl != null && isFinite(decl) ? box.min.y + decl : box.max.y;
    const sp = this.host.projectToScreen({
      x: (box.min.x + box.max.x) / 2,
      y: anchorY,
      z: (box.min.z + box.max.z) / 2,
    });
    if (!sp || sp.behind) return null;
    /* 相机贴得近时锚点可能投到画布外（取景顶格），钳回画布内保证标签始终可见；
       但设备已被平移出视野很远（>80px）时干脆不显示，免得标签孤零零挂边上 */
    const el = this.host.renderer.domElement;
    const W = el.clientWidth, H = el.clientHeight;
    if (sp.x < -80 || sp.x > W + 80 || sp.y < -80 || sp.y > H + 80) return null;
    const on = this.isOnNow();
    return {
      x: clamp(sp.x, 50, W - 50),
      y: clamp(sp.y - 6, 30, H - 12),
      name, text,
      on,
      clickable: !!this._clickSpec,
      sig: name + '|' + text + '|' + (on ? 1 : 0) + '|' + (this._clickSpec ? 1 : 0),
    };
  }

  /* ---------------- 2D 平面符号（plan2d，户型图里的线稿） ---------------- */

  /** 插件声明的 plan2d 包装器；没写返回 null（调用方用兜底符号） */
  planSymbol() {
    if (!this.def) return null;
    return this.engine.planOf(this.def.id, this.styleId, this.obj);
  }

  hasPlan2d() {
    return !!(this.def && this.engine.hasPlan(this.def.id));
  }

  /** 平面上「现在是不是开着」：插件 isOn(obj, get) 优先，缺省主实体 on/open 即开 */
  planOn() {
    if (!this.def || !this.obj) return false;
    const get = (eid) => this.ha.getState(eid);
    const byPlugin = this.engine.isOnOf(this.def.id, this.obj, get);
    if (byPlugin != null) return byPlugin;
    const st = this.obj.entityId ? get(this.obj.entityId) : null;
    return !!(st && (st.state === 'on' || st.state === 'open'));
  }

  /** plan2d 绘制需要的全部上下文（PlanInset 画线稿时直接拿去用） */
  planInfo() {
    const def = this.def;
    const obj = this.obj || {};
    const st = obj.entityId ? this.ha.getState(obj.entityId) : null;
    const on = this.planOn();
    /* 设备专用：实体连没连上（没连上 ink 用红色） */
    const hasState = !!(st && st.state && st.state !== 'unavailable' && st.state !== 'unknown');
    return {
      ready: !!def,
      kind: def ? def.kind : '',
      type: def ? (def.type || '') : '',
      hasPlan: this.hasPlan2d(),
      on,
      hasState,
      palette: this.engine.devicePalette({ on, hasState }),
      w: Number(obj.w) || 0.9,
      styleId: this.styleId,
      options: this.engine.styleOptionsOf(this.style, obj),
      entityId: obj.entityId || '',
      state: st || null,
      obj,
      getState: (eid) => this.ha.getState(eid),
      label: this.labelText(),
    };
  }

  /** 描述当前预览状态（MCP 返回值 / UI 状态栏） */
  describe() {
    const def = this.def;
    const box = this.host ? this.host.bounds() : null;
    const size = box ? [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z] : null;
    return {
      ok: !this.error,
      error: this.error || '',
      projectId: this.projectId,
      pluginId: def ? def.id : '',
      kind: def ? def.kind : '',
      type: def ? def.type || '' : '',
      name: def ? def.name : '',
      styleId: this.styleId,
      styles: ((def && def.styles) || []).map((s) => ({ id: s.id, name: s.name || s.id })),
      instance: this.obj
        ? {
          entityId: this.obj.entityId, w: this.obj.w, z: this.obj.z, style: this.obj.style,
          /* 当前样式参数的实际取值（代码读到的是什么，调试时一眼可见） */
          options: this.engine.styleOptionsOf(this.style, this.obj),
        }
        : null,
      label: this.labelText(),
      /* 2D 线稿来源：插件有没有实现 plan2d（MCP 调试时一眼看出是插件画的还是兜底） */
      plan2d: this.hasPlan2d(),
      size: size ? size.map((n) => Math.round(n * 1000) / 1000) : null,
      camera: this.host ? this.host.cameraState() : null,
      model: this.host ? this.host.modelState() : null,
      entities: this.listEntities(),
      modelUrlBase: this.modelUrl('models/x.glb'),
    };
  }

  /** 彻底清空（离开预览 / 卸载组件时） */
  destroy() {
    if (this._untick) { try { this._untick(); } catch (e) { /* ignore */ } this._untick = null; }
    this.engine.reset();
    if (this.host) this.host.clearModel();
    this.ha.reset();
    this.def = null;
    this.obj = null;
    this.safeBox = null;
    this.bgGroup = null;
    this._clearClick();
  }

  /* 实时预览：直接平移背景 group（offsetX/offsetZ 滑条拖动时调用，不重跑 apply）。
   * 口径与引擎 _spawnBackground 一致：offsetX +东 = 房屋偏东、offsetZ +南 = 房屋偏南（内部取负）。
   * 房屋占位盒挂在 root 上、钉在世界原点，不跟着平移 —— 视觉上就是「房子不动、背景偏」。
   * 停手后 PluginStage 会用缓存代码软重渲一次，让插件按新的 house/safe 重画构图。 */
  setBgOffset(x, z) {
    if (!this.bgGroup) return false;
    const cx = Math.max(-60, Math.min(60, Number(x) || 0));
    const cz = Math.max(-60, Math.min(60, Number(z) || 0));
    this.bgGroup.position.set(-cx, 0, -cz);
    return true;
  }
}
