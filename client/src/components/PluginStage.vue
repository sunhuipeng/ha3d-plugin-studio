<script setup>
/* PluginStage — 插件引擎渲染区（中心画布）
 *
 * 用移植过来的插件引擎把「当前项目生成的 plugin.js」真正跑起来：
 *   · 清空上一轮渲染 → 执行最新代码 → 重新渲染
 *   · 视角预设 / 鼠标旋转平移缩放 / 模型整体旋转移动
 *   · 模拟实体状态开关（改值 → 插件 update() → 画面变化）
 *   · 右上角矩形 2D 平面预览
 *   · 任意视角离屏截图（供 MCP 观察）
 */
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { S, act, api, saveNow, scheduleSave, viewportApi, toast } from '../store';
import { ThreeHost, VIEW_PRESETS } from '../engine/three-host';
import { PluginPreview } from '../engine/plugin-preview';
import { normalizeOptions } from '../option-schema';
import PlanInset from './PlanInset.vue';

/* 预览视角固定四分之三（iso）；MCP 的 view/screenshot 参数仍可临时指定其他视角 */
const mount = ref(null);
const devLabel = ref(null);
const busy = ref(false);
const err = ref('');
const view = ref('iso');
const grid = ref(true);
const axes = ref(false);
const status = computed(() => S.previewStatus);   // 单一数据源：S.previewStatus（PlanInset/CodePanel 也读它）
const entities = ref([]);
/* 样式参数只有一个来源：项目 styles[].options[].def（AI 代码里写死的不作依据，
 * 引擎注册时会用项目配置覆盖）。这里不再维护第二份 styleOpts */

let host = null;
let preview = null;
let disposed = false;

const styles = computed(() => (S.proj && S.proj.styles) || []);
const curStyle = computed(() => styles.value.find((x) => x.id === S.styleId) || null);
const curStyleName = computed(() => (curStyle.value ? (curStyle.value.name || curStyle.value.id) : ''));

/* 插件大类：渲染区运行状态上报的 kind 优先（反映实际注册结果），项目配置兜底 */
const pluginKind = computed(() =>
  (status.value && status.value.kind)
  || (S.proj && S.proj.plugin && S.proj.plugin.kind) || '');
/* 门窗不是「设备」，没有主实体：状态全部来自字段（门磁 / 开门比例）。
   引擎为了兜底造了个 binary_sensor.preview_main，面板上不显示它 */
const isOpening = computed(() => pluginKind.value === 'opening');
/* 背景插件：左下角卡片换成「安全范围」参数 —— 长×宽（米），可输入 / 滚轮快速调整 */
const isBg = computed(() => pluginKind.value === 'background');
/* 设备类：左下角多一张「样式」卡片（离地高度 / 标签高度，存 styles 里） */
const isDevice = computed(() => pluginKind.value === 'device');

/* ---------------- 左下角「样式」卡片（设备类） ----------------
 * 卡片里改的是 styles 上存的两项元信息（定义层，和左侧「样式」面板同一份数据）：
 *   z            离地高度（米）
 *   labelOffset  标签高度（米）——状态标签相对「设备接地点」的距地高度，清空 = 贴模型顶面
 * 只写数据（项目 JSON 自动保存），不做任何引擎侧改造：预览标签本身每帧按当前样式的
 * labelOffset 定位，所以把同一个值镜像到 preview.style 上就能即时看到。
 * ⚠ z 目前只是存数据，预览里怎么「抬起设备」等引擎侧方案定了再接。 */
const metaZ = ref(0);
const metaLabel = ref('');
function syncStyleMeta() {
  const st = curStyle.value;
  metaZ.value = Number(st && st.z) || 0;
  const lo = st && st.labelOffset;
  metaLabel.value = (lo === undefined || lo === null || lo === '') ? '' : Number(lo);
}
let metaTimer = null;
const clampMeta = (n) => Math.round(Math.max(0, Math.min(10, n)) * 100) / 100;
/* 预览锁着的样式对象（plugin-preview.style）与项目里的样式是两份数据：
   写项目那份负责存盘，同步一份给预览负责即时生效（只在组件侧赋值，不动引擎） */
function applyStyleMetaToPreview() {
  const ps = preview && preview.style;
  if (!ps) return;
  ps.z = metaZ.value;
  if (metaLabel.value === '') delete ps.labelOffset; else ps.labelOffset = metaLabel.value;
}
function setMeta(key, raw) {
  const st = curStyle.value;
  if (!st) return;
  if (key === 'z') {
    const n = Number(raw);
    if (!isFinite(n)) return;
    metaZ.value = clampMeta(n);
    st.z = metaZ.value;
  } else {
    const empty = raw === '' || raw === null || raw === undefined;
    const n = Number(raw);
    const v = (empty || !isFinite(n)) ? null : clampMeta(n);
    metaLabel.value = v == null ? '' : v;
    if (v == null) delete st.labelOffset; else st.labelOffset = v;
  }
  applyStyleMetaToPreview();
  /* 连续输入时防抖存盘（这两项不影响几何，不用重渲） */
  clearTimeout(metaTimer);
  metaTimer = setTimeout(() => { if (!disposed) scheduleSave(); }, 300);
}
function wheelMeta(key, e) {
  const cur = key === 'z' ? metaZ.value : (metaLabel.value === '' ? '' : Number(metaLabel.value));
  const base = Number.isFinite(Number(cur)) ? Number(cur) : 0;
  setMeta(key, base + (e.deltaY < 0 ? 0.05 : -0.05));
}

/* 当前样式声明的参数 + 实际生效值。背景项目：def 就是动态存储值（卡片改值=改 def，面板改 def=卡片跟着变）
 * ⚠ 不过滤「还没填 key」的半成品条目：面板里加一条参数、key 空着时，
 *   左下卡片也要能看见并试调（只是插件读不到，卡片上标「未命名」）。
 *   所以每条都带上原始下标 _idx，写回时按下标定位，不依赖 key 唯一。 */
const styleParams = computed(() => {
  /* type 归一化：bool → checkbox、缺省/未知 → text（口径见 option-schema.js） */
  const list = normalizeOptions((curStyle.value && curStyle.value.options) || []);
  return list
    .map((o, i) => (o && typeof o === 'object' ? { o, i } : null))
    .filter(Boolean)
    .map(({ o, i }) => {
      const key = o.key || '';
      return Object.assign({}, o, { _idx: i, named: !!key, value: o.def });
    });
});
/* 还没填 key 的参数条数（卡片底部提示用） */
const draftOptCount = computed(() => styleParams.value.filter((o) => !o.named).length);

/* 背景插件的安全范围（长×宽 米）：占位长方体实时缩放，值持久化在项目 safeW/safeD */
const safeSize = ref({ w: 8, d: 8 });
let safeTimer = null;
/* 从项目 JSON 回读（safeW/safeD 持久化在项目里，刷新后不丢） */
function loadSafeSize() {
  safeSize.value = {
    w: Number(S.proj && S.proj.safeW) || 8,
    d: Number(S.proj && S.proj.safeD) || 8,
  };
}
/* 实时预览：只 scale 占位长方体，不重跑 apply（背景不用重画） */
function applySafeOverlay() {
  if (preview && preview.safeBox) preview.safeBox.scale.set(safeSize.value.w, 1, safeSize.value.d);
}
function setSafeSize(dim, v) {
  const n = Number(v);
  if (!isFinite(n)) return;
  const c = Math.max(2, Math.min(100, n));   // 即时钳制：滚轮/输入不会把占位盒打成 0 或负数
  safeSize.value = Object.assign({}, safeSize.value, { [dim]: c });
  /* 写进项目数据，完整重绘时的 saveNow() 会存进项目 JSON */
  if (S.proj) { S.proj['safe' + dim.toUpperCase()] = c; }
  applySafeOverlay();
}
function wheelSafeSize(dim, e) {
  setSafeSize(dim, (Number(safeSize.value[dim]) || 8) + (e.deltaY < 0 ? 1 : -1));
  /* 滚轮不产生 blur —— 停手后 800ms 自动完整重绘一次兜底 */
  clearTimeout(safeTimer);
  safeTimer = setTimeout(() => refresh(view.value), 800);
}
/* 焦点离开输入框：归一化数值 + 完整重绘一遍背景 */
function commitSafe() {
  clearTimeout(safeTimer);
  const w = Math.min(100, Math.max(2, Math.round(Number(safeSize.value.w) || 8)));
  const d = Math.min(100, Math.max(2, Math.round(Number(safeSize.value.d) || 8)));
  safeSize.value = { w, d };
  if (S.proj) { S.proj.safeW = w; S.proj.safeD = d; }
  applySafeOverlay();
  refresh(view.value);
}

/* 打开背景项目时：经服务端代理读 ha-3d-home 当前户型的长×宽，
 * 返回有效值就更新安全范围（长/宽卡片 + 项目 JSON），并完整重绘一次（房屋尺寸影响构图）。
 * home 未配置 / 不可达 / 无有效值 → 静默跳过，保留本地 safeW/safeD */
async function syncHouseSize() {
  if (!isBg.value || !S.proj || disposed) return;
  try {
    const res = await api('GET', '/api/home/house');
    const w = Math.round(Number(res && res.houseW) * 10) / 10;
    const h = Math.round(Number(res && res.houseD) * 10) / 10;
    if (!res || !res.ok || !(w > 0) || !(h > 0)) return;
    if (Number(S.proj.safeW) === w && Number(S.proj.safeD) === h) { applySafeOverlay(); return; }
    safeSize.value = { w, d: h };
    S.proj.safeW = w;
    S.proj.safeD = h;
    applySafeOverlay();
    refresh(view.value);
  } catch (e) { /* 静默：home 不可达不影响编辑 */ }
}

/* ---------------- 样式参数 options（左下角卡片，各家插件通用） ----------------
 * 取值只有一个来源：当前样式 options 的 def（项目数据）。
 *   · 卡片里改值 → 写回 def，随自动保存落盘（左侧「样式」面板同步）；
 *   · 左侧面板里改 def → 卡片跟着变，并防抖重绘预览。
 * 引擎注册时会用项目 styles 覆盖代码里写死的常量，所以改 def 就是改画面。
 * 背景的 offsetX/offsetZ 走「先平移 group 再软重渲」的快路径，其它参数统一软重渲。 */
let bgOptTimer = null;
let optsRetry = null;   // 预览忙时的补渲定时器：拖滑条会把多次重渲挤掉，最后一次不能丢
let optsTouch = 0;   // setStyleOpt 刚写回 def 的时间戳：def 监听据此跳过自己触发的变更

/* 读某个参数在当前样式里的最新值（刚写回 def，用这份而不是本地快照） */
function optValue(key) {
  const opt = ((curStyle.value && curStyle.value.options) || []).find((o) => o && o.key === key);
  return opt ? opt.def : undefined;
}

/* 改一个参数值：o 是卡片当前绑定的那条（带 _idx），按下标写回 def，key 空着也能存。
 * 未命名的参数（key 还是空）只存 def、不重渲 —— 插件 ctx.options 里读不到它，渲了也不会变 */
function setStyleOpt(o, v) {
  const list = (curStyle.value && curStyle.value.options) || [];
  const opt = list[o._idx] || (o.key ? list.find((x) => x && x.key === o.key) : null);
  if (opt) { opt.def = v; scheduleSave(); }
  optsTouch = Date.now();
  if (!o.key) return;
  clearTimeout(bgOptTimer);
  if (isBg.value && (o.key === 'offsetX' || o.key === 'offsetZ')) {
    /* 背景偏移滑条：先直接平移背景 group 拿即时反馈，再用缓存代码软重渲 ——
     * 构图里的 house / safe 都带偏移，只有重画一次，撒点 / 马路才会跟着房屋一起挪 */
    preview.setBgOffset(optValue('offsetX'), optValue('offsetZ'));
    bgOptTimer = setTimeout(() => { if (!disposed) refreshOpts(); }, 200);
  } else {
    /* 其它参数：用缓存的代码软重渲（不打服务端 /build），120ms 防抖 ≈ 实时 */
    bgOptTimer = setTimeout(refreshOpts, 120);
  }
}
/* options 实时预览：复用 lastCode 重跑 spawn（背景 apply 重画、设备重建几何，几十 ms），不走服务端 */
async function refreshOpts() {
  if (!S.proj || !preview || busy.value || preview.loading || disposed) {
    /* 上一次渲染还没结束（拖滑条时很常见）：稍后补渲一次，别把最后一次改动丢掉 */
    if (!disposed) { clearTimeout(optsRetry); optsRetry = setTimeout(refreshOpts, 250); }
    return;
  }
  if (!lastCode) return refresh(view.value);
  err.value = '';
  try {
    const st = await preview.load({
      project: S.proj,
      code: lastCode,
      styleId: S.styleId,
      view: view.value,
      safeW: isBg.value ? safeSize.value.w : undefined,
      safeD: isBg.value ? safeSize.value.d : undefined,
    });
    entities.value = preview.listEntities();
    S.previewStatus = st;
    applyStyleMetaToPreview();   // 软重渲会重建样式对象，把卡片值贴回去
  } catch (e) {
    err.value = e.message || String(e);
    S.previewStatus = { ok: false, error: err.value };
  }
}
/* select 的 option value 在 DOM 里会变成字符串：按 schema 里的原始类型还回去 */
function castChoice(o, v) {
  const hit = (o.choices || []).find((c) => String(c.value) === String(v));
  return hit ? hit.value : v;
}
const shownEntities = computed(() => {
  const list = entities.value || [];
  return isOpening.value ? list.filter((e) => e.role !== 'main') : list;
});

/* 插件自己算出来的状态文案（门插件：已关闭 / 开 50% / 已打开） */
const effectText = computed(() => (status.value && status.value.label) || '');

/* ---------------- 主链路 ---------------- */
let lastCode = '';          // 最近一次构建出的 plugin.js：options 实时预览用它软重渲，不再打服务端
async function loadCode() {
  await saveNow();
  const d = await api('GET', `/api/projects/${S.proj.id}/build`);
  return d.js;
}

async function refresh(viewName) {
  if (!S.proj || !preview || busy.value) return null;
  busy.value = true;
  err.value = '';
  try {
    const code = await loadCode();
    lastCode = code;
    const st = await preview.load({
      project: S.proj,
      code,
      styleId: S.styleId,
      view: viewName || view.value,
      safeW: isBg.value ? safeSize.value.w : undefined,
      safeD: isBg.value ? safeSize.value.d : undefined,
    });
    entities.value = preview.listEntities();
    S.previewStatus = st;
    syncStyleMeta();
    applyStyleMetaToPreview();   // 重建后把卡片上的 z / 标签高度再贴回预览样式，重新渲染不回弹
    return st;
  } catch (e) {
    err.value = e.message || String(e);
    entities.value = [];
    S.previewStatus = { ok: false, error: err.value };
    return null;
  } finally {
    busy.value = false;
  }
}

/* ---------------- 启动页预览图（手动截图落盘） ----------------
 * 工具条「截图」按钮：按当前视角拍一张 640×480 快照存进项目目录
 * preview.png，启动页卡片直接 <img> 引用，不做任何现场 3D 渲染。 */
async function savePreviewShot() {
  if (!host || !S.proj) return;
  const cs = host.cameraState();                         // 当前机位（方位/仰角/距离/目标点）
  const bgOk = !!(preview && preview.def && preview.def.kind === 'background');
  const url = host.snapshot({
    width: 640, height: 480,
    azimuth: cs.azimuth, elevation: cs.elevation,
    distance: cs.distance, target: cs.target,            // 复刻当前角度
    background: '#ffffff',                               // 白底
    withGrid: bgOk ? false : undefined,                  // 背景插件自带整片地面，藏网格；其余跟随当前网格开关
  });
  if (!url) { toast('截图失败', true); return; }
  try {
    await act.savePreview(url);
    toast('已保存为启动页预览图');
  } catch (e) { toast('保存预览图失败: ' + e.message, true); }
}

function setView(name) {
  if (!VIEW_PRESETS[name]) return;
  view.value = name;
  host.applyView(name);
  syncStatus();
}

function toggleGrid() {
  grid.value = !grid.value;
  host.setGrid(grid.value);
}
function toggleAxes() {
  axes.value = !axes.value;
  host.setAxes(axes.value);
}

function syncStatus() {
  if (!preview) return;
  S.previewStatus = preview.describe();
}

/* 实体开关：按域给一个「另一半」状态（设备类用） */
function nextState(e) {
  const s = String(e.state || '');
  const dom = e.domain;
  if (dom === 'cover') return s === 'open' ? 'closed' : 'open';
  if (dom === 'lock') return s === 'unlocked' ? 'locked' : 'unlocked';
  if (dom === 'vacuum') return s === 'cleaning' ? 'docked' : 'cleaning';
  if (dom === 'climate') return s === 'off' ? 'cool' : 'off';
  if (dom === 'media_player') return s === 'playing' ? 'off' : 'playing';
  return (s === 'on' || s === 'open') ? 'off' : 'on';
}

/* 字段语义：按 key 判断是百分比（开门比例）还是开关量（门磁） */
const RATIO_KEY = /ratio|position|percent|pct|progress|angle/i;
function entKind(e) {
  if (e.role === 'main') return 'main';
  const k = String(e.fieldKey || '');
  if (RATIO_KEY.test(k)) return 'ratio';
  return 'binary';
}

function isOnText(s) {
  return s === 'on' || s === 'open' || s === '1' || s === 'true' || s === 'opening';
}

/* 给人看的显示值：门磁 → 开/关，比例 → 百分比 */
function entText(e) {
  const s = String(e.state == null ? '' : e.state);
  if (entKind(e) === 'ratio') {
    const n = parseFloat(s);
    return isNaN(n) ? (s || '—') : Math.round(n) + '%';
  }
  if (isOnText(s)) return '开';
  if (s === 'off' || s === 'closed' || s === 'closing' || s === '0' || s === 'false') return '关';
  return s || '—';
}

function toggleEntity(e) {
  if (!preview) return;
  try {
    const kind = entKind(e);
    let next;
    if (kind === 'ratio') {
      /* 0 → 50% → 100% → 0 循环，一档一档看效果 */
      const n = parseFloat(e.state);
      const cur = isNaN(n) ? 0 : n;
      next = cur < 50 ? '50' : cur < 100 ? '100' : '0';
    } else if (kind === 'binary') {
      next = isOnText(String(e.state || '')) ? 'off' : 'on';
    } else {
      next = nextState(e);
    }
    preview.setEntity(e.entityId, next);
    entities.value = preview.listEntities();
    syncStatus();
  } catch (ex) { toast('改状态失败: ' + ex.message, true); }
}

/* ---------------- 生命周期 ---------------- */
function initHost() {
  host = new ThreeHost(mount.value);
  host.init();
  host.setGrid(grid.value);
  host.setAxes(axes.value);
  preview = new PluginPreview(host);

  /* 设备标签：每帧把锚点投影到屏幕，移动 DOM（文案变了才改 innerText） */
  host.addTick(() => updateLabelDom());

  /* 点击设备主体 → 按 click 配置切实体状态；拖拽视角后的松手不算点击 */
  const dom = host.renderer.domElement;
  let downX = 0, downY = 0;
  dom.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; });
  dom.addEventListener('click', (e) => {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;   // 拖拽视角，不算
    if (preview && preview.pickDevice(e)) clickDevice();
  });
  dom.addEventListener('mousemove', (e) => {
    dom.style.cursor = (preview && preview.pickDevice(e)) ? 'pointer' : '';
  });
}

/* 点击设备（主体或标签共用）：切状态 → 刷新左下角实体卡 */
function clickDevice() {
  if (!preview) return;
  try {
    preview.toggleDevice();
    entities.value = preview.listEntities();
    syncStatus();
  } catch (ex) { toast('切换失败: ' + ex.message, true); }
}

/* 更新标签文案与位置：锚点由 labelInfo() 投影到屏幕（设备中心正上方，距地 labelOffset 米），
   每帧写 left/top；文案/状态没变就不碰 DOM */
function updateLabelDom() {
  const el = devLabel.value;
  if (!el || !preview || !host) return;
  const info = preview.labelInfo();
  if (!info) { el.style.display = 'none'; el._sig = ''; return; }
  el.style.display = '';
  /* 位置有变化才写 style（每帧都在跑，亚像素抖动直接忽略） */
  const nx = Math.round(info.x * 10) / 10;
  const ny = Math.round(info.y * 10) / 10;
  if (el._px !== nx) { el.style.left = nx + 'px'; el._px = nx; }
  if (el._py !== ny) { el.style.top = ny + 'px'; el._py = ny; }
  if (el._sig !== info.sig) {
    el._sig = info.sig;
    el.querySelector('.ln').textContent = info.name;
    el.querySelector('.lv').textContent = info.text;
    el.classList.toggle('on', info.on);
    el.classList.toggle('clickable', info.clickable);
  }
}

onMounted(async () => {
  initHost();

  /* 供 MCP / 其它面板调用 */
  viewportApi.pluginPreview = {
    refresh: (o) => refresh((o && o.view) || view.value),
    screenshot: (o) => host.snapshot(o || {}),
    setCamera: (o) => { const r = host.setCamera(o || {}); syncStatus(); return r; },
    setView: (name) => { setView(name); return host.cameraState(); },
    orbit: (a, e) => { const r = host.orbit(a, e); syncStatus(); return r; },
    pan: (dx, dy) => { const r = host.pan(dx, dy); syncStatus(); return r; },
    zoom: (f) => { const r = host.zoomBy(f); syncStatus(); return r; },
    transformModel: (o) => host.transformModel(o || {}),
    setEntity: (eid, state, attrs) => {
      const r = preview.setEntity(eid, state, attrs);
      entities.value = preview.listEntities();
      syncStatus();
      return r;
    },
    listEntities: () => preview.listEntities(),
    labelText: () => preview.labelText(),
    describe: () => preview.describe(),
    /* 点击控制（MCP studio_click / studio_label 用） */
    isOnNow: () => preview.isOnNow(),
    toggleDevice: () => preview.toggleDevice(),
    labelState: () => ({
      label: preview.labelText(),
      clickable: !!preview._clickSpec,
      on: preview.isOnNow(),
    }),
    /* 2D 平面线稿：PlanInset 拿 preview 实例去取 planInfo / planSymbol */
    getPreview: () => preview,
    loading: () => busy.value,
  };

  await nextTick();
  loadSafeSize();
  await refresh(view.value);
  syncHouseSize();   // 背景项目：拉 home 户型长宽，有效则覆盖并重绘
  syncStyleMeta();   // 渲染后才确定 def.kind，卡片的「设备专属」判定此时才可靠（渲染前那次省掉）
});

onBeforeUnmount(() => {
  disposed = true;
  if (viewportApi.pluginPreview) delete viewportApi.pluginPreview;
  try { if (preview) preview.destroy(); } catch (e) { /* ignore */ }
  try { if (host) host.dispose(); } catch (e) { /* ignore */ }
  preview = null;
  host = null;
});

/* 切项目 / 切样式 → 重新渲染 */
watch(() => S.proj && S.proj.id, (id) => {
  if (id && !disposed) { loadSafeSize(); syncStyleMeta(); refresh(view.value).then(syncHouseSize); }
});
/* 切样式 → 参数 schema 换了，重新渲染（取值全部来自项目 def，没有需要带过去的状态） */
watch(() => S.styleId, () => {
  syncStyleMeta();
  if (!disposed) refresh(view.value);
});
/* 左侧「样式」面板改 z / labelOffset → 卡片同步（同一份数据，反方向） */
watch(() => [(curStyle.value && curStyle.value.z), (curStyle.value && curStyle.value.labelOffset)],
  () => { syncStyleMeta(); applyStyleMetaToPreview(); });

/* 左侧面板里改 options 的 def（含新增/删除参数、改 key）→ 卡片值同步 + 防抖重绘预览。
 * setStyleOpt 自己写回 def 的变更在这里跳过（已按 key 走各自的实时预览路径）。 */
let defTimer = null;
watch(() => JSON.stringify(((curStyle.value && curStyle.value.options) || []).map((o) => o && [o.key, o.def])), () => {
  if (disposed || Date.now() - optsTouch < 400) return;
  clearTimeout(defTimer);
  defTimer = setTimeout(() => { if (!disposed) refreshOpts(); }, 150);
});
</script>

<template>
  <main id="center" class="pv-stage">
    <div ref="mount" class="pv-mount"></div>

    <!-- 设备状态标签：跟随 3D 设备，贴在「设备模型中心正上方、labelOffset 指定的距地高度」处，
         每帧由 updateLabelDom() 写 left/top（translate(-50%,-100%) 让标签底边落在锚点上） -->
    <div ref="devLabel" class="dev3d-label" style="display: none"
      title="点击切换设备状态" @click="clickDevice">
      <span class="ln"></span><span class="lv"></span>
    </div>

    <!-- 顶部一排三块：左工具条（视角辅助 / 重渲）、生成预览图（独立块）、快速切样式（贴 2D 预览左侧） -->
    <div class="pv-topbar">
      <div class="pv-toolbar">
        <!-- 视角固定四分之三（iso），不再提供切换；MCP 仍可临时指定其他视角出图 -->
        <button class="pv-btn sm" :class="{ on: grid }" title="显示/隐藏地面网格" @click="toggleGrid">网格</button>
        <button class="pv-btn sm" :class="{ on: axes }" title="显示/隐藏世界坐标轴" @click="toggleAxes">轴</button>

        <span class="pv-sep"></span>
        <button class="pv-btn primary" :disabled="busy" title="保存项目 → 重新生成 plugin.js → 清空旧渲染并重新渲染" @click="refresh()">
          {{ busy ? '渲染中…' : '重新渲染' }}
        </button>
      </div>

      <!-- 生成预览图：独立一块，不与左侧工具条混排 -->
      <div class="pv-shot-bar">
        <button class="pv-btn" title="按当前视角截图，保存为启动页预览图" @click="savePreviewShot">📷</button>
      </div>

      <!-- 快速切样式：与左侧「样式」面板、面板顶部胶囊共用 S.styleId -->
      <div v-if="styles.length > 1" class="pv-styles-bar">
        <span class="pv-qs-label">样式</span>
        <button v-for="s in styles" :key="s.id" class="pv-style" :class="{ on: s.id === S.styleId }"
          :title="'切到「' + (s.name || s.id) + '」并重新渲染'" @click="S.styleId = s.id">{{ s.name || s.id }}</button>
      </div>
    </div>

    <!-- 左下角卡片栈（从上到下）：样式(设备) → 样式参数(有 options 的都在) → 背景参数/预览状态 -->
    <div class="pv-bottomleft">
    <!-- 样式：设备专属，存 styles 上的「离地高度 z」与「标签高度 labelOffset」 -->
    <div v-if="isDevice" class="pv-entities">
      <div class="pv-ent-head">样式<span class="pv-ent-cur">{{ curStyleName }}</span></div>
      <div class="pv-ent pv-ent-safe" title="离地高度（米）：设备接地点相对地面的高度，0 = 落地">
        <span class="pv-ent-name">离地高度</span>
        <span class="pv-safe-inputs">
          <label class="pv-safe-item"><input class="pv-safe-num" type="number" min="0" max="10" step="0.05"
            :value="metaZ" @input="setMeta('z', $event.target.value)"
            @wheel.prevent="wheelMeta('z', $event)">m</label>
        </span>
      </div>
      <div class="pv-ent pv-ent-safe" title="标签高度（米）：状态标签相对设备接地点的距地高度；清空 = 贴在模型顶面">
        <span class="pv-ent-name">标签高度</span>
        <span class="pv-safe-inputs">
          <label class="pv-safe-item"><input class="pv-safe-num" type="number" min="0" max="10" step="0.05"
            :value="metaLabel" placeholder="模型顶" @input="setMeta('labelOffset', $event.target.value)"
            @wheel.prevent="wheelMeta('labelOffset', $event)">m</label>
        </span>
      </div>
      <div class="pv-ent-tip">输入或滚轮调整；改的是 styles 里存的样式元信息，随项目自动保存</div>
    </div>

    <!-- 样式参数（options schema）：任何插件只要有 options 就展示，改值防抖后重绘预览。
         key 还没填的半成品条目也照样展示（标「未命名」），方便先试调再补 key -->
    <div v-if="styleParams.length" class="pv-entities">
      <div class="pv-ent-head">样式参数<span class="pv-ent-cur">{{ curStyleName }}</span></div>
      <div v-for="o in styleParams" :key="'opt-' + o._idx" class="pv-ent pv-bg-opt"
        :class="{ 'pv-opt-draft': !o.named }"
        :title="o.tip || (o.named
          ? '样式参数 · ' + o.key
          : '这条参数还没填 key，插件读不到它；到左侧「样式」面板补上 key 后才会生效（值已经能存下来）')">
        <span class="pv-ent-name">{{ o.label || o.key || ('参数 ' + (o._idx + 1)) }}</span>
        <span class="pv-bg-ctrl">
          <template v-if="o.type === 'range' || o.type === 'number'">
            <input v-if="o.type === 'range'" class="pv-bg-range" type="range"
              :min="o.min" :max="o.max" :step="o.step || 0.1" :value="o.value"
              @input="setStyleOpt(o, $event.target.value)">
            <input class="pv-safe-num" type="number" :min="o.min" :max="o.max" :step="o.step || 0.1"
              :value="o.value" @input="setStyleOpt(o, $event.target.value)">
          </template>
          <select v-else-if="o.type === 'select'" class="pv-safe-num pv-bg-select"
            :value="String(o.value)" @change="setStyleOpt(o, castChoice(o, $event.target.value))">
            <option v-for="c in (o.choices || [])" :key="String(c.value)" :value="String(c.value)">{{ c.label || c.value }}</option>
          </select>
          <label v-else-if="o.type === 'checkbox'" class="pv-bg-bool">
            <input type="checkbox" :checked="o.value === true || o.value === 'true'"
              @change="setStyleOpt(o, $event.target.checked)">{{ (o.value === true || o.value === 'true') ? '开' : '关' }}
          </label>
          <input v-else class="pv-safe-num" type="text" :value="o.value"
            @change="setStyleOpt(o, $event.target.value)">
        </span>
      </div>
      <div class="pv-ent-tip">
        改值即改样式 options 的默认值，随项目保存；画面实时响应<template v-if="draftOptCount">。{{ draftOptCount }} 条未填 key，补 key 后才生效</template>
      </div>
    </div>

    <!-- 安全范围（引擎画半透明占位长方体） -->
    <div v-if="isBg" class="pv-entities">
      <div class="pv-ent-head">背景参数<span class="pv-ent-cur">{{ curStyleName }}</span></div>
      <div class="pv-ent pv-ent-safe" title="安全范围（米）——引擎按此尺寸绘制半透明房屋占位长方体，范围内 safe 判定为不允许">
        <span class="pv-ent-name">范围</span>
        <span class="pv-safe-inputs">
          <label class="pv-safe-item">长<input class="pv-safe-num" type="number" min="2" max="100" step="1"
            :value="safeSize.w" @input="setSafeSize('w', $event.target.value)"
            @wheel.prevent="wheelSafeSize('w', $event)" @blur="commitSafe">m</label>
          <label class="pv-safe-item">宽<input class="pv-safe-num" type="number" min="2" max="100" step="1"
            :value="safeSize.d" @input="setSafeSize('d', $event.target.value)"
            @wheel.prevent="wheelSafeSize('d', $event)" @blur="commitSafe">m</label>
        </span>
      </div>
      <div class="pv-ent-tip">输入或滚轮实时预览占位范围；鼠标离开输入框后重绘背景并存入项目</div>
    </div>
    <div v-else-if="shownEntities.length || effectText" class="pv-entities">
      <div class="pv-ent-head">预览状态<span class="pv-ent-cur">{{ curStyleName }}</span></div>

      <div v-for="e in shownEntities" :key="e.entityId" class="pv-ent"
        :title="e.entityId + (e.fieldTip ? '｜' + e.fieldTip : '') + '（点击切换）'">
        <span class="pv-ent-dot" :class="{ on: entKind(e) === 'ratio' ? parseFloat(e.state) > 0 : isOnText(String(e.state || '')) }"></span>
        <span class="pv-ent-name">{{ e.label || e.name }}</span>
        <button class="pv-ent-val" @click="toggleEntity(e)">{{ entText(e) }}</button>
      </div>

      <template v-if="effectText">
        <div v-if="shownEntities.length" class="pv-ent-sep"></div>
        <div class="pv-ent pv-ent-effect">
          <span class="pv-ent-name">效果</span>
          <span class="pv-ent-effect-val">{{ effectText }}</span>
        </div>
      </template>

      <div class="pv-ent-tip">点击右侧的值可切换，画面会实时响应</div>
    </div>
    </div>

    <!-- 右上角 2D 平面预览（背景插件没有 plan2d，隐藏） -->
    <PlanInset v-if="!isBg" class="pv-plan" />

    <!-- 错误 -->
    <div v-if="err" class="pv-error">
      <b>渲染失败</b>
      <pre>{{ err }}</pre>
      <span class="pv-error-tip">修好代码或部件后点「重新渲染」</span>
    </div>
    <div v-else-if="busy && !status" class="pv-empty">正在渲染插件…</div>

    <div class="pv-hint">左键拖拽 = 旋转视角 · 右键拖拽 = 平移 · 滚轮 = 缩放</div>
  </main>
</template>
