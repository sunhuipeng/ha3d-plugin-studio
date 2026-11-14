<script setup>
/* 家具项目编辑页（kind: 'catalog'）
 *
 * 和插件编辑页（LeftRail + PluginStage + RightPanel）是两条完全独立的路径：
 * 家具项目没有代码 / 实体 / 样式参数，重点是「浏览 + 逐件描述」：
 *   左：家具清单（一个 GLB = 一条，导入即生成，可删）
 *   中：3D 预览（等轴 / 正视 / 俯视 + 网格，选中哪件看哪件）
 *   右：当前家具的属性（名称 / 分类 / 尺寸（模型实测，只读）/ 兜底色 / 模型文件）
 *      尺寸不许手改：它是 GLB 的固有尺寸，实际大小在 ha-3d-home 里用「整体比例缩放」调。
 * 产物：导出或发布「家具包」= item.json（items 数组）+ 各条目引用的 glb 平铺。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { useStudio } from '../stores';
const { S, act, scheduleSave, toast, viewportApi, project, assets } = useStudio();
import { prettyName } from '../catalog';
import { ThreeHost } from '../engine/three-host';
import ProjectTitle from './common/ProjectTitle.vue';

const items = computed(() => (S.proj && S.proj.catalog && S.proj.catalog.items) || []);
const types = computed(() => (assets.catalogTypes && assets.catalogTypes.length ? assets.catalogTypes : []));
function typeName(t) {
  const hit = types.value.find((x) => x.type === t);
  return hit ? (hit.name || hit.type) : (t || '其他');
}

const selId = ref('');
const sel = computed(() => items.value.find((x) => x && x.id === selId.value) || null);

/* ---------------- 3D 预览 ---------------- */
const hostEl = ref(null);
let host = null;
let snapTimer = 0;
const loading = ref(false);
const loadErr = ref('');
const grid = ref(true);

function modelUrlOf(file) {
  return `/api/projects/${S.proj.id}/models/${encodeURIComponent(file)}`;
}

let loadPromise = null;
let loadSeq = 0;
let selecting = false;

/* 加载选中件并返回 Promise：MCP 的「点清单 → 摆机位 → 截图」必须等 GLB 真的进场景，
 * 否则会拍到 clearModel() 之后的空场景。loadSeq 防止连续切换时旧回调覆盖新模型。 */
function loadSel() {
  if (!host) return Promise.resolve(null);
  const seq = ++loadSeq;
  loadErr.value = '';
  host.clearModel();
  const it = sel.value;
  if (!it || !it.model) return Promise.resolve(null);
  loading.value = true;
  const p = new Promise((resolve) => {
    new GLTFLoader().load(modelUrlOf(it.model), (gltf) => {
      if (seq !== loadSeq) { resolve(null); return; }
      loading.value = false;
      host.setModel(gltf.scene);
      host.applyView('iso');
      /* 顺手给启动页卡片留一张快照（与插件编辑页同口径：preview.png） */
      clearTimeout(snapTimer);
      snapTimer = setTimeout(() => {
        try {
          const url = host.snapshot({ width: 960, height: 640, view: 'iso', background: 0xffffff });
          if (url) act.savePreview(url).catch(() => {});
        } catch (e) { /* 快照失败不影响编辑 */ }
      }, 500);
      resolve(describe());
    }, undefined, () => {
      if (seq !== loadSeq) { resolve(null); return; }
      loading.value = false;
      loadErr.value = '模型加载失败（文件可能损坏或不在项目里）';
      resolve(null);
    });
  });
  loadPromise = p;
  return p;
}

function view(name) { if (host) host.applyView(name); }
function fit() { if (host) host.applyView('iso'); }
function toggleGrid() {
  grid.value = !grid.value;
  if (host) host.setGrid(grid.value);
}

/* 视图状态回包，字段与插件页 preview.describe() 同口径（model = 模型姿态） */
function describe() {
  const box = host ? host.bounds() : null;
  const it = sel.value;
  return {
    ok: !loadErr.value,
    itemId: selId.value || '',
    label: (it && (it.name || it.id)) || '',
    name: (it && it.name) || '',
    modelFile: (it && it.model) || '',
    model: host ? host.modelState() : null,
    size: box ? [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z]
      .map((n) => Math.round(n * 1000) / 1000) : null,
    camera: host ? host.cameraState() : null,
    items: items.value.map((x) => ({ id: x.id, name: x.name || x.id, model: x.model || '' })),
  };
}

/* 点击左侧清单：与页面上点条目等价，但会等模型加载完成（selecting 抑制 watch 重复加载） */
async function selectItem(itemId) {
  const id = String(itemId || '');
  if (!items.value.some((x) => x && x.id === id)) {
    throw new Error(`找不到家具「${id}」（可用 studio_list_catalog_items 查全部 ${items.value.length} 件）`);
  }
  selecting = true;
  selId.value = id;
  await nextTick();
  selecting = false;
  await loadSel();
  return describe();
}

/* MCP 视图门面：与插件页 pluginPreview 同形状，底层就是同一个 ThreeHost。
 * ws-client.js 的 ensureViewportStage 统一取用，view / screenshot 一条链路服务两类项目。 */
const catalogPreview = {
  kind: 'catalog',
  selectItem,
  listItems: () => items.value.map((x) => ({ id: x.id, name: x.name || x.id, model: x.model || '' })),
  screenshot: (o) => host && host.snapshot(o || {}),
  setCamera: (o) => host && host.setCamera(o || {}),
  setView: (name) => { view(name); return host ? host.cameraState() : null; },
  orbit: (a, e) => host && host.orbit(a, e),
  pan: (dx, dy) => host && host.pan(dx, dy),
  zoom: (f) => host && host.zoomBy(f),
  transformModel: (o) => host && host.transformModel(o || {}),
  describe,
  loading: () => loading.value,
};

watch(selId, () => { if (!selecting) loadSel(); });

/* MCP 通过 studio_set_catalog_item / studio_upload_catalog_model 改了清单：
 * 服务端落盘后 ws 推 catalog 刷新，store 覆盖内存清单并 +catalogEpoch。
 * 选中项若还在、但对象被整条替换，watch(selId) 不会触发，必须在这里手动重载 3D 预览；
 * 选中项被删了就切到第一件（切换会触发 watch(selId)，不用重复 loadSel）。 */
watch(() => project.catalogEpoch, () => {
  const list = items.value;
  if (!list.some((x) => x && x.id === selId.value)) {
    selId.value = list.length ? list[0].id : '';
  } else {
    loadSel();
  }
});

onMounted(async () => {
  await nextTick();
  host = new ThreeHost(hostEl.value).init();
  host.setGrid(true);
  host.applyView('iso');
  /* 注册 MCP 视图门面（与插件页互斥挂载，不会撞 viewportApi.pluginPreview） */
  viewportApi.catalogPreview = catalogPreview;
  if (!selId.value && items.value.length) selId.value = items.value[0].id;
  else loadSel();
  /* 名称 / 分类 / 颜色在右侧直接改对象 → 手动存盘；尺寸只读，只由模型实测写入 */
});
onBeforeUnmount(() => {
  clearTimeout(snapTimer);
  if (viewportApi.catalogPreview === catalogPreview) delete viewportApi.catalogPreview;
  if (host) host.dispose();
  host = null;
});

/* ---------------- 导入 GLB（可多选） ---------------- */
const fileInput = ref(null);
const importing = ref(false);
function pickFiles() { if (!importing.value) fileInput.value && fileInput.value.click(); }

/* 本地解析 GLB 量包围盒：宽 = X，深 = Z，高 = Y（米），与 home 的 w/d/h 口径一致 */
async function measureBuffer(buf) {
  const gltf = await new GLTFLoader().parseAsync(buf, '');
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = new THREE.Vector3();
  box.getSize(size);
  gltf.scene.traverse((o) => {
    if (o.geometry) { try { o.geometry.dispose(); } catch (e) { /* ignore */ } }
  });
  const r = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
  return { w: r(size.x), d: r(size.z), h: r(size.y) };
}

/* 上传用的文件名要 ASCII 化：服务端文件名规则只收 [A-Za-z0-9._-]（挡路径穿越），
 * 「三人沙发.glb」这种名字直接 PUT 会被拒。展示名仍用用户看到的那份。 */
function safeGlbName(name) {
  const base = String(name || '').replace(/\.glb$/i, '');
  let s = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[^A-Za-z0-9]+/, '').slice(0, 40);
  if (!s) s = 'model_' + Date.now().toString(36);
  const taken = new Set((assets.models || []).map((m) => String(m).toLowerCase()));
  let out = s + '.glb';
  for (let i = 2; taken.has(out.toLowerCase()); i++) out = s + '_' + i + '.glb';
  return out;
}

async function importFiles(files) {
  const list = Array.from(files || []).filter((f) => /\.glb$/i.test(f.name));
  if (!list.length) { toast('请选择 .glb 模型文件（可多选）', true); return; }
  importing.value = true;
  let ok = 0;
  for (const f of list) {
    try {
      const buf = await f.arrayBuffer();
      const size = await measureBuffer(buf);
      const file = safeGlbName(f.name);
      /* 用归一化后的文件名重新包一个 File 再上传（act.importFile 用 file.name 决定落盘名） */
      await act.importFile(new File([buf], file, { type: 'model/gltf-binary' }));
      const it = act.addCatalogItem(file, size, prettyName(f.name));
      ok += 1;
      if (it && !selId.value) selId.value = it.id;
    } catch (e) {
      toast('导入失败: ' + f.name + ' — ' + e.message, true);
    }
  }
  importing.value = false;
  if (ok) {
    await act.loadModels();
    if (!selId.value && items.value.length) selId.value = items.value[0].id;
    toast(`已导入 ${ok} 个模型，各生成一条家具`);
  }
}

function onFilePick(e) {
  /* FileList 是活引用：先拷贝成数组再清 input.value，否则清空后拿到的就是空列表 */
  const files = Array.from(e.target.files || []);
  e.target.value = '';       // 允许连续选同一批文件
  importFiles(files);
}
function onDrop(e) {
  importing.value || importFiles(e.dataTransfer && e.dataTransfer.files);
}

/* ---------------- 条目操作 ---------------- */
function removeItem(it) {
  if (!it) return;
  act.removeCatalogItem(it.id);
  if (selId.value === it.id) selId.value = items.value.length ? items.value[0].id : '';
  toast('已从清单移除「' + (it.name || it.id) + '」（模型文件仍在项目里）');
}

/* 尺寸只读展示：保留实测精度（最多 3 位），去掉无意义的尾随 0 */
function fmtSize(v) { return String(Number(Number(v || 0).toFixed(3))); }

/* 按模型实测尺寸：重新读一次 GLB 包围盒。这是同步「模型 → 尺寸」的唯一入口，
 * 不是手动调尺寸；同名覆盖上传后点它可让显示值与新模型一致。 */
async function measureSel() {
  const it = sel.value;
  if (!it || !it.model) { toast('这件家具还没指定模型', true); return; }
  try {
    const r = await fetch(modelUrlOf(it.model), { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const size = await measureBuffer(await r.arrayBuffer());
    it.w = size.w; it.d = size.d; it.h = size.h;
    scheduleSave();
    toast('已按模型实测尺寸：' + size.w + ' × ' + size.d + ' × ' + size.h + ' m');
  } catch (e) {
    toast('实测失败: ' + e.message, true);
  }
}

/* 导入过但没被任何家具引用的模型（列表底部提示，避免「模型白传了」） */
const unusedModels = computed(() => {
  const used = new Set(items.value.map((x) => x.model).filter(Boolean));
  return (assets.models || []).filter((m) => !used.has(m));
});

/* ---------------- 导出 / 发布 / 返回 ---------------- */
function back() { act.goHome().catch((e) => toast(e.message, true)); }
function doExport() { act.catalogExport().catch((e) => toast(e.message, true)); }

/* 修复当前家具的 GLB 材质（服务端 fix-materials：过暗 / metallic 偏高 / 压暗扩展），
 * 成功后重载 3D 预览（模型接口是 no-cache，重载拿到的就是修好的文件） */
async function fixSel() {
  const it = sel.value;
  if (!it || !it.model) { toast('先选中一件指定了模型的家具', true); return; }
  try {
    await act.fixMaterial(it.model);
    loadSel();
  } catch (e) { /* act.fixMaterial 内部已 toast */ }
}

const pubAsk = ref(false);
async function doPublish(bump) {
  pubAsk.value = false;
  try { await act.catalogPublish(bump); } catch (e) { toast(e.message, true); }
}
</script>

<template>
  <div id="cat-editor">
    <!-- 顶栏：与插件编辑页同一套视觉，但动作只有家具包的（导入 / 导出 / 发布） -->
    <header id="topbar" class="cat-top">
      <el-button size="small" @click="back">← 项目</el-button>
      <!-- MCP 徽标与插件编辑页同款顺序：放在项目名左侧 -->
      <el-tooltip placement="bottom" :show-after="150">
        <template #content>
          <div style="max-width: 330px; font-size: 12px; line-height: 1.7">
            <b>静态家具编辑页已接入 MCP 能力</b><br>
            AI 可直接读取家具清单与 GLB 解析、读取分类、上传模型并配置属性、全量覆盖属性、批量删模型、导出 / 发布家具包；
            还能点选左侧清单、旋转 / 平移 3D 视图并按机位截图，改动会实时同步到本页面。<br>
            <span style="color: #9aa4b2">studio_list_catalog_items · studio_get_catalog_item · studio_get_catalog_types ·
              studio_set_catalog_item · studio_upload_catalog_model · studio_delete_catalog_items · studio_select_catalog_item ·
              studio_refresh_catalog · studio_get_catalog_selection ·
              studio_view / studio_screenshot（公共） · studio_export_catalog · studio_publish_catalog</span>
          </div>
        </template>
        <span class="mcp-badge">MCP 已接入</span>
      </el-tooltip>
      <ProjectTitle :name="S.proj ? S.proj.name : ''" :id="S.proj ? S.proj.id : ''" />
      <span class="cat-badge">家具包 · {{ items.length }} 件</span>
      <div class="spacer"></div>
      <div class="topbar-right">
        <span class="save-state">{{ S.saveState }}</span>
        <el-button size="small" :disabled="S.publishing" @click="doExport">导出家具包</el-button>
        <el-button size="small" type="primary" :disabled="S.publishing || !items.length" @click="pubAsk = true">
          {{ S.publishing ? '发布中…' : '发布到 ha-3d-home' }}
        </el-button>
      </div>
    </header>

    <div class="cat-body">
      <!-- 左：家具清单 -->
      <aside class="cat-list" @dragover.prevent @drop.prevent="onDrop">
        <div class="list-head">
          家具清单
          <span class="list-count">{{ items.length }}</span>
        </div>

        <div class="cat-items">
          <div v-for="it in items" :key="it.id" class="cat-item" :class="{ on: it.id === selId }" @click="selId = it.id">
            <div class="ci-main">
              <div class="ci-name">{{ it.name || '(未命名)' }}</div>
              <div class="ci-meta">
                <span class="ci-tag">{{ typeName(it.type) }}</span>
                <span>{{ it.w }} × {{ it.d }} × {{ it.h }} m</span>
              </div>
              <div class="ci-file">{{ it.model || '未指定模型' }}</div>
            </div>
            <button type="button" class="ci-del" title="从清单移除（模型文件保留在项目里）" @click.stop="removeItem(it)">×</button>
          </div>

          <div v-if="!items.length" class="list-empty">
            还没有家具<br>
            <span>点下方按钮或把 .glb 拖进来，一次可导入多个</span>
          </div>
        </div>

        <div class="list-foot">
          <el-button size="small" style="width: 100%" :loading="importing" @click="pickFiles">
            + 导入 GLB 模型（可多选 / 可拖入）
          </el-button>
          <p v-if="unusedModels.length" class="list-warn">
            有 {{ unusedModels.length }} 个模型还没被任何家具引用：{{ unusedModels.join('、') }}
          </p>
          <p class="mcp-note">静态家具编辑页已接入 MCP：AI 可读取清单与模型解析、上传 GLB、覆盖属性、批量删模型、点选清单、旋转 / 平移视图并截图、导出 / 发布家具包。</p>
        </div>
        <input ref="fileInput" type="file" accept=".glb,model/gltf-binary" multiple style="display: none" @change="onFilePick">
      </aside>

      <!-- 中：3D 预览 -->
      <section class="cat-stage">
        <div ref="hostEl" class="cat-canvas"></div>
        <div class="stage-tools">
          <button type="button" @click="view('iso')">等轴</button>
          <button type="button" @click="view('front')">正视</button>
          <button type="button" @click="view('top')">俯视</button>
          <button type="button" :class="{ on: grid }" @click="toggleGrid">网格</button>
          <button type="button" @click="fit">适配</button>
        </div>
        <!-- 右上角：修复当前预览模型的材质（显黑 / metallic 偏高 / 压暗扩展），原地改写 GLB -->
        <button type="button" class="stage-fix" :disabled="S.fixing || !sel || !sel.model"
                :title="sel && sel.model ? '修复「' + (sel.name || sel.model) + '」的材质显黑问题' : '先选中一件家具'"
                @click="fixSel">{{ S.fixing ? '修复中…' : '修复材质' }}</button>
        <div v-if="loading" class="stage-tag">加载模型…</div>
        <div v-else-if="loadErr" class="stage-tag bad">{{ loadErr }}</div>
        <div v-else-if="!sel" class="stage-tag">左侧选中一件家具预览</div>
        <div v-else class="stage-name">{{ sel.name || sel.id }}</div>
      </section>

      <!-- 右：当前家具属性 -->
      <aside class="cat-props">
        <template v-if="sel">
          <h3>家具属性</h3>

          <label class="row">名称
            <el-input v-model="sel.name" size="small" maxlength="40" @change="scheduleSave()" />
          </label>

          <label class="row">分类
            <el-select v-model="sel.type" size="small" style="width: 100%" @change="scheduleSave()">
              <el-option v-for="t in types" :key="t.type" :label="t.name + '（' + t.type + '）'" :value="t.type" />
            </el-select>
          </label>
          <p class="hint">分类决定它在 home 家具库进哪个页签；选项来自 home 的 /api/catalog{{ assets.catalogTypesSource === 'home' ? '（已连接）' : '（未连上，用本地兜底表）' }}</p>

          <div class="size-head">
            <span>尺寸（米）</span>
            <button type="button" class="mini" title="重新读取 GLB 包围盒，把尺寸同步为模型实测值" @click="measureSel">按模型实测</button>
          </div>
          <div class="size-grid">
            <label>宽 W<span class="size-val">{{ fmtSize(sel.w) }}</span></label>
            <label>深 D<span class="size-val">{{ fmtSize(sel.d) }}</span></label>
            <label>高 H<span class="size-val">{{ fmtSize(sel.h) }}</span></label>
          </div>
          <p class="hint">尺寸来自模型实测，只读、不能手动调；实际大小到 ha-3d-home 里用「整体比例缩放」调整。W / D 决定 2D 平面图的占位，H 用于 3D 摆放参考。覆盖上传模型后可点「按模型实测」同步。</p>

          <label class="row">兜底色
            <el-color-picker v-model="sel.color" size="small" @change="scheduleSave()" />
            <span class="color-val">{{ sel.color }}</span>
          </label>

          <label class="row">模型文件
            <span class="file-val">{{ sel.model || '(未指定)' }}</span>
          </label>

          <label class="row">条目 id
            <span class="file-val">{{ sel.id }}</span>
          </label>
          <p class="hint">发布后 home 里的条目 id 是 <code>{{ S.proj.id }}:{{ sel.id }}</code>，与其他家具包互不冲突</p>

          <div class="prop-foot">
            <el-button size="small" type="danger" plain @click="removeItem(sel)">从清单移除</el-button>
          </div>
        </template>

        <template v-else>
          <h3>家具属性</h3>
          <p class="hint">左侧选中一件家具后在这里改名称 / 分类 / 兜底色；导入 GLB 会自动生成一条并按模型实测填好尺寸（尺寸只读）。</p>
        </template>
      </aside>
    </div>

    <!-- 发布确认：家具包整包替换，同 id 覆盖升级 -->
    <transition name="big-fade">
      <div v-if="pubAsk" class="modal-mask" @click.self="pubAsk = false">
        <div class="pub-modal">
          <button class="pub-close" aria-label="关闭" @click="pubAsk = false">
            <svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
          </button>
          <div class="pub-title">发布家具包到 ha-3d-home</div>
          <p class="pub-sub">共 {{ items.length }} 件家具。同一个项目重复发布会整体覆盖安装目录 <code>custom/models/{{ S.proj.id }}</code>。</p>
          <div class="pub-opts">
            <button type="button" class="pub-opt on" @click="doPublish(true)">
              <b>升版本并发布</b>
              <span>版本号 +1，包里带新版本，方便确认装的是哪一版</span>
            </button>
            <button type="button" class="pub-opt" @click="doPublish(false)">
              <b>不升版本直接发布</b>
              <span>版本号不变，只覆盖安装目录里的文件</span>
            </button>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
#cat-editor { height: 100%; display: flex; flex-direction: column; background: var(--bg); }
/* 复用插件页的 #topbar 视觉；那套样式带 min-width:1140（给三栏定宽用），
   家具页三栏自适应，用 id+class 提权把它压回 0 */
#cat-editor .cat-top { min-width: 0; }
.cat-badge {
  font-size: 11px; color: var(--accent); background: rgba(47,127,224,.1);
  border: 1px solid rgba(47,127,224,.25); border-radius: 999px; padding: 2px 10px; white-space: nowrap;
}
/* .mcp-badge 的样式放在全局 style.css（插件编辑页顶栏也要用），这里只放家具页独有的说明行 */
.list-foot .mcp-note {
  margin: 8px 2px 0; font-size: 10.5px; line-height: 1.6; color: var(--fg-dim);
  border-top: 1px dashed var(--line); padding-top: 6px;
}

.cat-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 268px 1fr 288px; }

/* ---- 左：清单 ---- */
.cat-list { display: flex; flex-direction: column; min-height: 0; background: var(--bg2); border-right: 1px solid var(--line); }
.list-head { display: flex; align-items: center; gap: 6px; padding: 10px 12px; font-weight: 600; font-size: 12.5px; border-bottom: 1px solid var(--line); }
.list-count { font-size: 11px; font-weight: 400; color: var(--fg-dim); background: var(--bg3); border-radius: 999px; padding: 0 7px; }
.cat-items { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.cat-item {
  position: relative; display: flex; gap: 6px; padding: 8px 9px; border-radius: 9px; cursor: pointer;
  background: var(--bg2); border: 1px solid var(--line); transition: border-color .15s, background .15s;
}
.cat-item:hover { border-color: var(--accent); background: #f8fbff; }
.cat-item.on { border-color: var(--accent); background: rgba(47,127,224,.07); }
.ci-main { flex: 1; min-width: 0; }
.ci-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ci-meta { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--fg-dim); margin-top: 3px; }
.ci-tag { background: var(--bg3); border-radius: 5px; padding: 0 5px; }
.ci-file { font-size: 10.5px; color: #9aa3b2; font-family: ui-monospace, Menlo, monospace; margin-top: 2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ci-del {
  align-self: flex-start; width: 20px; height: 20px; line-height: 1; border-radius: 5px; cursor: pointer;
  border: 1px solid transparent; background: transparent; color: #b3bbc8; font-size: 15px;
}
.ci-del:hover { color: var(--danger); border-color: #eec2c2; background: #fff5f5; }
.list-empty { text-align: center; color: var(--fg-dim); font-size: 12px; padding: 26px 8px; line-height: 1.7; }
.list-empty span { font-size: 11px; color: #9aa3b2; }
.list-foot { padding: 8px; border-top: 1px solid var(--line); }
.list-warn { font-size: 11px; color: var(--warn); margin-top: 6px; line-height: 1.5; }

/* ---- 中：3D ---- */
.cat-stage { position: relative; min-width: 0; background: #eef1f5; }
.cat-canvas { position: absolute; inset: 0; }
.stage-tools {
  position: absolute; left: 10px; top: 10px; z-index: 2; display: flex; gap: 4px;
  background: rgba(255,255,255,.9); border: 1px solid var(--line); border-radius: 8px; padding: 4px;
}
.stage-tools button {
  border: 1px solid transparent; background: transparent; color: var(--fg-dim); font: inherit;
  font-size: 11.5px; padding: 2px 8px; border-radius: 6px; cursor: pointer;
}
.stage-tools button:hover { border-color: var(--line); color: var(--fg); background: var(--bg2); }
.stage-tools button.on { color: var(--accent); border-color: rgba(47,127,224,.35); background: rgba(47,127,224,.08); }
/* 右上角修复材质按钮：与左上角视图工具同款观感 */
.stage-fix {
  position: absolute; right: 10px; top: 10px; z-index: 2; font: inherit; cursor: pointer;
  border: 1px solid var(--line); background: rgba(255,255,255,.9); color: var(--fg-dim);
  font-size: 11.5px; padding: 3px 10px; border-radius: 8px; transition: all .15s;
}
.stage-fix:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); background: #f6faff; }
.stage-fix:disabled { opacity: .5; cursor: not-allowed; }
.stage-tag {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 2;
  background: rgba(255,255,255,.92); border: 1px solid var(--line); border-radius: 8px;
  padding: 6px 14px; font-size: 12px; color: var(--fg-dim); pointer-events: none;
}
.stage-tag.bad { color: var(--danger); border-color: #e0a2a2; }
.stage-name {
  position: absolute; right: 12px; bottom: 12px; z-index: 2; font-size: 11.5px; color: var(--fg);
  background: rgba(255,255,255,.9); border: 1px solid var(--line); border-radius: 999px; padding: 2px 12px;
}

/* ---- 右：属性 ---- */
.cat-props { background: var(--bg2); border-left: 1px solid var(--line); padding: 12px; overflow-y: auto; }
.cat-props h3 { font-size: 12.5px; font-weight: 700; margin-bottom: 10px; }
.row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-size: 12px; color: var(--fg-dim); }
.row > :first-child { flex: 0 0 54px; }
.row .el-input, .row .el-select { flex: 1; }
.color-val { font-size: 11px; font-family: ui-monospace, Menlo, monospace; }
.file-val { font-size: 11px; color: var(--fg); font-family: ui-monospace, Menlo, monospace; word-break: break-all; }
.size-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--fg-dim); margin: 4px 0 6px; }
.mini {
  border: 1px solid var(--line); background: var(--bg2); color: var(--accent); font: inherit;
  font-size: 11px; border-radius: 6px; padding: 2px 8px; cursor: pointer;
}
.mini:hover { border-color: var(--accent); background: #f6faff; }
.size-grid { display: grid; grid-template-columns: 1fr; gap: 6px; margin-bottom: 4px; }
.size-grid label { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--fg-dim); }
/* 只读尺寸值：像输入框但不可编辑，明确区分于可改字段 */
.size-val {
  flex: 1; text-align: right; font-size: 12px; color: var(--fg);
  font-family: ui-monospace, Menlo, monospace; font-variant-numeric: tabular-nums;
  background: var(--bg3); border: 1px solid var(--line); border-radius: 4px;
  padding: 4px 8px; cursor: default; user-select: text;
}
.prop-foot { margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--line); }
code { font-family: ui-monospace, Menlo, monospace; background: var(--bg3); border-radius: 4px; padding: 0 4px; }
.pub-sub { font-size: 12px; color: var(--fg-dim); margin-bottom: 12px; line-height: 1.7; }
</style>
