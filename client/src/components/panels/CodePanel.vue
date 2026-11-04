<script setup>
/* 面板：代码编辑（可写）
 * 用 CodeMirror 6 渲染「当前项目的 plugin.js」（即项目里的 customJs，AI 生成 / 手写同一份）：
 * 行号槽、折叠、语法高亮。编辑内容立即写进 S.proj.customJs 并走全局自动保存（900ms 防抖），
 * 点「运行」或 Cmd/Ctrl+Enter 让插件渲染区按最新代码重建。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { EditorView, basicSetup } from 'codemirror';
import { keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { S, api, saveNow, scheduleSave, viewportApi, toast } from '../../store';

const host = ref(null);
const code = ref('');
const manifest = ref(null);
const loading = ref(false);
const running = ref(false);
const err = ref('');
const lineCount = ref(0);
const stale = ref(false);   // 改过但还没运行（跑出来的画面还是旧代码）

let view = null;
let synced = '';            // 最近一次与服务端对齐的内容
let applying = false;       // 程序化写入文档期间，别把内容当用户编辑

/* VSCode 浅色观感（只覆盖外观，不改行为） */
const lightTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px', backgroundColor: '#fcfdff', color: '#2a3038' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', lineHeight: '1.62' },
  '.cm-gutters': { backgroundColor: '#f7f9fc', color: '#b6bfcc', border: 'none', borderRight: '1px solid #eef1f6' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#8b97a8' },
  '.cm-activeLine': { backgroundColor: 'rgba(47,127,224,.05)' },
  '.cm-content': { padding: '6px 0', caretColor: '#1d232b' },
  '.cm-line': { padding: '0 14px 0 6px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-foldGutter span': { color: '#c2cad6' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(47,127,224,.16)' },
}, { dark: false });

/* Tab 缩进 2 空格（CodeMirror 默认 Tab 是切焦点，写代码时很别扭） */
const tabKey = {
  key: 'Tab',
  run(v) {
    v.dispatch(v.state.replaceSelection('  '));
    return true;
  },
};

/* Cmd/Ctrl+Enter 直接运行 */
const runKey = {
  key: 'Mod-Enter',
  run() { run(); return true; },
};

async function load() {
  if (!S.proj) { code.value = ''; return; }
  loading.value = true;
  err.value = '';
  try {
    await saveNow();
    const d = await api('GET', `/api/projects/${S.proj.id}/build`);
    code.value = d.js || '';
    manifest.value = d.manifest || null;
    synced = code.value;
    stale.value = false;
    applyDoc();
  } catch (e) {
    err.value = e.message || String(e);
    code.value = '';
    manifest.value = null;
    applyDoc();
  } finally {
    loading.value = false;
  }
}

function applyDoc() {
  if (!view) return;
  const doc = code.value || '';
  applying = true;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
  applying = false;
  lineCount.value = doc ? doc.split('\n').length : 0;
}

/* 用户在编辑器里打字 → 同步到项目数据 + 自动保存 */
function onDocChange() {
  if (!view || applying) return;
  const txt = view.state.doc.toString();
  code.value = txt;
  lineCount.value = txt ? txt.split('\n').length : 0;
  if (S.proj) S.proj.customJs = txt;
  stale.value = txt !== synced;
  if (stale.value) scheduleSave();
}

/* 保存 + 按最新代码重建插件渲染。
   运行会收起浮层（腾出画面看效果），所以先把要用的东西取到局部变量：
   组件随即卸载，之后只能靠全局状态和 toast 反馈结果。 */
async function run() {
  if (!S.proj || running.value) return;
  const pv = viewportApi.pluginPreview;
  if (!pv) { toast('渲染区还没就绪，稍等一下再试', true); return; }
  running.value = true;
  err.value = '';

  const edited = code.value;
  S.panel = null;

  try {
    await saveNow();
    const st = await pv.refresh();
    const bad = (st && st.ok === false && st.error)
      || (!st && S.previewStatus && S.previewStatus.ok === false && S.previewStatus.error)
      || '';
    if (bad) {
      toast('运行失败：' + bad, true);
      /* 失败时把面板叫回来，方便接着改（用户已经切到别的 tab 就不抢） */
      if (!S.panel) S.panel = 'code';
      return;
    }
    synced = edited;
    stale.value = false;
    toast('已按最新代码重新渲染');
  } catch (e) {
    const msg = e.message || String(e);
    err.value = msg;
    toast('运行失败：' + msg, true);
    if (!S.panel) S.panel = 'code';
  } finally {
    running.value = false;
  }
}

onMounted(async () => {
  await nextTick();
  view = new EditorView({
    state: EditorState.create({
      doc: '',
      extensions: [
        basicSetup,
        javascript(),
        keymap.of([runKey, tabKey]),
        EditorView.updateListener.of((u) => { if (u.docChanged) onDocChange(); }),
        lightTheme,
      ],
    }),
    parent: host.value,
  });
  lineCount.value = 0;
  load();
});

onBeforeUnmount(() => { if (view) { view.destroy(); view = null; } });

watch(() => S.proj && S.proj.id, load);
/* 切样式不重拉：plugin.js 不随样式变化（styles 由 project-config 在运行时注入），重拉只会打断编辑 */
/* 外部改了代码（MCP 写回 / 别的 tab 改配置）→ 重取；内容与编辑器一致就别动，避免打断输入 */
watch(() => S.proj && S.proj.customJs, (v) => {
  if (!view) return;
  if (String(v == null ? '' : v) === view.state.doc.toString()) return;
  load();
});
</script>

<template>
  <section class="tabpage code-page">
    <div class="code-head">
      <span class="code-file">plugin.js</span>
      <span class="code-meta">{{ lineCount }} 行<span v-if="manifest"> · v{{ manifest.version }} · {{ manifest.kind }}<template v-if="manifest.type">/{{ manifest.type }}</template></span></span>
      <span v-if="stale" class="code-badge stale">未运行</span>
      <span class="spacer"></span>
      <button class="code-btn run" :disabled="running || loading" title="保存并按最新代码重建渲染（⌘/Ctrl + Enter）" @click="run">{{ running ? '运行中…' : '运行 ▶' }}</button>
    </div>

    <div v-if="err" class="code-err">{{ err }}</div>
    <div v-if="!loading && !code" class="code-note">
      代码是空的 —— 用 MCP（studio_write_code）让 AI 生成，或直接在编辑器里写。
    </div>

    <div ref="host" class="code-cm"></div>

    <div class="code-foot">
      可直接编辑，改动自动保存；⌘/Ctrl + Enter 或点「运行 ▶」重建渲染。
    </div>
  </section>
</template>
