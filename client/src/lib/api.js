/* 与 studio 服务端的 HTTP 封装，以及视口组件注册进来的能力对象。
 * 两者都是非响应式的普通模块级对象：viewportApi 里会挂 three 场景 / 引擎实例，
 * 绝不能放进 Pinia 的 reactive state（会破坏 Object3D 身份与 instanceof）。 */

export async function api(method, url, body, raw) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    if (raw) { opt.body = body; opt.headers['Content-Type'] = 'application/octet-stream'; }
    else { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  }
  const r = await fetch(url, opt);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

/* 视口组件注册进来的能力（地面/归零等需要 three 场景） */
export const viewportApi = {};
