/* 打开项目时的归一化：老存档升级 + 缺省值补齐。纯函数，不依赖 Vue / Pinia。 */
import { normalizeOptionType, stripExtraOptionKeys } from '../option-schema';
import { normalizeField } from '../field-schema';
import { normalizeItem } from '../catalog';

export function normalize(proj) {
  proj.plugin ||= {};
  /* 插件 id 恒等于项目 id（安装目录 = custom/plugins/<项目id>，重复安装覆盖同一份） */
  proj.plugin.id = proj.id;
  proj.plugin.entityId ||= '';
  /* 插件名称 = 项目名称（项目名是唯一来源；老数据里改乱的在打开时自动对齐） */
  if (proj.name) proj.plugin.name = proj.name;
  /* 统一插件类迁移：门/窗原先的 kind:'opening' 已废除，改为 kind:'device' + type door/window。
     打开老项目时静默升级，代码里残留的 kind:'opening' 由引擎注册时归一 */
  if (proj.plugin.kind === 'opening') proj.plugin.kind = 'device';
  if (!proj.plugin.kind) proj.plugin.kind = 'device';
  /* 背景类没有实体类型（面板里 type 输入框是隐藏的）：值统一固定成 'bg' */
  if (proj.plugin.kind === 'background') proj.plugin.type = 'bg';
  /* 家具项目（kind:'catalog'）：结构与插件项目完全不同 —— 只有 catalog.items（一个 glb 一条），
   * 没有样式 / 字段 / 代码 / 选项。这里提前返回，别把插件那套默认值灌进去。 */
  if (proj.plugin.kind === 'catalog') {
    proj.catalog = (proj.catalog && typeof proj.catalog === 'object') ? proj.catalog : {};
    proj.catalog.items = (Array.isArray(proj.catalog.items) ? proj.catalog.items : [])
      .filter((x) => x && typeof x === 'object').map(normalizeItem);
    if (!proj.plugin.version) proj.plugin.version = '1.0.0';
    delete proj.snapshot;
    return proj;
  }
  proj.styles ||= [{ id: 'default', name: proj.plugin.name || '默认造型', z: 0, icon: '', desc: '', options: [] }];
  for (const s of proj.styles) {
    if (!Array.isArray(s.options)) s.options = [];
    for (const o of s.options) {
      /* type 归一化 + 按「类型 → 字段」表剔除不适用键（min/max/step/choices）：
       * 老存档里的历史脏数据（如非 range 参数带着 min/max）打开时即清掉 */
      if (!o || typeof o !== 'object') continue;
      o.type = normalizeOptionType(o.type);
      stripExtraOptionKeys(o, o.type);
      if (o.type === 'select' && !Array.isArray(o.choices)) o.choices = [];
    }
  }
  /* 字段是插件级实体绑定，所有样式共用一份 */
  proj.fields ||= [];
  for (const f of proj.fields) {
    if (typeof f.domains === 'string') f.domains = f.domains.split(/[\s,，]+/).filter(Boolean);
    if (!Array.isArray(f.domains)) f.domains = [];
    /* valueType / enumValues 是给人看和给 AI 读的说明（不参与渲染），缺省补成 text + 空数组 */
    normalizeField(f);
  }
  proj.customJs ||= '';
  /* 给 AI 的提示词（左侧「提示词」面板写，MCP studio_get_project 会带出去） */
  proj.aiPrompt ||= '';
  /* 配置快照不跟着项目对象走：它由 /snapshot 接口独占维护，前端保存时回写会覆盖 MCP 刚记的快照 */
  delete proj.snapshot;
  return proj;
}

/* 渲染成功后引擎内存里的字段清单也要归一，避免 Element Plus 把 undefined 当空串 */
export function normalizeEngineFields(fields) {
  (fields || []).forEach((f) => normalizeField(f));
  return fields;
}
