<script setup>
/* 右上角 2D 平面预览
 *
 * 显示的线稿 100% 来自插件自己声明的 plan2d(c, p)：
 * 引擎负责调用（planOf 会合并样式参数），这里只把返回的线画到卡片上。
 * 静态绘制：渲染出插件、实体状态变化、样式参数切换时才重画一次，没有逐帧动画。
 */
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { useStudio } from '../stores';
const { S, viewportApi, ui } = useStudio();
import { drawPlan, drawPlanEmpty } from '../engine/plan-draw';

const cv = ref(null);
const box = ref(null);
const hasPlan = ref(null);   // null=还没跑出插件 / true=插件有 plan2d / false=没实现
let ro = null;
let subOff = null;     // mock-ha 状态订阅
let subPv = null;      // 当前订阅的 preview 实例
let raf = 0;

function pvOf() {
  const api = viewportApi.pluginPreview;
  return (api && typeof api.getPreview === 'function' && api.getPreview()) || null;
}

/* 状态变化订阅：setEntity 之后 mock-ha 会广播，这里重画一次线稿 */
function ensureSub() {
  const pv = pvOf();
  if (!pv || pv === subPv) return;
  if (subOff) { try { subOff(); } catch (e) { /* ignore */ } }
  subPv = pv;
  subOff = pv.ha ? pv.ha.on(() => schedule()) : null;
}

function paint() {
  const el = cv.value;
  if (!el) return;
  ensureSub();
  const pv = pvOf();
  hasPlan.value = pv && typeof pv.hasPlan2d === 'function' ? !!pv.hasPlan2d() : null;
  let ok = false;
  try { ok = drawPlan(el, pv); } catch (e) { ok = false; }
  if (!ok) drawPlanEmpty(el);
}

function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; paint(); });
}

onMounted(() => {
  paint();
  if (typeof ResizeObserver !== 'undefined' && box.value) {
    ro = new ResizeObserver(() => schedule());
    ro.observe(box.value);
  }
});

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  if (ro) { try { ro.disconnect(); } catch (e) { /* ignore */ } }
  if (subOff) { try { subOff(); } catch (e) { /* ignore */ } }
  subOff = null;
  subPv = null;
});

/* 每次「运行 / 重建预览 / 改实体」都会刷新 previewStatus → 重画 */
watch(() => ui.previewStatus, () => schedule());
watch(() => S.styleId, () => schedule());
</script>

<template>
  <div ref="box" class="plan-inset" title="插件 plan2d() 画的 2D 平面线稿（开=暖色填充 / 关=白）">
    <div class="plan-head">
      <span>平面预览</span>
      <span class="plan-sub" :class="{ warn: hasPlan === false }">{{
        hasPlan === null ? '等待渲染' : hasPlan ? 'plan2d' : '未实现 plan2d'
      }}</span>
    </div>
    <canvas ref="cv"></canvas>
  </div>
</template>
