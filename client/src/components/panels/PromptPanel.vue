<script setup>
/* 面板：AI 提示词 —— 上面是「信息统揽」（属性/字段/样式/部件的可点击名称），
   下面是给 AI 的正文。点统揽里的任意名称即可复制，写提示词时不用来回翻别的面板。
   正文存在 proj.aiPrompt，MCP 的 studio_get_project 会带出去。 */
import { computed, ref } from 'vue';
import { useStudio } from '../../stores';
const { S, scheduleSave, toast, project, ui, assets } = useStudio();
import { fieldTypeLabel, normalizeEnumValues, normalizeFieldType } from '../../field-schema';

const prompt = computed({
  get: () => (S.proj && S.proj.aiPrompt) || '',
  set: (v) => { if (S.proj) { S.proj.aiPrompt = v; scheduleSave(); } },
});

const len = computed(() => (prompt.value || '').length);

const plugin = computed(() => (S.proj && S.proj.plugin) || {});
const fields = computed(() => project.fieldList);
const styles = computed(() => project.engineList);
const models = computed(() => assets.models || []);

/* 统揽分组默认全展开；点标题可收起（状态只在本面板内有效） */
const open = ref({ attr: true, field: true, style: true, part: true });
const toggle = (k) => { open.value[k] = !open.value[k]; };

async function copy(text, what) {
  const t = String(text == null ? '' : text);
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
    toast('已复制 ' + (what ? what + '：' : '') + t);
  } catch (e) {
    toast('复制失败：' + e.message, true);
  }
}

/* 参数默认值：select 显示「值（选项名）」，其它直接显示值 */
function optValue(o) {
  const def = o.def;
  if (def === undefined || def === null || def === '') return '—';
  const list = Array.isArray(o.choices) ? o.choices : [];
  const hit = list.find((x) => String(x.value) === String(def));
  return hit && hit.label ? String(def) + '（' + hit.label + '）' : String(def);
}

/* 属性摘要：只挑写提示词时会用到的几项 */
const attrRows = computed(() => {
  const p = plugin.value;
  const rows = [
    { k: 'id', v: p.id },
    { k: '名称', v: p.name },
    { k: '类型', v: p.kind ? p.kind + (p.type ? ' / ' + p.type : '') : '' },
    { k: '版本', v: p.version },
  ];
  if (p.entityId) rows.push({ k: '设备实体', v: p.entityId });
  return rows.filter((r) => r.v);
});

/* 配置锁：锁定期间面板内所有控件 disabled（纯前端，刷新即解锁） */
const LOCK = computed(() => ui.isLocked);
</script>

<template>
  <section class="tabpage">
    <!-- ================= 信息统揽 ================= -->
    <div class="ov">
      <div class="ov-tip">点任意名称即可复制，下面写提示词时直接粘贴</div>

      <!-- 属性 -->
      <div class="ov-sec">
        <button class="ov-h" @click="toggle('attr')">
          <span class="ov-caret" :class="{ fold: !open.attr }">▾</span>
          属性
          <span class="ov-count">{{ attrRows.length }}</span>
        </button>
        <div v-if="open.attr" class="ov-body">
          <div v-for="r in attrRows" :key="r.k" class="ov-kv">
            <span class="ov-k">{{ r.k }}</span>
            <button class="ov-chip mono" :title="'点击复制：' + r.v" @click="copy(r.v, r.k)">{{ r.v }}</button>
          </div>
          <div v-if="!attrRows.length" class="ov-empty">还没有填属性</div>
        </div>
      </div>

      <!-- 字段 -->
      <div class="ov-sec">
        <button class="ov-h" @click="toggle('field')">
          <span class="ov-caret" :class="{ fold: !open.field }">▾</span>
          字段
          <span class="ov-count">{{ fields.length }}</span>
        </button>
        <div v-if="open.field" class="ov-body">
          <div v-for="f in fields" :key="f.key" class="ov-field">
            <div class="ov-item">
              <span class="ov-k2">key</span>
              <button class="ov-chip mono" title="点击复制字段 key" @click="copy(f.key, '字段 key')">{{ f.key }}</button>
              <span class="ov-k2">名称</span>
              <span class="ov-label">{{ f.label || '（未填）' }}</span>
              <span class="ov-tag type">{{ fieldTypeLabel(f.valueType) }}</span>
              <span v-for="d in (f.domains || [])" :key="d" class="ov-tag">{{ d }}</span>
            </div>
            <div v-if="f.tip" class="ov-note">{{ f.tip }}</div>
            <div v-if="normalizeFieldType(f.valueType) === 'enum' && normalizeEnumValues(f.enumValues).length" class="ov-note">
              枚举：{{ normalizeEnumValues(f.enumValues).join(' / ') }}
            </div>
            <div v-if="f.attributes" class="ov-note">属性（YAML，点击整段复制）：</div>
            <pre v-if="f.attributes" class="ov-yaml" title="点击复制字段属性"
              @click="copy(f.attributes, '字段属性')">{{ f.attributes }}</pre>
            <div v-if="f.placeholder" class="ov-note ph">占位：{{ f.placeholder }}</div>
          </div>
          <div v-if="!fields.length" class="ov-empty">还没有字段</div>
        </div>
      </div>

      <!-- 样式 -->
      <div class="ov-sec">
        <button class="ov-h" @click="toggle('style')">
          <span class="ov-caret" :class="{ fold: !open.style }">▾</span>
          样式
          <span class="ov-count">{{ styles.length }}</span>
        </button>
        <div v-if="open.style" class="ov-body">
          <div v-for="s in styles" :key="s.id" class="ov-style">
            <div class="ov-item">
              <span class="ov-k2">id</span>
              <button class="ov-chip mono" :title="'点击复制样式 id' + (s.desc ? '\n' + s.desc : '')"
                @click="copy(s.id, '样式 id')">{{ s.id }}</button>
              <span class="ov-k2">名称</span>
              <span class="ov-label">{{ s.name || '（未填）' }}</span>
            </div>
            <div v-if="(s.options || []).length" class="ov-opts">
              <div class="ov-opt-head"><span class="ov-k2">参数</span></div>
              <div v-for="o in s.options" :key="o.key" class="ov-opt">
                <button class="ov-chip sm mono"
                  :title="'点击复制参数 key：' + o.key
                    + (o.tip ? '\n' + o.tip : '')"
                  @click="copy(o.key, '参数 key')">{{ o.key }}</button>
                <span class="ov-label">{{ o.label || '（未命名）' }}</span>

                <!-- 下拉参数：把所有选项都列出来，默认值高亮 -->
                <template v-if="(o.choices || []).length">
                  <span class="ov-k2">可选</span>
                  <button v-for="c in o.choices" :key="c.value" class="ov-choice mono"
                    :class="{ on: String(c.value) === String(o.def) }"
                    :title="'点击复制选项值：' + c.value
                      + (String(c.value) === String(o.def) ? '（默认）' : '')"
                    @click="copy(c.value, '选项值')">{{ c.value }}（{{ c.label }}）<i
                      v-if="String(c.value) === String(o.def)" class="ov-def">默认</i></button>
                </template>

                <!-- 数值 / 开关等：直接给默认值 -->
                <template v-else>
                  <span class="ov-optv">= {{ optValue(o) }}</span>
                  <span v-if="o.type" class="ov-tag">{{ o.type }}</span>
                </template>
              </div>
            </div>
            <div v-else class="ov-empty sm">该样式没有参数</div>
          </div>
          <div v-if="!styles.length" class="ov-empty">还没有样式</div>
        </div>
      </div>

      <!-- 部件（模型文件） -->
      <div class="ov-sec">
        <button class="ov-h" @click="toggle('part')">
          <span class="ov-caret" :class="{ fold: !open.part }">▾</span>
          部件
          <span class="ov-count">{{ models.length }}</span>
        </button>
        <div v-if="open.part" class="ov-body">
          <div class="ov-item wrap">
            <button v-for="m in models" :key="m" class="ov-chip mono"
              :title="'点击复制代码里的路径：models/' + m"
              @click="copy('models/' + m, '模型路径')">{{ m }}</button>
            <span v-if="!models.length" class="ov-empty">models 目录里还没有 GLB</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ================= 提示词正文 ================= -->
    <div class="blk-title">
      AI 提示词
      <span class="blk-sub">写给 AI 的开发要求：这个插件要做什么、按什么规则判断、别动哪些东西。保存在项目里，不会直接参与代码生成（MCP studio_get_project 会带给 AI 当开发依据）。</span>
    </div>

    <el-input :disabled="LOCK" v-model="prompt" type="textarea" class="prompt-box" resize="vertical"
      :autosize="{ minRows: 9, maxRows: 24 }"
      placeholder="例如：
· 这是一个卷帘门插件，门磁 off 时无论比例多少都保持关闭
· 开门比例 0~100 映射到帘片向上收起的行程，收到顶留 8cm
· 样式参数 direction 表示内开/外开，2D 线稿要跟着镜像
· 质感用浅灰金属，别加花纹" />

    <div class="prompt-foot">
      <span class="prompt-count">{{ len }} 字</span>
      <span class="spacer"></span>
      <span class="prompt-saved">自动保存</span>
    </div>

    <div class="hint">
      这段文字只作为「给 AI 的说明」保存：MCP 的 <code>studio_get_project</code> 会返回
      <code>aiPrompt</code> 字段，AI 改代码前先读它，就不容易跑偏。
    </div>
  </section>
</template>
