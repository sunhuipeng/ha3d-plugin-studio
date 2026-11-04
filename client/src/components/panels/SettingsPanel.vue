<script setup>
/* 面板：插件设置（plugin id/名称/kind/type/版本/锚点 z/说明/图标 + 发布目标） */
import { computed } from 'vue';
import { S, scheduleSave, DEVICE_TYPES, OPENING_TYPES } from '../../store';

const typeOptions = computed(() => {
  const k = S.proj?.plugin.kind;
  if (k === 'opening') return OPENING_TYPES;
  if (k === 'background') return [];
  return DEVICE_TYPES;
});

function onKindChange() {
  const p = S.proj.plugin;
  if (p.kind === 'opening' && !OPENING_TYPES.includes(p.type)) p.type = 'door';
  if (p.kind === 'device' && !DEVICE_TYPES.includes(p.type)) p.type = 'switch';
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
</script>

<template>
  <section class="panel">
    <label>插件 ID（= 项目 ID）
      <el-input :model-value="S.proj.id" disabled />
    </label>
    <label>名称（项目名称）
      <el-input clearable v-model="projName" placeholder="如 卧室吊灯" @input="scheduleSave()" />
    </label>
    <div class="grid2">
      <label>kind
        <el-select clearable v-model="S.proj.plugin.kind" style="width: 100%" @change="onKindChange">
          <el-option label="device 设备" value="device" />
          <el-option label="opening 门窗" value="opening" />
          <el-option label="background 背景" value="background" />
        </el-select>
      </label>
      <label v-if="S.proj.plugin.kind !== 'background'">type
        <el-select clearable v-model="S.proj.plugin.type" style="width: 100%"
          :disabled="!typeOptions.length" placeholder="（背景无需 type）" @change="scheduleSave()">
          <el-option v-for="t in typeOptions" :key="t" :label="t" :value="t" />
        </el-select>
      </label>
    </div>
    <div class="grid2">
      <label>版本
        <el-input clearable v-model="S.proj.plugin.version" @input="scheduleSave()" />
      </label>
    </div>
    <label v-if="S.proj.plugin.kind === 'device'">设备实体绑定（只有设备类插件有）
      <el-input clearable v-model="S.proj.plugin.entityId"
        placeholder="如 light.living_room；留空 = 预览时按 type 自动造一个" @input="scheduleSave()" />
    </label>
    <div v-else-if="S.proj.plugin.kind === 'opening'" class="hint">
      门窗类没有「设备实体绑定」：开合状态全部来自「字段」里配的门磁与开门比例
    </div>
    <label>说明
      <el-input v-model="S.proj.plugin.description" type="textarea" autosize :rows="1"
        placeholder="插件功能一句话说明" @input="scheduleSave()" />
    </label>
    <label>图标（SVG 片段或 emoji）
      <el-input v-model="icon2" type="textarea" autosize :rows="1"
        placeholder="🌿 或 <path .../>" @input="scheduleSave()" />
    </label>
    <div v-if="S.proj.plugin.kind === 'opening'" class="hint">opening 的 type 应为 door / window；门窗样式不需要 z</div>
    <div v-else-if="S.proj.plugin.kind === 'background'" class="hint">background 背景无需 type</div>
    <div class="panel sep-panel">
      <h3>发布目标</h3>
      <div class="hint">
        {{ S.target ? S.target.host + '（远程安装到 ha-3d-home）' : '加载中…' }}
      </div>
    </div>
  </section>
</template>
