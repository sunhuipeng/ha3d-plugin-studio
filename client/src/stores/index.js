/* Pinia 全局状态的统一入口
 *
 * 三个 Store 按职责分工：
 *   useProjectStore  项目数据 / 编辑态 / 引擎镜像 / 保存 / 漂移 / 发布
 *   useUiStore       界面态 / toast / 锁 / MCP 横条 / 预览高亮
 *   useAssetsStore   模型文件库 / 家具分类目录
 *
 * S 与 act 是「兼容视图」：它们不持有任何状态，只把旧的 S.xxx / act.xxx 读写转发到
 * 对应的 Store。这样 20 个既有消费文件（含 ws-client.js 这种非组件模块）无需大改，
 * 而状态的唯一事实源、派生、写入口全部落在 Pinia 里（devtools / $subscribe / HMR 可用）。
 * 组件推荐用 useStudio() 显式接入，并优先直接读 Store 的 getter、调 Store 的 Action。
 */
import { useProjectStore } from './project';
import { useUiStore } from './ui';
import { useAssetsStore } from './assets';
import { api, viewportApi } from '../lib/api';
import * as constants from '../lib/constants';
import { routeFromHash } from '../lib/route-core';

const STORE_ORDER = ['project', 'ui', 'assets'];

function allStores() {
  return {
    project: useProjectStore(),
    ui: useUiStore(),
    assets: useAssetsStore(),
  };
}

function storeOf(key, stores) {
  for (const name of STORE_ORDER) {
    if (key in stores[name]) return stores[name];
  }
  return null;
}

/* ---- S：兼容全局状态视图（读 = getter/state，写 = 直接写 Store 的 state） ---- */
export const S = new Proxy({}, {
  get(_, key) {
    if (typeof key === 'symbol') return undefined;
    const stores = allStores();
    const st = storeOf(key, stores);
    return st ? st[key] : undefined;
  },
  set(_, key, value) {
    if (typeof key === 'symbol') return false;
    const stores = allStores();
    const st = storeOf(key, stores);
    if (st) st[key] = value;
    else stores.project[key] = value;   // 历史代码临时挂字段：不抛错，也不假装是响应式状态
    return true;
  },
  has(_, key) {
    if (typeof key === 'symbol') return false;
    return !!storeOf(key, allStores());
  },
  ownKeys() {
    const stores = allStores();
    const keys = new Set();
    for (const name of STORE_ORDER) {
      for (const k of Object.keys(stores[name].$state)) keys.add(k);
    }
    return [...keys];
  },
  getOwnPropertyDescriptor(_, key) {
    if (typeof key === 'symbol' || !storeOf(key, allStores())) return undefined;
    return { configurable: true, enumerable: true, writable: true, value: undefined };
  },
});

/* ---- act：兼容动作门面（按方法名在三个 Store 中查找并绑定 Action） ---- */
export const act = new Proxy({}, {
  get(_, key) {
    if (typeof key === 'symbol') return undefined;
    const stores = allStores();
    for (const name of STORE_ORDER) {
      const st = stores[name];
      if (typeof st[key] === 'function') return st[key].bind(st);
    }
    /* catalogItems 从「act 里的方法」变成了 project 的 getter，保留旧调用形态 */
    if (key === 'catalogItems') return () => stores.project.catalogItems;
    return undefined;
  },
  has(_, key) {
    if (typeof key === 'symbol') return false;
    const stores = allStores();
    return STORE_ORDER.some((name) => typeof stores[name][key] === 'function') || key === 'catalogItems';
  },
});

/* ---- 旧版散装函数：签名不变，内部一律转调 Store 的 Action / getter ---- */
export function toast(msg, err = false) { return useUiStore().showToast(msg, err); }
export function bigToast(title, detail = '') { return useUiStore().showBigToast(title, detail); }
export function applyLock(st) { return useUiStore().applyLock(st); }
export function lockByText() { return useUiStore().lockByText; }
export function engineList() { return useProjectStore().engineList; }
export function engineFieldList() { return useProjectStore().fieldList; }
export function curStyle() { return useProjectStore().curStyle; }
export function scheduleSave() { return useProjectStore().scheduleSave(); }
export function saveNow(opts) { return useProjectStore().saveNow(opts); }
export function cancelPendingSave() { return useProjectStore().cancelPendingSave(); }
export function syncEngineMirror(preview) { return useProjectStore().syncEngineMirror(preview); }

/* ---- hash 路由编排：只负责把 URL 状态同步到 Store ---- */
async function syncRoute() {
  const id = routeFromHash();
  const project = useProjectStore();
  const ui = useUiStore();
  if (id) {
    if (ui.view !== 'editor' || !project.proj || project.proj.id !== id) await project.openProject(id);
  } else if (ui.view === 'editor') {
    await project.goHome();
  }
}

export function initRoute() {
  window.addEventListener('hashchange', () => { syncRoute().catch((e) => toast(e.message, true)); });
  return syncRoute().catch((e) => toast(e.message, true));
}

/* ---- 点击「模型文件库」列表项以外任意位置 → 取消预览高亮（全局只装一次） ---- */
let guardsInstalled = false;
export function installUiGuards() {
  if (guardsInstalled || typeof document === 'undefined') return;
  guardsInstalled = true;
  document.addEventListener('pointerdown', (e) => { useUiStore().clearPreviewOutside(e); }, true);
}

/* ---- 组件接入点：<script setup> 里 const { S, act, project, ui, assets } = useStudio() ----
 * 返回的 S / act 是上面的兼容视图，ui/project/assets 是真正的 Pinia Store 实例，
 * 组件可以逐步把 S.xxx 换成 getter、把 act.xxx 换成 Action，不需要一次性改完模板。 */
export function useStudio() {
  const stores = allStores();
  return {
    ...stores,
    S,
    act,
    api,
    viewportApi,
    ...constants,
    toast, bigToast, applyLock, lockByText,
    engineList, engineFieldList, curStyle,
    scheduleSave, saveNow, cancelPendingSave, syncEngineMirror,
    initRoute,
  };
}
