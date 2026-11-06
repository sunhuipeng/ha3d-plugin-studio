<script setup>
/* 面板：插件设置（plugin id/名称/kind/type/版本/锚点 z/说明/图标 + 发布目标）
 * 插件只有两类：kind:'device'（设备 **含门/窗**）与 kind:'background'。
 * 门/窗 = type:'door'/'window' 的贴墙设备，不再是独立 kind。 */
import { computed } from 'vue';
import { S, scheduleSave, MODEL_TYPES, isWallType } from '../../store';

const typeOptions = computed(() => {
  const k = S.proj?.plugin.kind;
  if (k === 'background') return [];
  return MODEL_TYPES;
});

/* 当前 type 是否门/窗（决定要不要显示「设备实体绑定」那一行） */
const wallType = computed(() => isWallType(S.proj?.plugin.type));

function onKindChange() {
  const p = S.proj.plugin;
  if (p.kind === 'device' && !MODEL_TYPES.includes(p.type)) p.type = 'switch';
  /* 背景类没有实体类型：输入框隐藏的同时把 type 固定成 'bg'（下游按这个值识别） */
  if (p.kind === 'background') p.type = 'bg';
  scheduleSave();
}

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
const LOCK = computed(() => S.lock.locked);
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
        <el-select :disabled="LOCK" clearable v-model="S.proj.plugin.kind" style="width: 100%" @change="onKindChange">
          <el-option label="device 设备（含门/窗）" value="device" />
          <el-option label="background 背景" value="background" />
        </el-select>
      </label>
      <label v-if="S.proj.plugin.kind !== 'background'">type
        <el-select clearable v-model="S.proj.plugin.type" style="width: 100%"
          :disabled="LOCK || (!typeOptions.length)" placeholder="（背景无需 type）" @change="scheduleSave()">
          <el-option v-for="t in typeOptions" :key="t" :label="t" :value="t" />
        </el-select>
      </label>
    </div>
    <div class="grid2">
      <label>版本
        <el-input :disabled="LOCK" clearable v-model="S.proj.plugin.version" @input="scheduleSave()" />
      </label>
    </div>
    <label v-if="S.proj.plugin.kind === 'device' && !wallType">设备实体绑定（门/窗没有这一项）
      <el-input :disabled="LOCK" clearable v-model="S.proj.plugin.entityId"
        placeholder="如 light.living_room；留空 = 预览时按 type 自动造一个" @input="scheduleSave()" />
    </label>
    <div v-else-if="wallType" class="hint">
      门/窗用 type 区分（door / window），没有「设备实体绑定」：开合状态全部来自「字段」里配的门磁与开门比例
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
