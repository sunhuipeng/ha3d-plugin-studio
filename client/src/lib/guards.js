/* 配置锁的统一写入拦截（UI 只读之外的双保险）。
 * 锁的状态与提示都在 Pinia 的 ui store 里，这里只保留「节流时间戳」这种非响应式模块状态。 */
import { useUiStore } from '../stores/ui';

let lockTipAt = 0;

export function denyWhenLocked() {
  const ui = useUiStore();
  if (!ui.isLocked) return false;
  if (Date.now() - lockTipAt > 2500) {
    lockTipAt = Date.now();
    ui.showToast('配置已锁定（' + ui.lockByText + '正在改）：左侧面板只读，解锁后才能编辑', true);
  }
  return true;
}
