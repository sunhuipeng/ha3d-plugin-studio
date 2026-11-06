<script setup>
/* 面板：当前样式（基本信息 + 样式级参数 options + 复制/删除样式） */
import { computed, ref, watch } from 'vue';
import { ElMessageBox } from 'element-plus';
import { S, act, scheduleSave, toast, OPTION_TYPES, curStyle, engineList } from '../../store';
import { optionOwns, stripExtraOptionKeys } from '../../option-schema';

const st = computed(() => curStyle());

/* 背景插件项目才有「添加偏移参数」按钮（offsetX/offsetZ 是 home 背景引擎的保留键） */
const isBgProj = computed(() => !!(S.proj && S.proj.plugin && S.proj.plugin.kind === 'background'));

/* 设备类插件项目（含门/窗）：只有它显示 离地 z / 标签高度（背景没有这两个概念） */
const isDeviceProj = computed(() => !!(S.proj && S.proj.plugin && S.proj.plugin.kind === 'device'));
/* 门的离地高度恒 0（贴地不可调）；窗与普通设备才显示 z */
const isDoorProj = computed(() => !!(S.proj && S.proj.plugin && S.proj.plugin.type === 'door'));

/* 还没填 key 的参数条数：key 是插件读值的唯一入口（ctx.options.key / p.options.key），
   空着只能是编辑期的半成品，这里显式提示，免得以为是「加了却没生效」的 bug */
const draftKeys = computed(() => ((st.value && st.value.options) || [])
  .filter((o) => o && !String(o.key || '').trim()).length);

/* 样式 id 不能直接 v-model 到 st.id：
   curStyle() 是按 S.styleId 去 styles 里 find 的，边打字边改 id 会让 S.styleId 找不到它，
   面板就回落到 styles[0]（表现为「在第二个样式里输入，字跑到第一个样式去」）。
   所以这里用本地草稿，失焦 / 回车时才一次性提交，并在提交时同步 S.styleId。 */
const idDraft = ref('');
watch(() => (st.value ? st.value.id : ''), (v) => { idDraft.value = v || ''; }, { immediate: true });

function commitId() {
  const s = st.value;
  if (!s) return;
  const next = String(idDraft.value || '').trim().replace(/\s+/g, '_');
  if (!next) { idDraft.value = s.id || ''; return; }         // 清空 = 放弃修改
  if (next === s.id) { idDraft.value = next; return; }
  /* 引擎内存（含代码声明条目）与项目配置两边都查重 */
  if (engineList().some((x) => x !== s && x.id === next)
    || (S.proj.styles || []).some((x) => x !== s && x.id === next)) {
    toast('样式 id「' + next + '」已被其他样式占用', true);
    idDraft.value = s.id || '';
    return;
  }
  const oldId = s.id;
  s.id = next;
  /* 项目配置里的同一条目（有则）同步改名 —— id 是内存 ↔ JSON 的对账键，必须一起改 */
  const ps = (S.proj.styles || []).find((x) => x && x.id === oldId);
  if (ps) ps.id = next;
  /* 当前正在编辑的就是这个样式 → 一起改掉，否则预览/面板会认不出它 */
  if (S.styleId === oldId) S.styleId = next;
  idDraft.value = next;
  scheduleSave();
}

/* ---- select 参数的选项编辑（一行一个 value/label，顺序即下拉顺序，第一项是默认回退） ---- */
function onTypeChange(o) {
  /* 按对照表清掉新类型不再拥有的键（range → number 会丢 min/max，range → select 连 step 一起丢，
   * 离开 select 丢 choices），否则脏键跟着存档往后传，diff 里全是「空 → 旧值」的假差异 */
  stripExtraOptionKeys(o, o.type);
  if (o.type === 'select' && !Array.isArray(o.choices)) o.choices = [];
  /* 默认值只在 select 下需要跟着选项走 */
  if (o.type !== 'select' && o.def === undefined) o.def = '';
  scheduleSave();
}

function addChoice(o) {
  if (!Array.isArray(o.choices)) o.choices = [];
  const n = o.choices.length + 1;
  o.choices.push({ value: 'option' + n, label: '选项 ' + n });
  scheduleSave();
}

function delChoice(o, i) {
  if (!Array.isArray(o.choices)) return;
  const gone = o.choices[i];
  o.choices.splice(i, 1);
  /* 默认值指向被删的项 → 清空，生成时回退到第一项 */
  if (gone && o.def === gone.value) o.def = '';
  scheduleSave();
}

function moveChoice(o, i, d) {
  const arr = o.choices;
  if (!Array.isArray(arr)) return;
  const j = i + d;
  if (j < 0 || j >= arr.length) return;
  const [x] = arr.splice(i, 1);
  arr.splice(j, 0, x);
  scheduleSave();
}

function copyStyle() {
  if (!st.value) return;
  act.copyStyle(st.value.id);
}

/* 删除属高危操作：需输入「确定」两个字 */
async function delStyle() {
  if (!st.value) return;
  if (engineList().length <= 1) { toast('至少保留一个样式', true); return; }
  const name = st.value.name || st.value.id;
  try {
    await ElMessageBox.prompt(
      `删除样式「${name}」会一并删除它的参数配置，且不可恢复。`,
      '删除当前样式',
      {
        type: 'warning',
        confirmButtonText: '删除',
        cancelButtonText: '取消',
        inputPlaceholder: '请输入“确定”两个字',
        inputValidator: (v) => (String(v ?? '').trim() === '确定' ? true : '请输入「确定」两个字才能删除'),
      }
    );
    if (act.removeStyle(st.value.id)) toast('已删除样式「' + name + '」');
  } catch (e) { /* 取消 */ }
}

/* 配置锁：锁定期间面板内所有控件 disabled（纯前端，刷新即解锁） */
const LOCK = computed(() => S.lock.locked);
</script>

<template>
  <section class="tabpage">
    <!-- 与渲染区顶部同一份数据源（引擎内存优先）：点哪个就在预览哪个，两边同步 -->
    <div class="pv-styles">
      <span class="pv-styles-label">样式</span>
      <button v-for="s in engineList()" :key="s.id" class="pv-style" :class="{ on: s.id === S.styleId }"
        :title="'预览「' + (s.name || s.id) + '」'"
        @click="S.styleId = s.id">{{ s.name || s.id }}</button>
    </div>
    <div class="blk-sub" style="margin: 0 0 8px">
      数据来自引擎运行后的内存（AI 代码声明 + 上次存档恢复）。这里编辑元信息与参数，只存数据、
      不自动重渲 —— 改完点渲染区的「重新渲染」看效果；画布左下角的卡片才是实时调值。
      所有条目（含 AI 追加的）随保存全量写回项目配置。
    </div>
    <template v-if="st">
      <div class="ed-row">
        <label>id
          <el-input :disabled="LOCK" clearable v-model="idDraft" placeholder="如 warm"
            @change="commitId" @blur="commitId" @keyup.enter="commitId" />
        </label>
        <label>名称
          <el-input :disabled="LOCK" clearable v-model="st.name" placeholder="如 暖光造型" @input="scheduleSave()" />
        </label>
        <!-- 离地 z / 标签高度只有设备类（含门/窗）用得上；门的 z 恒 0，不给调 -->
        <template v-if="isDeviceProj">
          <label v-if="!isDoorProj">离地 z(米)
            <el-input-number :disabled="LOCK" v-model="st.z" :step="0.05" :controls="false"
              style="width: 100%" @change="scheduleSave()" />
          </label>
          <label v-else>离地 z(米)
            <el-input :model-value="0" disabled title="门恒贴地，离地高度固定 0（不可调）" />
          </label>
          <label>标签高度(米)
            <el-input :disabled="LOCK" clearable v-model="st.labelOffset" placeholder="距地高度，如 1.5" @input="scheduleSave()" />
          </label>
        </template>
        <label v-if="isBgProj" title="背景引擎按此频率回调 update(t, api)；0 / 留空 = 静态只画一次，引擎上限 30Hz">
          刷新率 refresh(Hz)
          <el-input-number :disabled="LOCK" v-model="st.refresh" :min="0" :max="30" :step="1" :controls="false"
            placeholder="0 = 静态" style="width: 100%" @change="scheduleSave()" />
        </label>
        <label class="wide">图标（SVG 片段 / emoji）
          <el-input :disabled="LOCK" clearable v-model="st.icon" placeholder="🌿 或 <path .../>" @input="scheduleSave()" />
        </label>
        <label class="wide">说明
          <el-input :disabled="LOCK" v-model="st.desc" type="textarea" :autosize="{ minRows: 1, maxRows: 5 }"
            placeholder="样式说明（选填）" @input="scheduleSave()" />
        </label>
      </div>

      <div class="blk-title">
        样式参数 options
        <span class="blk-tag">{{ st.name || st.id }}</span>
        <span class="blk-sub">{{ (st.options || []).length }} 条 · 只属于当前样式；3D 读 ctx.options.key，2D 读 p.options.key<span
          v-if="draftKeys" class="opt-draft-warn">（{{ draftKeys }} 条未填 key，插件读不到，左下卡片里标「未命名」）</span></span>
      </div>
      <div v-for="(o, i) in st.options" :key="st.id + ':' + i" class="ed-row">
        <label :class="{ 'opt-key-missing': !String(o.key || '').trim() }">key
          <el-input :disabled="LOCK" clearable v-model="o.key" placeholder="如 brightness" @input="scheduleSave()" />
        </label>
        <label>标签
          <el-input :disabled="LOCK" clearable v-model="o.label" placeholder="如 亮度" @input="scheduleSave()" />
        </label>
        <label>类型
          <el-select :disabled="LOCK" clearable v-model="o.type" style="width: 100%" @change="onTypeChange(o)">
            <el-option v-for="t in OPTION_TYPES" :key="t.value" :label="t.label" :value="t.value" />
          </el-select>
        </label>
        <label v-if="o.type === 'select'">默认值 def
          <el-select :disabled="LOCK" v-model="o.def" clearable filterable allow-create default-first-option
            placeholder="留空 = 用第一项" style="width: 100%" @change="scheduleSave()">
            <el-option v-for="(c, ci) in (o.choices || [])" :key="ci"
              :label="(c.label || c.value) + (ci === 0 ? '（第一项）' : '')" :value="c.value" />
          </el-select>
        </label>
        <label v-else>默认值 def
          <el-input :disabled="LOCK" clearable v-model="o.def" placeholder="默认值" @input="scheduleSave()" />
        </label>
        <label v-if="optionOwns(o.type, 'min')">min
          <el-input-number :disabled="LOCK" v-model="o.min" :controls="false"
            style="width: 100%" @change="scheduleSave()" />
        </label>
        <label v-if="optionOwns(o.type, 'max')">max
          <el-input-number :disabled="LOCK" v-model="o.max" :controls="false"
            style="width: 100%" @change="scheduleSave()" />
        </label>
        <label v-if="optionOwns(o.type, 'step')">step
          <el-input-number :disabled="LOCK" v-model="o.step" :controls="false"
            style="width: 100%" @change="scheduleSave()" />
        </label>
        <label>tip{{ o.type === 'checkbox' ? '（勾选框右侧文字）' : '（参数说明）' }}
          <el-input :disabled="LOCK" clearable v-model="o.tip" :placeholder="o.type === 'checkbox' ? '如：启用' : '参数说明，如：调节灯带亮度'"
            @input="scheduleSave()" />
        </label>
        <div v-if="o.type === 'select'" class="wide opt-choices">
          <div class="opt-choices-head">
            <span>选项 choices（value 给代码判断，label 显示给人看；第一项为默认回退）</span>
            <el-button :disabled="LOCK" link type="primary" class="lock-block" @click="addChoice(o)">＋ 添加选项</el-button>
          </div>
          <div v-if="!(o.choices && o.choices.length)" class="opt-choices-empty">还没有选项</div>
          <div v-for="(c, ci) in (o.choices || [])" :key="ci" class="opt-choice-row">
            <el-input :disabled="LOCK" v-model="c.value" placeholder="value，如 inside" @input="scheduleSave()" />
            <el-input :disabled="LOCK" v-model="c.label" placeholder="label，如 里面" @input="scheduleSave()" />
            <el-button link :disabled="LOCK || (ci === 0)" class="lock-block" title="上移" @click="moveChoice(o, ci, -1)">↑</el-button>
            <el-button link :disabled="LOCK || (ci === (o.choices || []).length - 1)" class="lock-block" title="下移" @click="moveChoice(o, ci, 1)">↓</el-button>
            <el-button :disabled="LOCK" link type="danger" class="lock-block" title="删除该选项" @click="delChoice(o, ci)">✕</el-button>
          </div>
        </div>
        <div class="del">
          <el-button :disabled="LOCK" link type="danger" class="lock-block" @click="act.removeOption(st.id, o)">删除</el-button>
        </div>
      </div>
      <el-button :disabled="LOCK" class="lock-block" @click="act.addOption">＋ 添加参数</el-button>
      <el-button :disabled="LOCK" v-if="isBgProj" type="primary" plain class="lock-block"
        title="一键添加 ha-3d-home 背景引擎保留的 offsetX（东西偏移）/ offsetZ（南北偏移）两条滑条参数"
        @click="act.addOffsetOpts">＋ 添加偏移参数</el-button>

      <div class="del style-ops" style="margin-top: 12px;">
        <el-button :disabled="LOCK" type="primary" plain class="lock-block" @click="copyStyle">⧉ 复制当前样式</el-button>
        <el-button :disabled="LOCK" type="danger" plain class="lock-block" @click="delStyle">🗑 删除当前样式</el-button>
      </div>
      <div class="hint">
        点顶部胶囊切换样式，下面的 options 会跟着换成该样式自己的参数（3D 走 ctx.options、2D 走 p.options）。
        字段 <b>fields</b> 是插件级 / 项目级的，所有样式共用一份，不随样式切换。
      </div>
    </template>
  </section>
</template>
