<script setup>
import { computed } from 'vue';
/* 面板：字段（插件级实体绑定，所有样式共用） */
import { S, act, scheduleSave, ENTITY_DOMAINS, engineFieldList } from '../../store';
import {
  FIELD_TYPES, normalizeEnumValues, normalizeFieldType, suggestEnumTags,
} from '../../field-schema';

/* 字段的「值形态」推断：告诉使用者这个字段该绑什么、插件能读到什么。
   以面板上显式选的「字段类型」为准（valueType），枚举类直接把值列出来。 */
function kindHint(f) {
  const vt = normalizeFieldType(f.valueType);
  if (vt === 'enum') {
    const vals = normalizeEnumValues(f.enumValues);
    if (!vals.length) return '取值：枚举（还没加枚举值，下面点常用值或自己敲）';
    const head = vals.slice(0, 6).join(' / ');
    return `取值：枚举（${head}${vals.length > 6 ? ` …共 ${vals.length} 个` : ''}）`;
  }
  if (vt === 'number') return '取值：数值（0~100 之类的数字，范围看具体实体）';
  return '取值：字符 / 状态文本（如 on / off、heat / cool）';
}

/* 插件里怎么读这个字段 */
function readHint(f) {
  const key = f.key || 'key';
  return `代码里用 obj.${key} 拿实体 id，或 ctx.fieldState('${key}') 直接读状态`;
}

/* 切换字段类型：把 enumValues 备好（切走不清空，切回来值还在） */
function onTypeChange(f) {
  if (!Array.isArray(f.enumValues)) f.enumValues = [];
  scheduleSave();
}
/* 下拉候选 = 该实体域的常用值（on/off、heat/cool…）+ 已经填过的自定义值，
   这样已选值也能在列表里看到、再点一次就取消 */
function enumOptions(f) {
  const used = Array.isArray(f.enumValues) ? f.enumValues : [];
  const out = [];
  for (const v of suggestEnumTags(f)) out.push(v);
  for (const v of used) if (!out.includes(v)) out.push(v);
  return out;
}

/* 配置锁：锁定期间面板内所有控件 disabled（纯前端，刷新即解锁） */
const LOCK = computed(() => S.lock.locked);
</script>

<template>
  <section class="tabpage">
    <div v-for="(f, i) in engineFieldList()" :key="i" class="ed-row">
      <label>标签
        <el-input :disabled="LOCK" clearable v-model="f.label" placeholder="如 门磁" @input="scheduleSave()" />
      </label>
      <label>key
        <el-input :disabled="LOCK" clearable v-model="f.key" placeholder="如 doorEntity" @input="scheduleSave()" />
      </label>
      <label class="wide">domains（实体域，可多选；留空 = 不限）
        <el-select :disabled="LOCK" clearable v-model="f.domains" style="width: 100%" multiple filterable allow-create
          default-first-option :reserve-keyword="false" placeholder="选择或输入实体域，如 binary_sensor / sensor"
          @change="scheduleSave()">
          <el-option v-for="d in ENTITY_DOMAINS" :key="d" :label="d" :value="d" />
        </el-select>
      </label>
      <label>placeholder（输入框里的灰字提示）
        <el-input :disabled="LOCK" clearable v-model="f.placeholder" placeholder="如：选一个 on/off 的门磁传感器" @input="scheduleSave()" />
      </label>
      <label>tip（字段说明，鼠标悬停显示）
        <el-input :disabled="LOCK" clearable v-model="f.tip" placeholder="如：用于判断门开合状态" @input="scheduleSave()" />
      </label>

      <!-- 分隔：上面是「怎么绑实体」，下面是「给人 / AI 看的说明性元信息」 -->
      <div class="field-sep"></div>

      <!-- 值类型：纯说明性元信息，不影响渲染；给面板、提示词、AI（MCP）看。
           ⚠ 这里用 div 不用 label：label 会把整行空白区的点击都转给下拉框，鼠标点右边空白也会弹选项 -->
      <div class="fld-line">
        <span>字段类型（给人 / AI 看的说明，不参与渲染）</span>
        <el-select :disabled="LOCK" v-model="f.valueType" style="width: 160px" @change="onTypeChange(f)">
          <el-option v-for="t in FIELD_TYPES" :key="t.value" :label="t.label" :value="t.value" />
        </el-select>
      </div>

      <div v-if="f.valueType === 'enum'" class="fld-line">
        <span>枚举值（可选常用值，也可直接输入自定义值后回车）</span>
        <el-select :disabled="LOCK" v-model="f.enumValues" style="width: 100%" multiple filterable allow-create
          default-first-option :reserve-keyword="false" clearable
          placeholder="选常用值，或输入自定义值后回车添加" @change="scheduleSave()">
          <el-option v-for="v in enumOptions(f)" :key="v" :label="v" :value="v" />
        </el-select>
      </div>

      <div class="field-note">
        <span class="field-kind">{{ kindHint(f) }}</span>
        <span class="field-read">{{ readHint(f) }}</span>
      </div>

      <div class="del">
        <el-button :disabled="LOCK" link type="danger" class="lock-block" @click="act.removeField(f)">删除</el-button>
      </div>
    </div>
    <el-button :disabled="LOCK" class="lock-block" @click="act.addField">＋ 添加字段</el-button>
    <div class="hint">
      字段是「插件级实体绑定」，所有样式共用。key 会注入 AI 上下文，插件代码里用
      <code>obj[key]</code> 拿实体 id、<code>ctx.fieldState('key')</code> 读状态；
      预览时按 key 自动造一个模拟实体（sensor.preview_&lt;key&gt;），左下角可以直接改值看效果。
    </div>
  </section>
</template>
