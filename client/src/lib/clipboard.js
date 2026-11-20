/* 剪贴板写入：全站唯一出处。
 *
 * navigator.clipboard 只在安全上下文（https / localhost）可用，用局域网 IP 走 http
 * 打开 studio 时没有这个 API —— 退化成隐藏 textarea + execCommand('copy')。
 * 返回是否真的复制成功，让调用方决定成功 / 失败提示（别再静默报「已复制」）。
 *
 * 调用方：
 *   components/common/ProjectTitle.vue  → 顶栏点击复制项目 id
 *   components/Home.vue                 → 启动页复制 MCP 接入配置
 */
export async function copyText(text) {
  const value = String(text == null ? '' : text);
  if (!value) return false;
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (e) { /* 权限被拒 / API 异常 → 落到 execCommand 兜底 */ }

  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = !!document.execCommand('copy'); } catch (e) { /* 浏览器禁用复制命令 */ }
  ta.remove();
  return ok;
}
