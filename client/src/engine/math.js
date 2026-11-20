/* 引擎侧公共小工具（three-host / plan-draw / plugin-preview 共用） */

/** 数值夹取：v 限制在 [lo, hi] */
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
