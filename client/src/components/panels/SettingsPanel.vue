<script setup>
/* 面板：插件设置（plugin id/名称/kind/type/ftype/版本/锚点 z/说明/图标 + 发布目标）
 * 这里只服务插件项目：kind:'device'（设备 **含门/窗/家具**）与 kind:'background'。
 * 门/窗 = type:'door'/'window' 的贴墙设备、家具 = type:'furniture' 的动态家具，都不是独立 kind；
 * 家具项目（kind:'catalog'）走独立的家具编辑页（components/CatalogEditor.vue）。
 * kind 在新建项目时确定，本面板只读展示。 */
import { computed, watch } from 'vue';
import { useStudio } from '../../stores';
const { S, scheduleSave, MODEL_TYPES, isWallType, isFurnType, assets, ui } = useStudio();

const typeOptions = computed(() => {
  const k = S.proj?.plugin.kind;
  if (k === 'background') return [];
  return MODEL_TYPES;
});

/* 下拉文案：HA 实体域直接显示原值（light / switch…），三个非实体域给中文提示，
 * 免得作者不知道 furniture 是「动态绘制的家具」而不是家具包 */
const TYPE_LABEL = { door: 'door 门', window: 'window 窗', furniture: 'furniture 家具（动态绘制）' };
const typeLabel = (t) => TYPE_LABEL[t] || t;

/* 当前 type 是否门/窗（决定要不要显示「设备实体绑定」那一行） */
const wallType = computed(() => isWallType(S.proj?.plugin.type));
/* 当前 type 是否动态家具（只有它显示 ftype，也没有主实体） */
const isFurn = computed(() => isFurnType(S.proj?.plugin.type));

/* 家具分类下拉：枚举唯一出处是 home 的 assets/catalog.json types，
 * 由 GET /api/catalog-types 下发（assets store 里已有兜底表，home 不可达也能选） */
const ftypeOptions = computed(() => assets.catalogTypes || []);
watch(isFurn, (v) => { if (v) assets.loadCatalogTypes().catch(() => {}); }, { immediate: true });

/* 切 type：离开 furniture 时清掉 ftype —— 它只对家具生效，
 * 留着会在导出时被静默忽略（服务端 manifest 只在 type==='furniture' 时写 ftype） */
function onTypeChange(v) {
  const p = S.proj && S.proj.plugin;
  if (!p) return;
  if (!isFurnType(v)) delete p.ftype;
  scheduleSave();
}

/* 清空下拉 = 显式删掉字段（保留空串会让 manifest 写出 ftype:''，home 会当成枚举外归「其他」） */
function onFtypeChange(v) {
  const p = S.proj && S.proj.plugin;
  if (!p) return;
  if (!v) delete p.ftype; else p.ftype = String(v);
  scheduleSave();
}

/* kind 只读：项目类型在新建时选定（见启动页「新建项目」），服务端 PUT 也会拒绝变更 */

/* 图标属于首个样式（插件默认造型） */
const icon2 = computed({
  get: () => S.proj?.styles?.[0]?.icon || '',
  set: (v) => { if (S.proj?.styles?.[0]) S.proj.styles[0].icon = v; },
});

/* 名称 = 项目名称（同一来源双向写：这里改名，顶栏 / 启动页卡片同步变） */
const projName = computed({
  get: () => S.proj?.name || '',
  set: (v) => {
    if (!S.proj) return;
    S.proj.name = v;
    if (S.proj.plugin) S.proj.plugin.name = v;
  },
});

/* 配置锁：锁定期间面板内所有控件 disabled（纯前端，刷新即解锁） */
const LOCK = computed(() => ui.isLocked);
</script>

<template>
  <section class="panel">
    <label>插件 ID（= 项目 ID）
      <el-input :model-value="S.proj.id" disabled />
    </label>
    <label>名称（项目名称）
      <el-input :disabled="LOCK" clearable v-model="projName" placeholder="如 卧室吊灯" @input="scheduleSave()" />
    </label>
    <div class="grid2">
      <label>kind
        <!-- 项目类型在新建时确定（服务端 PUT 也会拒改），这里只读展示 -->
        <el-select :model-value="S.proj.plugin.kind" disabled style="width: 100%">
          <el-option label="device 设备（含门/窗）" value="device" />
          <el-option label="background 背景" value="background" />
          <el-option label="catalog 家具包" value="catalog" />
        </el-select>
      </label>
      <label v-if="S.proj.plugin.kind !== 'background'">type
        <el-select clearable v-model="S.proj.plugin.type" style="width: 100%"
          :disabled="LOCK || (!typeOptions.length)" placeholder="（背景无需 type）" @change="onTypeChange">
          <el-option v-for="t in typeOptions" :key="t" :label="typeLabel(t)" :value="t" />
        </el-select>
      </label>
    </div>
    <div class="grid2">
      <label>版本
        <el-input :disabled="LOCK" clearable v-model="S.proj.plugin.version" @input="scheduleSave()" />
      </label>
      <!-- ftype 只对 type:'furniture' 生效：家具分类（柜架 / 床品 / 桌几…），
           取值来自 home 的 catalog.json types —— 与家具包的分类是同一份枚举 -->
      <label v-if="isFurn">ftype 家具分类
        <el-select clearable style="width: 100%" :disabled="LOCK"
          :model-value="S.proj.plugin.ftype || ''" placeholder="不填 = 只显示「家具」"
          @change="onFtypeChange">
          <el-option v-for="t in ftypeOptions" :key="t.type" :label="t.type + ' ' + t.name" :value="t.type" />
        </el-select>
      </label>
    </div>
    <label v-if="S.proj.plugin.kind === 'device' && !wallType && !isFurn">设备实体绑定（门/窗、家具没有这一项）
      <el-input :disabled="LOCK" clearable v-model="S.proj.plugin.entityId"
        placeholder="如 light.living_room；留空 = 预览时按 type 自动造一个" @input="scheduleSave()" />
    </label>
    <div v-else-if="wallType" class="hint">
      门/窗用 type 区分（door / window），没有「设备实体绑定」：开合状态全部来自「字段」里配的门磁与开门比例
    </div>
    <div v-else-if="isFurn" class="hint">
      家具（type: furniture）没有主实体：ftype 决定它在 home 属性面板 / 家具库里归到哪个分类页签（不填显示「家具」，枚举外的值归入「其他」）；缺省无 3D 标签、不可点击、贴地
    </div>
    <label>说明
      <el-input :disabled="LOCK" v-model="S.proj.plugin.description" type="textarea" autosize :rows="1"
        placeholder="插件功能一句话说明" @input="scheduleSave()" />
    </label>
    <label>图标（SVG 片段或 emoji）
      <el-input :disabled="LOCK" v-model="icon2" type="textarea" autosize :rows="1"
        placeholder="🌿 或 <path .../>" @input="scheduleSave()" />
    </label>
    <div v-if="wallType" class="hint">门/窗是 device 类里的贴墙类型：type 填 door / window；门的离地高度固定 0，窗可调</div>
    <div v-else-if="S.proj.plugin.kind === 'background'" class="hint">background 背景无需 type</div>
    <div class="panel sep-panel">
      <h3>发布目标</h3>
      <div class="hint">
        {{ S.target ? S.target.host + '（远程安装到 ha-3d-home）' : '加载中…' }}
      </div>
    </div>
  </section>
</template>
