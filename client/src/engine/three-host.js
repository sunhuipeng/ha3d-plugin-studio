/* ThreeHost — 插件引擎的渲染宿主
 *
 * 只做「渲染 + 相机 + 截图」三件事，不含任何插件知识：
 *   · 场景/相机/控制器/网格/坐标轴/modelRoot
 *   · 视角：预设（iso/front/back/left/right/top/low/detail）+ 绝对方位角/俯仰/距离
 *   · 交互：绕目标旋转（orbit）、平移（pan）、缩放（zoomBy）——「整个坐标系」视角
 *   · 模型：整体旋转 / 移动 / 归位（transformModel）
 *   · 截图：任意视角 + 任意尺寸离屏渲染成 PNG（供 MCP 观察画面）
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { clamp } from './math';
import { applyLegacyRenderer } from './three-legacy';

const D2R = Math.PI / 180;

/* 视角预设：azimuth 绕 Y 轴方位（度，0 = 从 +Z 看），elevation 俯仰（度，0 = 平视，90 = 正上方） */
export const VIEW_PRESETS = {
  iso: { azimuth: 45, elevation: 32 },
  front: { azimuth: 0, elevation: 8 },
  back: { azimuth: 180, elevation: 8 },
  left: { azimuth: -90, elevation: 8 },
  right: { azimuth: 90, elevation: 8 },
  top: { azimuth: 0, elevation: 88 },
  low: { azimuth: 35, elevation: 5 },
  detail: { azimuth: 40, elevation: 20, zoom: 0.62 },
};

/* 3D 视口底色：亮暗两套。暗色用于调灯效——亮底下发光面/光晕会发白，对比不出来。
 * 与 home 大屏 #stage（#fafbfd）亮色对齐；暗色取偏蓝的中性深灰，避免纯黑吞掉灯罩细节。 */
const BG_LIGHT = 0xfafbfd;
const BG_DARK = 0x151a22;

/* 网格线配色：亮色对齐大屏浅灰蓝；暗色压到低对比冷灰 + 降透明度，
 * 否则深色底上一大片白亮线会盖过灯效（用户反馈）。GridHelper 颜色写在顶点色里，
 * 改 material.color 无效，切主题时重建 GridHelper（见 _makeGrid）。 */
const GRID_LIGHT = { center: 0xc4ccd8, line: 0xdde3ec, opacity: 0.9 };
const GRID_DARK = { center: 0x46505f, line: 0x2b323d, opacity: 0.42 };

export class ThreeHost {
  constructor(container) {
    this.container = container;
    /* 初始暗色跟随 document（ui store 在挂载前就把 data-theme 写到 html 上） */
    this.dark = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark';
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.controls = null;
    this.modelRoot = null;
    this.grid = null;
    this.axes = null;

    this._raf = 0;
    this._disposed = false;
    this._ticks = new Set();       // (dt:number) => void
    this._modelXform = { rx: 0, ry: 0, rz: 0, x: 0, y: 0, z: 0 };
    this._resizeObs = null;
    this._gizmoScene = null;
    this._gizmoCam = null;
    this._protoProvider = null;    // 共享资源提供方（引擎 GLB 原型缓存），见 setProtoProvider
    this.showGizmo = true;
  }

  /* ---------------- 生命周期 ---------------- */
  init() {
    const el = this.container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    /* 与 home（three r147 legacy）同口径：线性输出 + 老灯光单位，
       否则 studio 里插件贴图会发白掉饱和、大屏又是另一个色（见 three-legacy.js） */
    applyLegacyRenderer(this.renderer);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    /* 底板色对齐 home index 大屏的 #stage（#fafbfd），空白天区不再偏灰；暗色模式用深色底 */
    const bg = this.dark ? BG_DARK : BG_LIGHT;
    this.renderer.setClearColor(bg, 1);
    el.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(bg);

    /* FOV 50 与 home view3d 一致：同样的机位/距离下取景比例才对得上 */
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 500);
    this.camera.position.set(2.2, 1.8, 2.6);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.target.set(0, 0.4, 0);
    this.controls.minDistance = 0.15;
    this.controls.maxDistance = 200;
    this.controls.maxPolarAngle = Math.PI * 0.98;

    /* 灯光：与 home view3d 完全同款机位/参数（hemi 1.05 + dir 0.5）。
     * 上面已把渲染器切到 legacy 灯光口径（×PI），参数相同 = 亮度相同；
     * 不要在这里再按物理光习惯调强度，否则 Lambert 物体会过曝洗白 */
    this.scene.add(new THREE.HemisphereLight(0xdfeaff, 0x8a7a66, 1.05));
    const key = new THREE.DirectionalLight(0xffffff, 0.5);
    key.position.set(8, 14, 6);
    this.scene.add(key);

    this._makeGrid();

    this.axes = new THREE.AxesHelper(1.2);
    this.axes.position.y = 0.002;
    this.axes.visible = false;
    this.scene.add(this.axes);

    this.modelRoot = new THREE.Group();
    this.modelRoot.name = 'modelRoot';
    this.scene.add(this.modelRoot);

    this._initGizmo();
    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObs = new ResizeObserver(() => this.resize());
      this._resizeObs.observe(el);
    }
    window.addEventListener('resize', this._onWinResize = () => this.resize());

    this._loop();
    return this;
  }

  /* 按当前主题重建网格线（GridHelper 的颜色写进顶点色，改 material.color 无效）。
   * 重建时保留原 visible 状态，避免切主题把用户关掉的网格又打开。 */
  _makeGrid() {
    const wasVisible = this.grid ? this.grid.visible : true;
    if (this.grid) {
      if (this.scene) this.scene.remove(this.grid);
      if (this.grid.geometry) this.grid.geometry.dispose();
      if (this.grid.material) this.grid.material.dispose();
    }
    const c = this.dark ? GRID_DARK : GRID_LIGHT;
    const grid = new THREE.GridHelper(20, 40, c.center, c.line);
    grid.material.transparent = true;
    grid.material.opacity = c.opacity;
    grid.position.y = -0.001;
    grid.visible = wasVisible;
    this.grid = grid;
    if (this.scene) this.scene.add(grid);
    return grid;
  }

  /* 切换亮/暗底色：改 renderer clearColor + scene.background + 网格线配色；
   * 不动灯光/材质，这样灯效在两种背景下都按同一套光照渲染，方便对比。 */
  setDark(on) {
    this.dark = !!on;
    const bg = this.dark ? BG_DARK : BG_LIGHT;
    if (this.renderer) this.renderer.setClearColor(bg, 1);
    if (this.scene) this.scene.background = new THREE.Color(bg);
    if (this.scene || this.grid) this._makeGrid();
    return this.dark;
  }

  resize() {
    if (!this.renderer || !this.container) return;
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _loop() {
    if (this._disposed) return;
    this._raf = requestAnimationFrame(() => this._loop());
    const now = performance.now();
    const dt = this._lastT ? Math.min(0.1, (now - this._lastT) / 1000) : 0.016;
    this._lastT = now;
    this.controls.update();
    for (const fn of this._ticks) {
      try { fn(dt); } catch (e) { /* 单帧异常不打断渲染 */ }
    }
    this.renderer.render(this.scene, this.camera);
    if (this.showGizmo) this._renderGizmo();
  }

  /** 注册逐帧回调（插件动画 / 编辑器辅助绘制），返回取消函数 */
  addTick(fn) {
    this._ticks.add(fn);
    return () => this._ticks.delete(fn);
  }

  /* ---------------- 右下角方向参照坐标系（借用 Viewport3D 的 gizmo） ---------------- */
  _initGizmo() {
    const scene = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, 0.1, 10);
    const axes = [
      [new THREE.Vector3(1, 0, 0), 0xe5484d, 'X'],
      [new THREE.Vector3(0, 1, 0), 0x30a46c, 'Y'],
      [new THREE.Vector3(0, 0, 1), 0x2f6fed, 'Z'],
    ];
    for (const [dir, color, label] of axes) {
      scene.add(new THREE.ArrowHelper(dir, new THREE.Vector3(), 1.15, color, 0.26, 0.14));
      const cv = document.createElement('canvas');
      cv.width = cv.height = 64;
      const c2 = cv.getContext('2d');
      c2.font = 'bold 42px system-ui, sans-serif';
      c2.fillStyle = '#' + color.toString(16).padStart(6, '0');
      c2.textAlign = 'center';
      c2.textBaseline = 'middle';
      c2.fillText(label, 32, 36);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false }));
      sp.scale.set(0.46, 0.46, 1);
      sp.position.copy(dir).multiplyScalar(1.5);
      scene.add(sp);
    }
    this._gizmoScene = scene;
    this._gizmoCam = cam;
  }

  _renderGizmo() {
    if (!this._gizmoScene) return;
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    const cam = this._gizmoCam;
    cam.position.copy(this.camera.position).sub(this.controls.target).normalize().multiplyScalar(5);
    cam.lookAt(0, 0, 0);
    const size = 92;
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.setViewport(w - size - 10, 34, size, size);
    this.renderer.setScissor(w - size - 10, 34, size, size);
    this.renderer.setScissorTest(true);
    this.renderer.render(this._gizmoScene, cam);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, w, h);
    this.renderer.autoClear = true;
  }

  dispose() {
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    if (this._resizeObs) { try { this._resizeObs.disconnect(); } catch (e) { /* ignore */ } }
    if (this._onWinResize) window.removeEventListener('resize', this._onWinResize);
    if (this.controls) { try { this.controls.dispose(); } catch (e) { /* ignore */ } this.controls = null; }
    this.clearModel();
    if (this.grid) {
      if (this.scene) this.scene.remove(this.grid);
      try { this.grid.geometry.dispose(); } catch (e) { /* ignore */ }
      try { this.grid.material.dispose(); } catch (e) { /* ignore */ }
      this.grid = null;
    }
    if (this.axes) {
      if (this.scene) this.scene.remove(this.axes);
      this.axes = null;
    }
    if (this._gizmoScene) {
      this._gizmoScene.traverse((o) => {
        if (!o.material) return;
        if (o.material.map) { try { o.material.map.dispose(); } catch (e) { /* ignore */ } }
        try { o.material.dispose(); } catch (e) { /* ignore */ }
      });
      this._gizmoScene = null;
      this._gizmoCam = null;
    }
    if (this.renderer) {
      this.renderer.dispose();
      if (this.renderer.forceContextLoss) { try { this.renderer.forceContextLoss(); } catch (e) { /* ignore */ } }
      const cv = this.renderer.domElement;
      if (cv && cv.parentNode) cv.parentNode.removeChild(cv);
    }
    this.renderer = null;
    this.scene = null;
  }

  /* ---------------- 模型 ---------------- */

  /* 注册共享资源提供方：clearModel 时跳过引擎缓存原型持有的 geometry/material/texture
   * （GLB 原型被 clone(true) 出的实例共享资源，dispose 掉会让下一次渲染重新上传 + 重编译，
   *   口径同 ha-3d-home View3D.disposeGroup 的 _sharedRes）。由 PluginPreview 挂上引擎。 */
  setProtoProvider(fn) { this._protoProvider = fn || null; }

  _collectShared() {
    const shared = new Set();
    let res = null;
    try { res = this._protoProvider && this._protoProvider(); } catch (e) { res = null; }
    if (!res) return shared;
    (res.scenes || []).forEach((s) => {
      if (!s || typeof s.traverse !== 'function') return;
      s.traverse((o) => {
        if (o.geometry) shared.add(o.geometry);
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => {
          if (!m) return;
          shared.add(m);
          for (const k of ['map', 'emissiveMap', 'alphaMap', 'normalMap']) if (m[k]) shared.add(m[k]);
        });
      });
    });
    (res.textures || []).forEach((t) => { if (t) shared.add(t); });
    return shared;
  }

  clearModel() {
    if (!this.modelRoot) return;
    const shared = this._collectShared();
    while (this.modelRoot.children.length) {
      const c = this.modelRoot.children[0];
      this.modelRoot.remove(c);
      this._disposeObject(c, shared);
    }
  }

  /** 挂载新的模型根（先清空旧的），并重置模型整体变换 */
  setModel(obj3d) {
    this.clearModel();
    this._modelXform = { rx: 0, ry: 0, rz: 0, x: 0, y: 0, z: 0 };
    this._applyModelXform();
    if (obj3d) this.modelRoot.add(obj3d);
  }

  _disposeObject(root, shared) {
    shared = shared || new Set();
    root.traverse((o) => {
      if (o.geometry && !shared.has(o.geometry)) { try { o.geometry.dispose(); } catch (e) { /* ignore */ } }
      const m = o.material;
      if (m) {
        const list = Array.isArray(m) ? m : [m];
        list.forEach((mm) => {
          if (!mm || shared.has(mm)) return;
          for (const k of ['map', 'emissiveMap', 'alphaMap', 'normalMap']) {
            if (mm[k] && !shared.has(mm[k])) { try { mm[k].dispose(); } catch (e) { /* ignore */ } }
          }
          try { mm.dispose(); } catch (e) { /* ignore */ }
        });
      }
    });
  }

  /** 模型包围盒（世界坐标）；空模型返回 null */
  bounds() {
    if (!this.modelRoot || !this.modelRoot.children.length) return null;
    const box = new THREE.Box3().setFromObject(this.modelRoot);
    if (!isFinite(box.min.x) || !isFinite(box.max.x)) return null;
    return box;
  }

  /** 模型包围球半径（空模型给 1） */
  radius() {
    const box = this.bounds();
    if (!box) return 1;
    const s = new THREE.Vector3();
    box.getSize(s);
    return Math.max(0.15, 0.5 * Math.hypot(s.x, s.y, s.z));
  }

  /* ---------------- 相机 ---------------- */
  _pose(opts) {
    const o = opts || {};
    const preset = o.view ? (VIEW_PRESETS[o.view] || VIEW_PRESETS.iso) : null;
    const base = preset || {};
    const box = this.bounds();
    /* 取景时给模型顶部留 0.4m 净空：设备标签悬浮在包围盒顶上方，
       不留的话标签会被钳到画布最顶边，看起来离设备很远 */
    const center = box ? box.getCenter(new THREE.Vector3()).setY((box.min.y + box.max.y + 0.4) / 2) : new THREE.Vector3(0, 0.4, 0);
    const radius = this.radius() + 0.2;
    const fitDist = radius / Math.sin((this.camera.fov * D2R) / 2) * 1.05;

    const target = Array.isArray(o.target)
      ? new THREE.Vector3(o.target[0], o.target[1], o.target[2])
      : center;

    let distance = o.distance != null ? Number(o.distance) : null;
    if (distance == null) {
      const zoom = o.zoom != null ? Number(o.zoom) : (base.zoom != null ? base.zoom : 1);
      distance = fitDist * zoom;
    }
    return {
      target,
      distance: clamp(distance, 0.12, 200),
      azimuth: o.azimuth != null ? Number(o.azimuth) : (base.azimuth != null ? base.azimuth : 45),
      elevation: o.elevation != null ? Number(o.elevation) : (base.elevation != null ? base.elevation : 30),
    };
  }

  _placeCamera(cam, pose) {
    const sph = new THREE.Spherical(pose.distance, (90 - pose.elevation) * D2R, pose.azimuth * D2R);
    const off = new THREE.Vector3().setFromSpherical(sph);
    cam.position.copy(pose.target).add(off);
    cam.up.set(0, 1, 0);
    cam.lookAt(pose.target);
  }

  /** 绝对定位相机：{ view } 或 { azimuth, elevation, distance, zoom, target } */
  setCamera(opts) {
    const pose = this._pose(opts);
    this._placeCamera(this.camera, pose);
    this.controls.target.copy(pose.target);
    this.controls.update();
    return { azimuth: pose.azimuth, elevation: pose.elevation, distance: pose.distance, target: [pose.target.x, pose.target.y, pose.target.z] };
  }

  /** 套用预设视角 */
  applyView(name) { return this.setCamera({ view: name }); }

  /** 绕目标旋转（度，相对当前） */
  orbit(deltaAzimuth = 0, deltaElevation = 0) {
    const off = this.camera.position.clone().sub(this.controls.target);
    const sph = new THREE.Spherical().setFromVector3(off);
    sph.theta += Number(deltaAzimuth) * D2R;
    const phi = sph.phi - Number(deltaElevation) * D2R;
    sph.phi = clamp(phi, 0.04, Math.PI - 0.04);
    off.setFromSpherical(sph);
    this.camera.position.copy(this.controls.target).add(off);
    this.controls.update();
    this._snapState();
    return this.cameraState();
  }

  /** 平移视图（dx/dy 为视口宽/高的比例，正 dx 视角向右移） */
  pan(dx = 0, dy = 0) {
    const dist = this.camera.position.distanceTo(this.controls.target);
    const hTan = Math.tan((this.camera.fov * D2R) / 2);
    const h = 2 * hTan * dist;
    const w = h * this.camera.aspect;
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    const off = right.multiplyScalar(-Number(dx) * w).add(up.multiplyScalar(Number(dy) * h));
    this.camera.position.add(off);
    this.controls.target.add(off);
    this.controls.update();
    this._snapState();
    return this.cameraState();
  }

  /** 缩放（factor > 1 拉远，< 1 拉近） */
  zoomBy(factor = 1) {
    const f = clamp(Number(factor) || 1, 0.1, 10);
    const off = this.camera.position.clone().sub(this.controls.target).multiplyScalar(f);
    this.camera.position.copy(this.controls.target).add(off);
    this.controls.update();
    this._snapState();
    return this.cameraState();
  }

  _snapState() {
    /* OrbitControls damping 会在下一帧把位置往回带，这里同步一次内部球坐标，避免抖动 */
    if (this.controls && typeof this.controls.update === 'function') this.controls.update();
  }

  cameraState() {
    const off = this.camera.position.clone().sub(this.controls.target);
    const sph = new THREE.Spherical().setFromVector3(off);
    const az = sph.theta / D2R;
    return {
      azimuth: Math.round(((az % 360) + 360) % 360 * 10) / 10,
      elevation: Math.round((90 - sph.phi / D2R) * 10) / 10,
      distance: Math.round(sph.radius * 1000) / 1000,
      target: [
        Math.round(this.controls.target.x * 1000) / 1000,
        Math.round(this.controls.target.y * 1000) / 1000,
        Math.round(this.controls.target.z * 1000) / 1000,
      ],
    };
  }

  /* ---------------- 模型整体变换（旋转 / 移动 / 归位） ---------------- */
  _applyModelXform() {
    if (!this.modelRoot) return;
    const x = this._modelXform;
    this.modelRoot.position.set(x.x, x.y, x.z);
    this.modelRoot.rotation.set(x.rx * D2R, x.ry * D2R, x.rz * D2R);
  }

  /** 相对当前旋转/移动模型（度 / 米）；reset 归位。返回当前变换 */
  transformModel(opts) {
    const o = opts || {};
    if (o.reset) this._modelXform = { rx: 0, ry: 0, rz: 0, x: 0, y: 0, z: 0 };
    if (o.set) {
      this._modelXform = {
        rx: Number(o.set.rx) || 0, ry: Number(o.set.ry) || 0, rz: Number(o.set.rz) || 0,
        x: Number(o.set.x) || 0, y: Number(o.set.y) || 0, z: Number(o.set.z) || 0,
      };
    }
    for (const k of ['rx', 'ry', 'rz', 'x', 'y', 'z']) {
      if (o[k] != null) this._modelXform[k] += Number(o[k]) || 0;
    }
    this._applyModelXform();
    return Object.assign({}, this._modelXform);
  }

  /** 当前模型整体姿态（排查问题时可读回，便于复现同一机位） */
  modelState() { return Object.assign({}, this._modelXform); }

  setGrid(v) { if (this.grid) this.grid.visible = !!v; }
  setAxes(v) { if (this.axes) this.axes.visible = !!v; }

  /* ---------------- 设备点击 / 标签定位 ---------------- */

  /** 屏幕坐标（clientX/Y）→ 射线拾取；命中 meshes 返回第一个交点对象，否则 null */
  pickAt(clientX, clientY, meshes) {
    if (!this.renderer || !this.camera || !meshes || !meshes.length) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    if (!this._raycaster) this._raycaster = new THREE.Raycaster();
    this._raycaster.setFromCamera(ndc, this.camera);
    const hits = this._raycaster.intersectObjects(meshes, false);
    return hits.length ? hits[0].object : null;
  }

  /** 世界坐标 → 画布内像素坐标（标签跟随设备用）；behind = 点在相机身后 */
  projectToScreen(v) {
    if (!this.renderer || !this.camera) return null;
    if (!this._pv) this._pv = new THREE.Vector3();
    this._pv.set(v.x, v.y, v.z).project(this.camera);
    const el = this.renderer.domElement;
    return {
      x: (this._pv.x + 1) / 2 * el.clientWidth,
      y: (-this._pv.y + 1) / 2 * el.clientHeight,
      behind: this._pv.z > 1,
    };
  }

  /* ---------------- 截图 ---------------- */
  /**
   * 离屏渲染一张 PNG。
   * @param {object} o
   *   width/height  像素尺寸（默认 960×640）
   *   view          视角预设名（iso/front/back/left/right/top/low/detail）
   *   azimuth/elevation/distance/zoom/target  自定义机位（优先于 view）
   *   background    背景色（十六进制数或 CSS 色）；传 null = 透明
   *   withGrid/isolation  是否显示网格（默认跟随当前开关）
   * @returns {string|null} data:image/png;base64,...
   */
  snapshot(o) {
    const opts = o || {};
    if (!this.renderer || !this.scene) return null;
    const w = clamp(Math.round(Number(opts.width) || 960), 64, 2048);
    const h = clamp(Math.round(Number(opts.height) || 640), 64, 2048);
    const gridWas = this.grid ? this.grid.visible : true;
    let tmp = null;
    try {
      const cam = this.camera.clone();
      cam.aspect = w / h;
      cam.fov = opts.fov ? Number(opts.fov) : this.camera.fov;
      cam.updateProjectionMatrix();
      this._placeCamera(cam, this._pose(opts));

      if (opts.withGrid != null && this.grid) this.grid.visible = !!opts.withGrid;

      tmp = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      /* 截图用的是另一个渲染器：口径必须和主视口一致，否则 MCP 截出来的图与实际画面对不上 */
      applyLegacyRenderer(tmp);
      tmp.setPixelRatio(1);
      tmp.setSize(w, h, false);
      const transparent = opts.background === null;
      /* 缺省背景跟随当前主题（暗色模式截图自动是深底），显式传 background 仍优先 */
      const defaultBg = this.dark ? BG_DARK : BG_LIGHT;
      tmp.setClearColor(transparent ? 0x000000 : (opts.background != null ? opts.background : defaultBg), transparent ? 0 : 1);
      tmp.render(this.scene, cam);
      return tmp.domElement.toDataURL('image/png');
    } catch (e) {
      return null;
    } finally {
      if (this.grid) this.grid.visible = gridWas;
      if (tmp) {
        try { tmp.dispose(); } catch (e) { /* ignore */ }
        if (tmp.forceContextLoss) { try { tmp.forceContextLoss(); } catch (e) { /* ignore */ } }
      }
    }
  }
}
