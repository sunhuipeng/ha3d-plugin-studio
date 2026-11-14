/* 模拟实体状态（替代真实 HA）
 *
 * 插件引擎里所有状态读取都走这一层：
 *   ctx.getState(eid) / ctx.isOn(eid) / ctx.fieldNum(key) …
 * 预览时没有真实 HA，这里用一张内存表顶上，MCP 可通过 studio_set_entity 改值，
 * 改完广播 change → 引擎 updateAll() → 插件 update() → 画面跟着变。
 */

/* 各域「关」的默认值：二态域用 off，其余给一个中性的 0 */
const DOMAIN_DEFAULTS = {
  light: { state: 'off', attributes: { friendly_name: '预览灯' } },
  switch: { state: 'off', attributes: { friendly_name: '预览开关' } },
  fan: { state: 'off', attributes: { friendly_name: '预览风扇' } },
  cover: { state: 'closed', attributes: { friendly_name: '预览窗帘', current_position: 0 } },
  climate: { state: 'off', attributes: { friendly_name: '预览空调', temperature: 26 } },
  water_heater: { state: 'off', attributes: { friendly_name: '预览热水器', temperature: 45 } },
  media_player: { state: 'off', attributes: { friendly_name: '预览音箱', volume_level: 0.3 } },
  vacuum: { state: 'docked', attributes: { friendly_name: '预览扫地机' } },
  camera: { state: 'idle', attributes: { friendly_name: '预览摄像头' } },
  binary_sensor: { state: 'off', attributes: { friendly_name: '预览门磁', device_class: 'door' } },
  sensor: { state: '0', attributes: { friendly_name: '预览传感器', unit_of_measurement: '' } },
  /* 数值域：min/max/step 给 cards() 的 'attr:min' / 'attr:max' / 'attr:step' 用。
     缺了它们，倒计时这类 range 卡片只能回退 0/100/1，滑块范围看着就不对。
     字段面板写的 attributes YAML 会覆盖这些默认值。 */
  'input_number': { state: '0', attributes: { friendly_name: '预览数值', min: 0, max: 120, step: 1, unit_of_measurement: 'min' } },
  counter: { state: '0', attributes: { friendly_name: '预览计数器', unit_of_measurement: '' } },
  /* 背景插件 onData 常用：天气实体给一个可直接用于「晴 / 雨」判定的初始状态 */
  weather: { state: 'sunny', attributes: { friendly_name: '预览天气', temperature: 22, humidity: 50 } },
  number: { state: '0', attributes: { friendly_name: '预览数值' } },
  select: { state: 'auto', attributes: { friendly_name: '预览选择' } },
  lock: { state: 'locked', attributes: { friendly_name: '预览门锁' } },
  humidifier: { state: 'off', attributes: { friendly_name: '预览加湿器' } },
  button: { state: 'unknown', attributes: { friendly_name: '预览按钮' } },
};

export function domainOf(eid) {
  const s = String(eid || '');
  const i = s.indexOf('.');
  return i > 0 ? s.slice(0, i) : 'sensor';
}

export function createMockHa() {
  const states = new Map();
  const listeners = new Set();
  const now = () => new Date().toISOString();

  function emit() {
    for (const fn of [...listeners]) {
      try { fn(); } catch (e) { /* 单个监听器出错不影响其它 */ }
    }
  }

  const api = {
    /** 建一个实体（已存在则覆盖为给定值） */
    define(eid, state, attributes) {
      const dft = DOMAIN_DEFAULTS[domainOf(eid)] || { state: 'off', attributes: {} };
      const st = {
        entity_id: eid,
        state: state != null ? String(state) : dft.state,
        attributes: Object.assign({ friendly_name: eid }, dft.attributes, attributes || {}),
        last_changed: now(),
      };
      states.set(eid, st);
      return st;
    },

    /** 改状态；实体不存在则先建。返回新状态对象 */
    setState(eid, state, attributes) {
      const cur = states.get(eid);
      if (!cur) {
        const st = api.define(eid, state, attributes);
        emit();
        return st;
      }
      if (state != null) cur.state = String(state);
      if (attributes) cur.attributes = Object.assign({}, cur.attributes, attributes);
      cur.last_changed = now();
      emit();
      return cur;
    },

    getState(eid) { return eid ? states.get(eid) : undefined; },
    has(eid) { return states.has(eid); },

    /* 与 HA 的 is_on 一致：只有 on/open/opening/true 算「开」。
       不能用「不是 off 就算 on」——数值实体（'0'、'50'）会被误判成开 */
    isOn(eid) {
      const st = states.get(eid);
      if (!st) return false;
      const s = st.state;
      return s === 'on' || s === 'open' || s === 'opening' || s === 'true';
    },

    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit,

    unitOf(st) {
      return (st && st.attributes && st.attributes.unit_of_measurement) || '';
    },

    /** 供 UI / MCP 列出全部实体 */
    list() {
      return [...states.values()].map((st) => ({
        entityId: st.entity_id,
        domain: domainOf(st.entity_id),
        state: st.state,
        name: st.attributes.friendly_name || st.entity_id,
        unit: api.unitOf(st),
        attributes: st.attributes,
      }));
    },

    /* 清空实体表；监听器由使用方持有，不在这里一并清掉（否则重新预览后状态变化不再触发重绘） */
    reset() { states.clear(); },
  };

  return api;
}

/* 依项目字段推断一个合理的实体 id（预览用，不需要真实存在） */
export function guessEntityId(key, domains, fallbackDomain) {
  const dom = (Array.isArray(domains) && domains[0]) || fallbackDomain || 'sensor';
  const slug = String(key || 'main')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .toLowerCase()
    .replace(/^_|_$/g, '') || 'main';
  return dom + '.preview_' + slug;
}
