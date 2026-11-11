<script setup>
/* 启动页: 项目列表 —— 卡片 = 渲染预览图 + 信息区（项目名 / id / 更新时间 / 操作）
 * 预览图来自 data/projects/<id>/preview.png（编辑页每次渲染成功后自动落盘，
 * 代码为空 / 报错时落盘的是白底+网格 俯视45° 占位图）；从没打开过的项目
 * 没有 preview.png（404）→ 用 CSS 画一个同款白底网格占位。 */
import { ref, reactive, onMounted, onBeforeUnmount } from 'vue';
import { ElMessage } from 'element-plus';
import { Plus, Setting, Upload } from '@element-plus/icons-vue';
import { useStudio } from '../stores';
const { act, project, ui } = useStudio();

/* ---- 新建项目（虚线卡片 → 弹窗：先选类型 kind，再填名称） ----
 * kind 在建项目时定死，之后不可改 —— 两类的数据结构与编辑页完全不同：
 *   device    设备类（含门/窗）→ 插件编辑页（样式 / 字段 / 代码 / 3D 调试）
 *   background 背景（户外地面等）→ 同上
 *   catalog   家具包（一个项目多个 GLB）→ 家具编辑页（清单 + 预览 + 发布整包） */
const createVisible = ref(false);
const newName = ref('');
const newKind = ref('device');
const advancedOpen = ref(false);   // 新建弹窗里的「高级用法」说明，默认收起
const SKILL_REPO = 'https://gitee.com/sunhuip/ha3d-skill';
const CREATE_KINDS = [
  { kind: 'device', title: '设备插件', desc: '灯 / 开关 / 空调 / 门 / 窗…，带实体绑定与样式参数' },
  { kind: 'background', title: '背景插件', desc: '户外地面、庭院铺装等铺在户型外围的 3D 背景' },
  { kind: 'catalog', title: '家具包', desc: '一次导入多个 GLB，每件家具一条描述，整包发布到 home' },
];
function openCreate() {
  newName.value = '';
  newKind.value = 'device';
  advancedOpen.value = false;
  createVisible.value = true;
}
async function doCreate() {
  const name = newName.value.trim();
  if (!name) { ElMessage.warning('请输入项目名称'); return; }
  try { await act.newProject(name, newKind.value); createVisible.value = false; newName.value = ''; }
  catch (e) { ElMessage.error(e.message); }
}

/* ---- 卡片操作: 重命名 / 复制 / 删除（信息区里的按钮触发） ---- */
const renameVisible = ref(false);
const renameName = ref('');
let renameId = '';
const delVisible = ref(false);
const delConfirmText = ref('');
const delConfirmInput = ref('');
let delTarget = null;

/* ---- 导入项目：选「导出项目」生成的备份 zip → 还原成一个新项目 ---- */
const importInput = ref(null);
function importClick() { importInput.value && importInput.value.click(); }
async function onImportFile(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';   // 允许连续选同一个文件
  if (!file) return;
  try { await act.importProject(file); }
  catch (e) { ElMessage.error(e.message); }
}

function onCommand(cmd, p) {
  if (cmd === 'rename') {
    renameId = p.id; renameName.value = p.name; renameVisible.value = true;
  } else if (cmd === 'copy') {
    act.copyProject(p.id, p.name + ' 副本')
      .then(() => ElMessage.success('已复制为「' + p.name + ' 副本」'))
      .catch((e) => ElMessage.error(e.message));
  } else if (cmd === 'delete') {
    delTarget = p; delConfirmText.value = '确定'; delConfirmInput.value = ''; delVisible.value = true;
  }
}
async function doRename() {
  const name = renameName.value.trim();
  if (!name) { ElMessage.warning('名称不能为空'); return; }
  try { await act.renameProject(renameId, name); renameVisible.value = false; ElMessage.success('已重命名'); }
  catch (e) { ElMessage.error(e.message); }
}
async function doDelete() {
  if (delConfirmInput.value.trim() !== delConfirmText.value) { ElMessage.warning('请输入「' + delConfirmText.value + '」才会执行删除'); return; }
  try {
    await act.deleteProject(delTarget.id);
    delVisible.value = false;
    ElMessage.success('已删除「' + delTarget.name + '」');
  } catch (e) { ElMessage.error('删除失败: ' + e.message); }
}

/* ---- 卡片预览图 ---- */
const pvMissing = reactive({});        // projId → true（preview.png 404，用 CSS 占位）
function pvUrl(p) {
  return `/api/projects/${p.id}/preview.png?t=${encodeURIComponent(p.updatedAt || '')}`;
}

/* ---- 滚动收缩标题区：项目多往上滑时收紧字号/间距（CSS 过渡动画），回顶恢复 ---- */
const compact = ref(false);
function onScroll(e) {
  compact.value = e.target.scrollTop > 48;
}

/* ---- 鼠标跟随的蓝色网格特效 ----
 * 常驻 canvas 画满蓝色网格，再用以鼠标为中心的径向渐变蒙版（destination-in）
 * 做距离衰减：离鼠标越远透明度越低；鼠标位置每帧缓动跟随，有轻微拖尾感 */
const gridCv = ref(null);
const mouse = { x: -9999, y: -9999 };    // 目标位置
const cur = { x: -9999, y: -9999 };      // 缓动后的当前位置
let fxRaf = 0;

function drawGridFx() {
  const cv = gridCv.value;
  if (!cv) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  cur.x += (mouse.x - cur.x) * 0.12;
  cur.y += (mouse.y - cur.y) * 0.12;

  const gap = 34;
  ctx.strokeStyle = 'rgba(47,127,224,0.9)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = gap; x < w; x += gap) { ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, h); }
  for (let y = gap; y < h; y += gap) { ctx.moveTo(0, y + .5); ctx.lineTo(w, y + .5); }
  ctx.stroke();

  /* 径向蒙版：中心不透明 → 260px 外全透明 */
  const g = ctx.createRadialGradient(cur.x, cur.y, 0, cur.x, cur.y, 260);
  g.addColorStop(0, 'rgba(0,0,0,0.85)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
}
function loopFx() { drawGridFx(); fxRaf = requestAnimationFrame(loopFx); }
function onMove(e) {
  const rect = gridCv.value ? gridCv.value.getBoundingClientRect() : { left: 0, top: 0 };
  mouse.x = e.clientX - rect.left;
  mouse.y = e.clientY - rect.top;
  if (cur.x < -999) { cur.x = mouse.x; cur.y = mouse.y; }   // 首次进入不做长距离拖尾
}
function onLeave() { mouse.x = -9999; mouse.y = -9999; }
onMounted(loopFx);
onBeforeUnmount(() => cancelAnimationFrame(fxRaf));

/* ---- 右下角悬浮设置: ha-3d-home 远程安装目标（主机地址 + 密钥） ---- */
const settingVisible = ref(false);
const hostInput = ref('');
const keyInput = ref('');
function openSetting() {
  hostInput.value = project.target ? project.target.host : '';
  keyInput.value = project.target ? project.target.key : '';
  settingVisible.value = true;
}
async function doSaveTarget() {
  try {
    await act.saveTarget({ host: hostInput.value.trim(), key: keyInput.value.trim() });
    settingVisible.value = false;
  }
  catch (e) { ElMessage.error(e.message); }
}

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch (e) { return iso || ''; }
}

/* ---- 卡片角标文案：设备类（device 含门/窗）、背景、家具包 ----
 * 门/窗已并入设备类（kind:'device' + type 'door'/'window'）：设备 · 门 / 设备 · 窗；
 * 家具包显示件数（catalog.items 数量，服务端列表接口一并返回） */
const KIND_NAMES = { device: '设备', background: '背景', catalog: '家具包' };
const TYPE_NAMES = {
  light: '灯', switch: '开关', fan: '风扇', cover: '窗帘', climate: '空调',
  water_heater: '热水器', media_player: '音箱', vacuum: '扫地机', camera: '摄像头',
  sensor: '传感器', other: '设备',
  door: '门', window: '窗',
};
function kindLabel(p) {
  if (p.kind === 'catalog') return '家具包 · ' + (p.items || 0) + ' 件';
  const kind = KIND_NAMES[p.kind] || p.kind;
  const type = TYPE_NAMES[p.type] || p.type;
  return (p.kind === 'background' || !type) ? kind : `${kind} · ${type}`;
}
</script>

<template>
  <div id="home" @mousemove="onMove" @mouseleave="onLeave">
    <canvas ref="gridCv" class="grid-fx"></canvas>
    <main id="home-body" @scroll="onScroll">
      <div class="home-inner" :class="{ compact }">
        <!-- 品牌标题居中 -->
        <h1 class="brand-title">🔌 ha3d-plugin-studio</h1>
        <p class="sub">ha-3d-home 插件可视化生成器 · GLB 组装 + AI 逻辑</p>

        <div class="cards">
          <!-- 项目卡片: 渲染图 + 信息区（名称 / id / 更新时间 / 操作） -->
          <div v-for="p in project.projects" :key="p.id" class="card" @click="act.openProject(p.id)">
            <!-- 渲染的模型（编辑页落盘的快照；没打开过 → 白底网格占位） -->
            <div class="card-view">
              <img v-if="!pvMissing[p.id]" :src="pvUrl(p)" alt="" @error="pvMissing[p.id] = true">
              <div v-else class="view-fallback"></div>
              <!-- 插件类型角标：设备（含门/窗细分）/ 背景，与「只有两类插件」的口径一致 -->
              <span v-if="p.kind" class="kind-badge">{{ kindLabel(p) }}</span>
            </div>

            <!-- 信息区（常驻：名称 / id / 更新时间 / 操作） -->
            <div class="card-foot" @click.stop>
              <div class="card-detail">
                <div class="d-name">{{ p.name }}</div>
                <div class="d-meta">
                  <span class="d-id">{{ p.id }}</span>
                  <span>{{ fmtTime(p.updatedAt) }}</span>
                </div>
                <div class="d-ops">
                  <button type="button" @click="onCommand('rename', p)">重命名</button>
                  <button type="button" @click="onCommand('copy', p)">复制</button>
                  <button type="button" class="op-danger" @click="onCommand('delete', p)">删除</button>
                </div>
              </div>
            </div>
          </div>

          <!-- 新建项目: 矩形虚线框中间一个 + 号 -->
          <div class="card card-new" @click="openCreate">
            <el-icon class="new-plus"><Plus /></el-icon>
            <div class="new-text">新建项目</div>
          </div>
        </div>

        <div v-if="!project.projects.length" class="empty hint">
          还没有项目，点击上方虚线框新建一个
        </div>
      </div>
    </main>

    <!-- 右下角悬浮按钮组：导入项目（设置上方） -->
    <div class="fab fab-import" title="导入项目：选择「导出项目」生成的备份 zip，还原成一个新项目" @click="importClick">
      <el-icon :size="22"><Upload /></el-icon>
    </div>
    <input ref="importInput" type="file" accept=".zip,application/zip" style="display: none" @change="onImportFile">

    <!-- 右下角悬浮设置按钮（远程安装目标） -->
    <div class="fab" @click="openSetting" title="设置（发布目标）">
      <el-icon :size="22"><Setting /></el-icon>
    </div>

    <!-- 新建项目弹窗：先选类型（创建后不可改），再填名称 -->
    <el-dialog v-model="createVisible" title="新建项目" width="520px">
      <div class="kind-pick">
        <button v-for="k in CREATE_KINDS" :key="k.kind" type="button" class="kind-opt"
                :class="{ on: newKind === k.kind }" @click="newKind = k.kind">
          <b>{{ k.title }}</b>
          <span>{{ k.desc }}</span>
        </button>
      </div>
      <p class="hint" style="margin: 8px 0 10px">项目类型创建后不可更改：插件类（设备 / 背景）与家具包的编辑页、产物完全不同</p>

      <!-- 高级用法：默认收起，展开后按三类项目分组说明玩法与 AI 提示词建议 -->
      <div class="advanced" :class="{ open: advancedOpen }">
        <button type="button" class="adv-toggle" :aria-expanded="advancedOpen" @click="advancedOpen = !advancedOpen">
          <span class="adv-tag">高级用法</span>
          <span class="adv-title">三类项目，不止于名字本身</span>
          <span class="adv-more">{{ advancedOpen ? '收起' : '展开查看' }}</span>
          <span class="adv-arrow" :class="{ up: advancedOpen }">⌄</span>
        </button>
        <div v-if="advancedOpen" class="adv-body">
          <p class="adv-lead">类型只决定数据结构，不决定玩法。大胆组合、自由发挥就好。</p>

          <div class="adv-row">
            <span class="adv-k k-catalog">家具包</span>
            <p><b>全静态的家具集合</b>：造型固定、不需要交互调节，一次导入多个 GLB，整包发布到 home。</p>
          </div>
          <div class="adv-row">
            <span class="adv-k k-bg">背景插件</span>
            <p><b>房屋之外的整个世界</b>：地面、天空，以及云朵、下雨、太阳、小鸟等环境与氛围，都交给它，支持动态效果。</p>
          </div>
          <div class="adv-row">
            <span class="adv-k k-dev">设备类插件</span>
            <p><b>最灵活的一类</b>：既能写灯、开关、空调等各式家电，也能做「带调节参数的静态设备」，把静态设备当家具用 —— 长宽高可调的衣柜、单开门 / 多开门可切换的柜体等。</p>
          </div>

          <div class="adv-tip">
            <b>用 AI Agent 开发时</b>：提示词尽量写完整 —— 项目类型、造型结构、尺寸、材质配色、需要哪些可调参数、期望视角；<b>有参考图最好一起提供</b>，还原度会明显更高。
          </div>
          <p class="adv-link">配套 Skill 技能：<a :href="SKILL_REPO" target="_blank" rel="noopener noreferrer">{{ SKILL_REPO }}</a></p>
        </div>
      </div>

      <el-input v-model="newName" placeholder="项目名称，如：卧室吊灯 / 客厅家具套装" @keydown.enter="doCreate" autofocus />
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" @click="doCreate">创建</el-button>
      </template>
    </el-dialog>

    <!-- 重命名弹窗 -->
    <el-dialog v-model="renameVisible" title="重命名项目" width="420px">
      <el-input v-model="renameName" @keydown.enter="doRename" />
      <template #footer>
        <el-button @click="renameVisible = false">取消</el-button>
        <el-button type="primary" @click="doRename">保存</el-button>
      </template>
    </el-dialog>

    <!-- 删除确认弹窗（需输入"确定"才真删） -->
    <el-dialog v-model="delVisible" title="删除项目" width="440px">
      <p style="margin-bottom: 10px">
        即将删除项目 <b>「{{ delTarget && delTarget.name }}」</b>（含其全部 GLB 文件，<span style="color:#d9534f">不可恢复</span>）。
      </p>
      <p class="hint" style="margin-bottom: 8px">请输入 <b style="color:#d9534f">{{ delConfirmText }}</b> 以确认：</p>
      <el-input v-model="delConfirmInput" placeholder="" @keydown.enter="doDelete" />
      <template #footer>
        <el-button @click="delVisible = false">取消</el-button>
        <el-button type="danger" :disabled="delConfirmInput.trim() !== delConfirmText" @click="doDelete">确认删除</el-button>
      </template>
    </el-dialog>

    <!-- 设置弹窗（ha-3d-home 远程安装目标） -->
    <el-dialog v-model="settingVisible" title="设置" width="560px">
      <el-tabs>
        <el-tab-pane label="发布目标">
          <el-input v-model="hostInput" placeholder="ha-3d-home 主机地址，如 http://192.168.1.10:8099" class="tgt-input">
            <template #prepend>主机地址</template>
          </el-input>
          <el-input v-model="keyInput" placeholder="安装密钥（ha-3d-home 设置的安装口令）" style="margin-top: 12px" show-password class="tgt-input">
            <template #prepend>密钥</template>
          </el-input>
          <p class="hint" style="margin-top: 8px">
            当前: {{ project.target ? project.target.host : '加载中…' }}。<br>
            发布插件时会把 plugin.json / plugin.js / models 打包成 zip，调用 ha-3d-home 的安装接口远程安装到该主机（需 ha-3d-home 侧提供安装接口）。
          </p>
        </el-tab-pane>
      </el-tabs>
      <template #footer>
        <el-button @click="settingVisible = false">取消</el-button>
        <el-button type="primary" @click="doSaveTarget">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
#home { position: relative; height: 100%; display: flex; flex-direction: column; background:
  radial-gradient(1200px 500px at 70% -10%, #e8f1fc 0%, transparent 60%), var(--bg); }

/* 鼠标跟随的蓝色网格特效层：垫在内容下面，pointer-events 放行给页面 */
.grid-fx { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 0; }

#home-body { position: relative; z-index: 1; flex: 1; overflow-y: auto; display: flex; justify-content: center; }
.home-inner { width: min(1080px, 92vw); padding: 64px 0 80px;
  transition: padding .35s ease; }
/* 滚动后的紧凑态：整体收紧 */
.home-inner.compact { padding: 24px 0 64px; }
.brand-title { text-align: center; font-size: 44px; font-weight: 800; letter-spacing: .01em;
  margin-bottom: 20px; line-height: 1.15;
  background: linear-gradient(100deg, #1f2d3d 0%, #2f7fe0 45%, #7c4dd4 80%);
  -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  transition: font-size .35s ease, margin-bottom .35s ease; }
.home-inner.compact .brand-title { font-size: 26px; margin-bottom: 8px; }
.sub { text-align: center; color: var(--fg-dim); font-size: 16px; letter-spacing: .06em; margin-bottom: 46px;
  transition: font-size .35s ease, margin-bottom .35s ease; }
.home-inner.compact .sub { font-size: 12px; margin-bottom: 26px; }

.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 16px; }
.card { position: relative; display: flex; flex-direction: column; gap: 9px;
  background: var(--bg2); border: 1px solid var(--line); border-radius: 14px; padding: 12px;
  cursor: pointer; transition: box-shadow .15s, border-color .15s, transform .15s; }
.card:hover { border-color: var(--accent); box-shadow: 0 8px 24px rgba(47,127,224,.12); transform: translateY(-2px); }

/* 渲染预览图（编辑页落盘的快照；白底网格占位同款观感） */
.card-view { position: relative; height: 168px; border-radius: 10px; overflow: hidden;
  background: #fff; border: 1px solid var(--line); }
.card-view img { display: block; width: 100%; height: 100%; object-fit: cover; }
/* 没落盘过 preview.png 的项目（从没在编辑页打开过）：白底 + 网格占位（与空插件快照同款观感） */
.view-fallback { position: absolute; inset: 0; background-color: #fff;
  background-image: linear-gradient(#edf1f7 1px, transparent 1px), linear-gradient(90deg, #edf1f7 1px, transparent 1px);
  background-size: 22px 22px; background-position: center; }
/* 右上角插件类型角标：半透明白底玻璃感，不遮挡预览主体 */
.kind-badge { position: absolute; top: 8px; right: 8px; z-index: 1;
  padding: 3px 10px; border-radius: 999px; font-size: 11px; line-height: 1.4; color: var(--fg);
  background: rgba(255,255,255,.82); border: 1px solid var(--line);
  backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); pointer-events: none; }

/* 信息区（常驻详情：名称 / id / 更新时间 / 操作） */
.card-foot { display: flex; flex-direction: column; }
.card-detail { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 9px 11px; }
.d-name { font-weight: 600; font-size: 14px; margin-bottom: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.d-meta { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--fg-dim); font-size: 11px; margin-bottom: 8px; }
.d-id { font-family: ui-monospace, Menlo, monospace; }
.d-ops { display: flex; gap: 6px; }
.d-ops button { border: 1px solid var(--line); background: var(--bg2); color: var(--fg);
  border-radius: 7px; padding: 3px 12px; font-size: 12px; cursor: pointer; transition: all .15s; }
.d-ops button:hover { border-color: var(--accent); color: var(--accent); }
.d-ops .op-danger:hover { border-color: var(--danger); color: var(--danger); }

/* 新建: 矩形虚线框 + 中间 + 号 */
.card-new { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 300px; border: 2px dashed #b8c4d4; background: transparent; box-shadow: none; }
.card-new:hover { border-color: var(--accent); background: #f6faff; }
.new-plus { font-size: 34px; color: #8fa3bd; margin-bottom: 6px; }
.card-new:hover .new-plus { color: var(--accent); }
.new-text { color: var(--fg-dim); font-size: 13px; }

/* 右下角悬浮设置按钮 */
.fab { position: fixed; right: 26px; bottom: 26px; width: 52px; height: 52px; border-radius: 50%; background: var(--bg2); border: 1px solid var(--line); box-shadow: 0 6px 20px rgba(30,40,60,.18); display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--fg-dim); transition: all .15s; z-index: 20; }
.fab:hover { color: var(--accent); border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 10px 26px rgba(47,127,224,.22); }
/* 导入项目按钮：设置按钮正上方 */
.fab-import { bottom: 92px; }

.empty { text-align: center; padding: 30px 0; }
</style>

<!-- 设置弹窗挂在 body 下（el-dialog 传送门），scoped 够不到，单独全局样式 -->
<style>
.tgt-input .el-input-group__prepend { width: 84px; justify-content: center; }

/* 新建项目弹窗里的类型选择（el-dialog 传送门同样需要全局样式） */
.kind-pick { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 4px; }
.kind-opt {
  display: flex; flex-direction: column; gap: 4px; text-align: left; cursor: pointer;
  font: inherit; padding: 10px 11px; border-radius: 10px; background: var(--bg2);
  border: 1px solid var(--line); color: var(--fg); transition: border-color .15s, background .15s, box-shadow .15s;
}
.kind-opt b { font-size: 13px; }
.kind-opt span { font-size: 11px; color: var(--fg-dim); line-height: 1.45; }
.kind-opt:hover { border-color: var(--accent); background: #f6faff; }
.kind-opt.on { border-color: var(--accent); background: rgba(47,127,224,.08); box-shadow: 0 0 0 1px var(--accent) inset; }
.kind-opt.on b { color: var(--accent); }

/* 新建项目弹窗里的「高级用法」说明（默认收起，展开后完整平铺、不做内部滚动） */
.advanced { margin: 0 0 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg2); overflow: hidden; }
.adv-toggle {
  width: 100%; display: flex; align-items: center; gap: 8px; padding: 9px 11px;
  border: 0; background: transparent; cursor: pointer; font: inherit; color: var(--fg); text-align: left;
}
.adv-toggle:hover { background: #f6faff; }
.adv-tag { flex: none; padding: 2px 7px; border-radius: 5px; background: rgba(47,127,224,.12); color: var(--accent); font-size: 11px; font-weight: 600; }
.adv-title { flex: 1; font-size: 12px; color: var(--fg-dim); }
.adv-more { flex: none; font-size: 11px; color: var(--accent); }
.adv-arrow { flex: none; display: inline-block; font-size: 15px; line-height: 1; color: var(--fg-dim); transition: transform .18s; }
.adv-arrow.up { transform: rotate(180deg); }
.adv-body { padding: 0 12px 12px; border-top: 1px solid var(--line); }
.adv-lead { margin: 10px 0 12px; font-size: 12px; line-height: 1.6; color: var(--fg-dim); }
.adv-row { display: flex; align-items: flex-start; gap: 9px; margin-bottom: 9px; }
.adv-k { flex: 0 0 68px; padding: 3px 0; border-radius: 5px; text-align: center; font-size: 11px; font-weight: 600; }
.adv-k.k-catalog { background: rgba(126, 87, 194, .11); color: #7452bd; }
.adv-k.k-bg { background: rgba(47, 127, 224, .11); color: #2f7fe0; }
.adv-k.k-dev { background: rgba(214, 133, 36, .13); color: #b87414; }
.adv-row p { margin: 0; font-size: 12px; line-height: 1.65; color: var(--fg); }
.adv-row p b { font-weight: 600; }
.adv-tip { margin: 12px 0 9px; padding: 9px 10px; border-radius: 8px; background: #f4f8ff; border: 1px solid rgba(47,127,224,.16); font-size: 12px; line-height: 1.7; color: var(--fg); }
.adv-tip b { color: var(--accent); }
.adv-link { margin: 0; font-size: 12px; color: var(--fg-dim); }
.adv-link a { color: var(--accent); text-decoration: none; word-break: break-all; }
.adv-link a:hover { text-decoration: underline; }
</style>
