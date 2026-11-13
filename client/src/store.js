/* 兼容门面 —— 全局状态已迁移到 Pinia（见 ./stores/）。
 *
 * 这个文件不再持有任何状态：所有导出都转发到三个 Store。
 * 保留它是为了让 ws-client.js 与既有组件以原来的 import 路径继续工作，
 * 同时让状态拥有唯一事实源、派生 getter、可追溯 Action 与 devtools/HMR 支持。
 *
 * 新代码请直接用：
 *   import { useStudio } from './stores';          // 组件
 *   const { project, ui, assets } = useStudio();   // 或单独 import 某个 Store
 */
export {
  DEVICE_TYPES, WALL_TYPES, FURN_TYPES, OPENING_TYPES, MODEL_TYPES, isWallType, isFurnType,
  OPTION_TYPES, ENTITY_DOMAINS,
} from './lib/constants';

export { api, viewportApi } from './lib/api';

export {
  S, act,
  toast, bigToast, applyLock, lockByText,
  engineList, engineFieldList, curStyle,
  scheduleSave, saveNow, cancelPendingSave, syncEngineMirror,
  initRoute,
} from './stores/index';
