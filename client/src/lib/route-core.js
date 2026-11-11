/* hash 路由的纯函数部分：#/ = 启动页，#/project/<id> = 编辑页（刷新/直链不丢状态）。
 * 不依赖任何 store，供 project store 的 Action 与 stores/index.js 的路由编排共用。 */
export function syncHash(id) {
  const h = id ? '#/project/' + id : '#/';
  if (location.hash !== h) location.hash = h;
}

export function routeFromHash() {
  const m = /^#\/project\/([A-Za-z0-9_-]+)/.exec(location.hash);
  return m ? m[1] : null;
}
