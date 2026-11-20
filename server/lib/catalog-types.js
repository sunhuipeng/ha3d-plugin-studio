/*
 * 家具分类枚举（唯一出处仍是 ha-3d-home 的 assets/catalog.json 的 types）
 *
 * studio 不直接读 home 的文件，而是请求 GET {home}/api/catalog 取 types；
 * home 没起来 / 超时就回落到 catalog-schema.js 的 FALLBACK_TYPES。
 * REST /api/catalog-types 与 MCP 的家具工具共用这一份，避免两处各写一套取值逻辑。
 */
'use strict';

const { remoteTarget } = require('./config');
const { FALLBACK_TYPES, TYPE_LABELS } = require('./catalog-schema');

function norm(list) {
  return (Array.isArray(list) ? list : []).map((t) => {
    if (t && typeof t === 'object') return { type: String(t.type || ''), name: String(t.name || t.type || '') };
    return { type: String(t || ''), name: String(t || '') };
  }).filter((t) => t.type);
}

function fallback() {
  return FALLBACK_TYPES.map((t) => ({ type: t, name: TYPE_LABELS[t] || t }));
}

async function resolveCatalogTypes(timeoutMs = 4000) {
  const remote = remoteTarget();
  if (remote.host) {
    try {
      const host = remote.host.replace(/\/+$/, '');
      const r = await fetch(host + '/api/catalog', { signal: AbortSignal.timeout(timeoutMs) });
      const d = await r.json().catch(() => ({}));
      const types = norm(d.types);
      if (r.ok && types.length) return { source: 'home', host, types, error: '' };
      return { source: 'fallback', host, types: fallback(), error: 'home 返回的 types 为空或请求失败' };
    } catch (e) {
      return { source: 'fallback', host: remote.host, types: fallback(), error: e.message };
    }
  }
  return { source: 'fallback', host: '', types: fallback(), error: '未配置 home 主机地址' };
}

/* 同步版：MCP 校验时不想等网络就用兜底表（列表工具会异步带上真实枚举） */
function fallbackTypes() {
  return FALLBACK_TYPES.slice();
}

module.exports = { resolveCatalogTypes, fallbackTypes };
