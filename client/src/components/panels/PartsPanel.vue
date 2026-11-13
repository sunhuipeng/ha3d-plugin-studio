<script setup>
/* 面板：部件（模型文件库 / 大图预览 / GLB 节点拆分）
 *
 * 模型文件以 models 目录为唯一来源（assets.models），项目 JSON 里不保存 parts：
 * 模型怎么摆由插件代码决定（ctx.frame / ctx.glb('models/x.glb') / ctx.box …）。
 *
 * GLB 边界：节点树（thumb.js）/ 缩略图 / 包围盒 / 顶点统计都在浏览器端本地解析；
 * 只有「✂ 拆分」与「修复材质」走服务端（routes/models.js 的 /split、/fix-materials），
 * 因为拆分要逐顶点烘焙世界变换、修材质要原地改写 glb 的 materials。
 * MCP 侧同理：get_model 只负责给下载地址，AI 下载后用 Python / Node.js 直接解析（零依赖，不引第三方库）。
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { useStudio } from '../../stores';
const { S, act, ui, assets } = useStudio();
import PartThumb from '../PartThumb.vue';
import ModelPreview from '../ModelPreview.vue';
import { modelNodes, cachedNodes, isNodesError } from '../../thumb';

/* GLB 节点树（独立 node）：按 file 缓存于 thumb.js，这里只读缓存 + 触发加载 */
const nodesTick = ref(0);
function nodesOf(file) {
  if (!file) return null;
  modelNodes(S.proj.id, file);   // 已缓存则直接返回，否则触发加载（part-nodes 事件后刷新）
  void nodesTick.value;
  return cachedNodes(S.proj.id, file);
}
function flatNodes(tree) {
  const out = [];
  const walk = (list, depth) => (list || []).forEach((n) => {
    out.push({ name: n.name, depth });
    walk(n.children, depth + 1);
  });
  walk(tree, 0);
  return out;
}
const nodeCount = (file) => (nodesOf(file) || []).length;

/* 展开状态（按文件记） */
const expandedFiles = ref(new Set());
function toggleNodes(file) { const s = new Set(expandedFiles.value); s.has(file) ? s.delete(file) : s.add(file); expandedFiles.value = s; }
function onNodesEvent() { nodesTick.value += 1; }
onMounted(() => window.addEventListener('part-nodes', onNodesEvent));
onBeforeUnmount(() => window.removeEventListener('part-nodes', onNodesEvent));

/* 文件库：点击行高亮 + 顶部预览；点子节点 = 预览该子模型 */
function onLibClick(f) {
  ui.setPreviewFile(f);
  ui.setPreviewNode('');
}
function onLibNodeClick(f, name) {
  ui.setPreviewFile(f);
  ui.setPreviewNode(name);
}

/* 预览目标：最近点击的库文件；无点击时预览框显示「未选择模型」 */
const previewFile = computed(() => ui.previewFile || '');
const previewName = computed(() => previewFile.value.replace(/\.glb$/i, ''));

/* 文件选择（隐藏 input + el-button 触发） */
const glbInput = ref(null);
function onGlbFiles(e) {
  const fs = Array.from(e.target.files || []);
  if (fs.length) act.importFiles(fs);
  e.target.value = '';
}

/* 模型删除确认（el-popover，按文件名索引实例） */
const delPops = ref({});
async function confirmDelModel(f) {
  delPops.value[f]?.hide();
  await act.deleteModel(f);
}

/* 配置锁：锁定期间面板内所有控件 disabled（纯前端，刷新即解锁） */
const LOCK = computed(() => ui.isLocked);
</script>

<template>
  <section class="tabpage parts-page">
    <!-- 大图模型预览 + 信息 -->
    <ModelPreview :proj-id="S.proj.id" :file="previewFile" :node="ui.previewNode" :fixing="assets.fixing"
      @fix="act.fixMaterial(previewFile)" />
    <div v-if="previewFile" class="mp-info">
      <b>{{ previewName }}</b>
      <span class="mp-file">{{ previewFile }}</span>
    </div>
    <div v-if="previewFile" class="hint">预览：拖拽旋转 · 滚轮缩放</div>

    <!-- 模型文件库（唯一列表：项目里的模型都在这儿，插件代码按 models/文件名 引用） -->
    <div class="parts-scroll">
      <div class="blk-title">模型文件库（{{ assets.models.length }} 个；代码里用 ctx.glb('models/文件名') 引用）</div>
      <ul class="list parts-ul">
        <li v-for="f in assets.models" :key="f"
          :class="{ pv: previewFile === f, expanded: expandedFiles.has(f) }"
          @click="onLibClick(f)">
          <PartThumb :proj-id="S.proj.id" :file="f" />
          <span class="p-name">{{ f.replace(/\.glb$/i, '') }}</span>
          <span class="meta">{{ f }}</span>
          <el-button :disabled="LOCK" v-if="nodeCount(f) > 1" link class="node-toggle" :class="{ on: expandedFiles.has(f) }"
            :title="`GLB 含 ${nodeCount(f)} 个独立 node 节点，展开查看`" @click.stop="toggleNodes(f)">
            {{ expandedFiles.has(f) ? '▾' : '▸' }} {{ nodeCount(f) }} 节点
          </el-button>
          <span v-else-if="isNodesError(f)" class="node-err" title="GLB 节点解析失败">节点?</span>
          <el-popover placement="left" :width="230" trigger="click"
            :ref="(el) => (delPops[f] = el)">
            <template #reference>
              <el-button :disabled="LOCK" link type="danger" class="lock-block" title="删除模型文件"
                @click.stop>删除</el-button>
            </template>
            <div class="del-pop-text">删除 <b>{{ f }}</b> ？<br>文件会从 models 目录移除，不可恢复。</div>
            <div class="row-btns">
              <el-button :disabled="LOCK" size="small" @click="delPops[f]?.hide()">取消</el-button>
              <el-button :disabled="LOCK" size="small" type="danger" class="lock-block" @click="confirmDelModel(f)">确定删除</el-button>
            </div>
          </el-popover>
          <!-- 嵌套子列表：GLB 内节点树，点击预览子模型，✂ 可把某节点导出成独立 .glb -->
          <ul v-if="expandedFiles.has(f) && nodesOf(f)" class="p-nodes">
            <li v-for="(n, i) in flatNodes(nodesOf(f))" :key="i" class="p-node"
              :class="{ sel: ui.previewNode === n.name && ui.previewFile === f }"
              :style="{ paddingLeft: 6 + n.depth * 14 + 'px' }"
              :title="'点击预览该子模型'"
              @click.stop="onLibNodeClick(f, n.name)">
              <PartThumb :proj-id="S.proj.id" :file="f" :node="n.name" class="p-node-thumb" />
              <span class="p-node-name">{{ n.name }}</span>
              <span v-if="n.depth" class="p-node-depth">子级</span>
              <el-button :disabled="LOCK" link type="primary" class="p-node-split-one lock-block"
                :title="`只把「${n.name}」导出为独立模型，其余节点合成 __rest.glb`"
                @click.stop="act.splitModelNode(f, n.name)">✂ 拆分</el-button>
            </li>
            <li class="p-node-split">
              <el-button :disabled="LOCK" link type="primary" class="lock-block" title="把每个节点都导出为独立 .glb 加入文件库（原文件保留）"
                @click.stop="act.splitModelFile(f)">✂ 全部拆分（每节点一个模型）</el-button>
            </li>
          </ul>
          <div v-else-if="expandedFiles.has(f) && isNodesError(f)" class="p-nodes p-node-err">⚠ 节点解析失败</div>
        </li>
      </ul>
      <div v-if="!assets.models.length" class="hint">模型文件库为空。保持为空也没问题——纯代码建模即可；需要更精致的造型时，再用下方按钮导入 GLB。</div>
    </div>

    <!-- 固定在面板最底部：说明 + 导入入口始终可见，不随模型列表滚动 -->
    <div class="glb-note">
      <b>导入 GLB 是可选项</b>：插件可以完全用代码绘制模型（比如用 <code>ctx.box</code> 拼体块），
      一个文件都不上传也能出完整效果；用建模软件做好的 GLB，细节和材质通常更精致。
      推荐按需选择——简单体块交给代码，精细造型上传模型，两者可以混用。
    </div>
    <el-button :disabled="LOCK" type="primary" plain class="import-btn lock-block" @click="glbInput && glbInput.click()">＋ 导入 GLB 文件</el-button>
    <input ref="glbInput" type="file" accept=".glb" multiple hidden @change="onGlbFiles">
  </section>
</template>
