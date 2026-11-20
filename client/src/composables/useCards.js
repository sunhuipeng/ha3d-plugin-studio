/*
 * composables/useCards.js — 卡片预览的响应式装配层（studio 单实例版）
 *
 * 与 home 的 useCards 不同：studio 一次只预览一个插件，没有楼层 / 房间 / 全屋
 * 三种选中态，也不接 HA。这里只做两件事：
 *   1) 结构树 tree：随「代码重载 / 样式重生」重建（rebuild() 手动推 structVersion）
 *   2) 值树 view：随 mock 实体状态变化重算（ui.entityVersion，由 mock-ha 广播驱动）
 *
 * ⚠ 只读展示：components/common/cards/ 下的卡片组件全部是纯渲染 —— 不 emit act、
 *   不接输入事件、不调 HA；页面壳（PluginStage）也没有 @act 监听。
 *   home 那份 useCards 的 run() / HA.callService 链路在这里刻意不实现。
 *
 * 入参 getPreview 是 getter（() => PluginPreview 实例），因为 PluginPreview
 * 是 ThreeHost / 引擎侧的非响应式对象，绝不能塞进 Pinia 或 reactive state。
 */
import { computed, ref } from 'vue';
import { useUiStore } from '../stores/ui';
import { CardEngine } from '../engine/cards.js';

/* 卡头图标：与启动页 / 属性面板的设备类型同一套语义，取不到就用兜底 */
const ICONS = {
  light: '💡', switch: '🔘', fan: '🌀', cover: '🪟', climate: '❄️',
  water_heater: '🚿', media_player: '🔊', vacuum: '🤖', camera: '📷',
  sensor: '📡', binary_sensor: '📡', door: '🚪', window: '🪟', other: '📦',
};
const BLANK_POWER = { clickable: false, on: false, words: ['开', '关'], readonly: true };

export function useCards(getPreview) {
  const ui = useUiStore();
  /* 结构重建信号：load() / respawn() 成功后 ++。值变化不碰它，
     否则滑块拖到一半会被卸载、本地 draft 丢失（home 踩过这个坑）。 */
  const structVersion = ref(0);

  /* 属性签名：cards() 的 require 过滤发生在**结构层**（normalizeNode），不是值层。
     mock 里后注入 attributes 时（如 studio_set_entity 推 percentage / oscillating），
     只刷新值树不会让被过滤的控件出现；但每次状态推送都重建结构又会打断滑块输入。
     所以只把「实体 id + friendly_name + 属性键集合」做成签名：属性新增/删除或改名才重建，
     普通数值变化签名不变，结构稳定。 */
  const attrSig = computed(() => {
    void ui.entityVersion;
    const pv = getPreview();
    if (!pv || !pv.ha) return '';
    return (pv.ha.list() || []).map((e) => [
      e.entityId,
      (e.attributes && e.attributes.friendly_name) || '',
      Object.keys(e.attributes || {}).sort().join(','),
    ].join(':')).join('|');
  });

  const tree = computed(() => {
    void structVersion.value;
    void attrSig.value;
    const pv = getPreview();
    if (!pv || !pv.cardAvailable || !pv.cardAvailable()) return null;
    const card = pv.buildCard();
    if (!card) return null;
    return CardEngine.buildListCard({
      title: card.title,
      icon: ICONS[card._type] || '📦',
      cards: [card],
      single: true,
      ready: true,
    });
  });

  /* 值树：HA 侧是原地改 entity 对象，这里 mock-ha 也是原地改，
     所以必须靠版本号驱动 decorate() 生成浅拷贝，Vue 才能 diff 出变化。 */
  const view = computed(() => {
    void ui.entityVersion;
    const t = tree.value;
    const pv = getPreview();
    if (!t || !pv) return null;
    return CardEngine.decorate(t, {
      getState: (eid) => pv.ha.getState(eid),
      isOn: (eid) => pv.isOnOf(eid),
    });
  });

  /* 标题电源开关的注入数据：随状态刷新（CardPowerToggle 不读全局、不读 store） */
  const power = computed(() => {
    void ui.entityVersion;
    const pv = getPreview();
    if (!pv || !pv.cardAvailable || !pv.cardAvailable()) return { ...BLANK_POWER };
    return pv.cardPower();
  });

  return {
    view,
    power,
    /* 结构版本号直接当 CardView 的 key：切插件 / 换样式时整卡重建，
       避免 DOM 复用导致「标题变了、内容还是上一个插件的」（home 踩过这个坑）。 */
    cardKey: computed(() => structVersion.value),
    rebuild() { structVersion.value++; },
  };
}
