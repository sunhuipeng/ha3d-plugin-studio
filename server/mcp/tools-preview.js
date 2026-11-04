/* 预览/验证域工具：set_style / set_option / click / label / reload / view / screenshot / set_entity / get_runtime
 * 全部经 ws-hub 中继到浏览器前端 harness 执行，依赖编辑页开着 */
'use strict';

const { z } = require('zod');
const { readProject } = require('../config');
const { normalizeOptionType } = require('../option-schema');
const hub = require('../ws-hub');
const H = require('./helpers');

function register(server) {
  server.tool(
    'studio_set_style',
    '切换预览样式：前端立即清空旧渲染并用新样式重建 3D（styleId 见 studio_get_project），返回渲染结果（当前样式 / 实例参数 / 实体）',
    {
      projectId: z.string().optional(),
      styleId: z.string().min(1).describe('要切换到的样式 id（插件内部 id，如 single_door / roller_shutter）'),
    },
    async ({ projectId, styleId }) => {
      try {
        const pid = H.requirePid(projectId);
        const p = readProject(pid);
        if (!(p.styles || []).some((s) => s && s.id === styleId)) {
          throw new Error('样式不存在: ' + styleId + '（可用 studio_get_project 查）');
        }
        return H.text(await hub.call(pid, 'set_style', { styleId }, 60000));
      } catch (e) { return H.fail(e.message); }
    },
  );

  server.tool(
    'studio_set_option',
    '样式参数调节（AI 自动核验用）：把某个样式参数的值改成指定值（写 styles[].options[].def = 面板滑条上的那个值）→ 前端重跑代码出图，返回改前/改后的值 + 引擎实际吃到的 ctx.options。不传 key 时只读当前样式的全部参数值。改完接 studio_screenshot 对比效果，核验完记得调回原值',
    {
      projectId: z.string().optional(),
      styleId: z.string().optional().describe('要改哪个样式（缺省 = 编辑页当前选中的样式）'),
      key: z.string().optional().describe('参数 key，如 brightness / hand；不传 = 只读参数值'),
      value: z.union([z.number(), z.string(), z.boolean()]).optional()
        .describe('新值：range/number 传数字（会按 min/max 夹取），checkbox 传 true/false，select/text 传字符串'),
    },
    async ({ projectId, styleId, key, value }) => {
      try {
        const pid = H.requirePid(projectId);
        const p = readProject(pid);
        const styles = (p.styles || []).filter((s) => s && s.id);
        if (!styles.length) throw new Error('项目没有任何样式（先在面板里建一个样式）');
        const pick = styleId ? styles.find((s) => s.id === styleId) : null;
        if (styleId && !pick) throw new Error('样式不存在: ' + styleId + '（可用 studio_get_project 查）');

        /* 只读：直接读盘上的 def（等价于面板上显示的当前值），不需要前端在线 */
        if (!key) {
          const rows = (pick ? [pick] : styles).map((s) => ({
            styleId: s.id,
            options: (s.options || []).filter((o) => o && o.key).map((o) => ({
              key: o.key, label: o.label || o.key, type: normalizeOptionType(o.type), value: o.def,
            })),
          }));
          return H.text({ projectId: pid, readOnly: true, styles: rows, current: pick ? pick.id : (styles[0] && styles[0].id) });
        }
        if (value === undefined) throw new Error('改参数要同时传 value；只想看当前值就别传 key');

        const hit = (pick ? [pick] : styles)
          .find((s) => (s.options || []).some((o) => o && o.key === key));
        if (!hit) {
          const all = [...new Set(styles.flatMap((s) => (s.options || []).map((o) => o && o.key)).filter(Boolean))];
          throw new Error(`参数不存在: ${key}（项目里可用的参数：${all.join(', ') || '无'}）`);
        }
        return H.text(await hub.call(pid, 'set_option', { styleId: pick ? pick.id : undefined, key, value }, 60000));
      } catch (e) { return H.fail(e.message); }
    },
  );

  server.tool(
    'studio_click',
    '点击设备（等价于在页面上点设备主体或它的状态标签）：按插件 click 配置把主实体状态切换（on↔off / 服务动作）→ 插件 update() 重绘。先用 studio_label 看当前文案，点完再 screenshot 验证变化',
    { projectId: z.string().optional() },
    async ({ projectId }) => {
      try {
        const pid = H.requirePid(projectId);
        return H.text(await hub.call(pid, 'click', {}, 30000));
      } catch (e) { return H.fail(e.message); }
    },
  );

  server.tool(
    'studio_label',
    '读取设备标签当前状态：主实体 id、标签文案（插件 stateText 的结果）、是否可点击、当前是否开启。点击前先看一眼',
    { projectId: z.string().optional() },
    async ({ projectId }) => {
      try {
        const pid = H.requirePid(projectId);
        return H.text(await hub.call(pid, 'label', {}, 30000));
      } catch (e) { return H.fail(e.message); }
    },
  );

  server.tool(
    'studio_reload',
    '让打开的编辑页重新加载：前端代码重新构建后（或要重置预览状态时）调用，浏览器会拉取最新 bundle，免手动 F5。页面会断开 WS 重连，属正常现象',
    { projectId: z.string().optional() },
    async ({ projectId }) => {
      try {
        const pid = H.requirePid(projectId);
        return H.text(await hub.call(pid, 'reload', {}, 15000));
      } catch (e) { return H.fail(e.message); }
    },
  );

  server.tool(
    'studio_view',
    '只调整观看方式、不出图：转模型 / 移模型 / 归位，或转相机 / 平移 / 缩放。排查问题时先用它把姿态摆到看得清的位置，再调 studio_screenshot 按角度拍',
    {
      projectId: z.string().optional(),
      /* 模型整体姿态（排查时最常用） */
      modelRotate: z.array(z.number()).length(3).optional().describe('模型整体旋转 [rx,ry,rz]（度，累加）'),
      modelMove: z.array(z.number()).length(3).optional().describe('模型整体位移 [x,y,z]（米，累加）'),
      modelSet: z.object({
        rx: z.number().optional(), ry: z.number().optional(), rz: z.number().optional(),
        x: z.number().optional(), y: z.number().optional(), z: z.number().optional(),
      }).optional().describe('模型绝对姿态（覆盖，不累加）'),
      modelReset: z.boolean().optional().describe('模型姿态归位'),
      /* 相机 */
      view: z.enum(H.SCREEN_VIEWS).optional().describe('切到某个预设视角'),
      azimuth: z.number().optional().describe('绝对方位角（度，0 = 从 +Z 看）'),
      elevation: z.number().optional().describe('绝对俯仰角（度，0 = 平视，90 = 正上方）'),
      distance: z.number().optional().describe('相机到目标的距离（米）'),
      zoom: z.number().optional().describe('距离系数（0.5 更近，2 更远）'),
      target: z.array(z.number()).length(3).optional().describe('观察目标点 [x,y,z]'),
      orbitAzimuth: z.number().optional().describe('相对当前水平旋转（度，正值向右）'),
      orbitElevation: z.number().optional().describe('相对当前俯仰旋转（度，正值向上）'),
      panX: z.number().optional().describe('水平平移（视口宽度比例，0.1 = 右移 10%）'),
      panY: z.number().optional().describe('垂直平移（视口高度比例）'),
      zoomFactor: z.number().optional().describe('相对缩放（>1 拉远，<1 拉近）'),
    },
    async (args) => {
      try {
        const pid = H.requirePid(args.projectId);
        const { projectId, ...rest } = args;
        return H.text(await hub.call(pid, 'view', rest, 30000));
      } catch (e) { return H.fail(e.message); }
    },
  );

  server.tool(
    'studio_screenshot',
    '截图返回 PNG：默认截插件引擎的真实渲染结果。可指定视角预设、绝对机位、相对旋转/平移/缩放，也可以先把模型整体转一下再拍',
    {
      projectId: z.string().optional(),
      view: z.enum(H.SCREEN_VIEWS).optional().describe('视角预设：iso(四分之三) / front / back / left / right / top / low(低角) / detail(特写)'),
      azimuth: z.number().optional().describe('绝对方位角（度，0 = 从 +Z 看）'),
      elevation: z.number().optional().describe('绝对俯仰角（度，0 = 平视，90 = 正上方）'),
      distance: z.number().optional().describe('相机到目标距离（米）'),
      zoom: z.number().optional().describe('距离系数（0.5 更近，2 更远）'),
      target: z.array(z.number()).length(3).optional().describe('观察目标点 [x,y,z]'),
      orbitAzimuth: z.number().optional().describe('相对当前水平旋转（度，正值向右）'),
      orbitElevation: z.number().optional().describe('相对当前俯仰旋转（度，正值向上）'),
      panX: z.number().optional().describe('水平平移（视口宽度比例，0.1 = 右移 10%）'),
      panY: z.number().optional().describe('垂直平移（视口高度比例）'),
      zoomFactor: z.number().optional().describe('相对缩放（>1 拉远，<1 拉近）'),
      modelRotate: z.array(z.number()).length(3).optional().describe('模型整体旋转 [rx,ry,rz]（度，累加）'),
      modelMove: z.array(z.number()).length(3).optional().describe('模型整体位移 [x,y,z]（米，累加）'),
      modelSet: z.object({
        rx: z.number().optional(), ry: z.number().optional(), rz: z.number().optional(),
        x: z.number().optional(), y: z.number().optional(), z: z.number().optional(),
      }).optional().describe('模型绝对姿态（覆盖，不累加）'),
      modelReset: z.boolean().optional().describe('先把模型姿态归位再拍'),
      width: z.number().int().min(64).max(2048).optional(),
      height: z.number().int().min(64).max(2048).optional(),
      withGrid: z.boolean().optional().describe('是否显示地面网格'),
      background: z.number().int().optional().describe('背景色（0xRRGGBB 十进制），-1 = 透明'),
    },
    async (args) => {
      try {
        const pid = H.requirePid(args.projectId);
        const { projectId, ...rest } = args;
        const r = await hub.call(pid, 'screenshot', rest, 60000);
        const b64 = String(r?.dataUrl || '').replace(/^data:image\/png;base64,/, '');
        if (!b64) return H.fail('前端未返回截图');
        return {
          content: [
            { type: 'image', data: b64, mimeType: 'image/png' },
            { type: 'text', text: JSON.stringify({ projectId: pid, preview: r.preview }) },
          ],
        };
      } catch (e) { return H.fail(e.message); }
    },
  );

  /* ---------------- 验状态变化 ---------------- */

  server.tool(
    'studio_set_entity',
    '给某个绑定实体推一个新状态（模拟 HA），触发插件 update/重绘，用来验证「状态变化 → 造型变化」是否符合预期。实体 id 就在插件代码的 getState/fields 里',
    {
      projectId: z.string().optional(),
      entityId: z.string().describe('实体 id，如 binary_sensor.preview_main'),
      state: z.string().describe("新状态，如 'on' / 'off' / 'open' / '25'"),
      attributes: z.record(z.any()).optional().describe('可选，覆盖属性（如 unit_of_measurement）'),
    },
    async ({ projectId, entityId, state, attributes }) => {
      try {
        const pid = H.requirePid(projectId);
        return H.text(await hub.call(pid, 'set_entity', { entityId, state, attributes }, 25000));
      } catch (e) { return H.fail(e.message); }
    },
  );

  /* ---------------- 运行期体检 ---------------- */
  server.tool(
    'studio_get_runtime',
    '运行期体检：返回渲染状态（ok/错误/加载中）、当前项目与样式、当前样式参数实际取值、实体状态、模型包围盒、相机，以及浏览器控制台最近报错（插件的 update / plan2d / 动画帧里抛的异常都被引擎吞成 console.warn，只有这里能看到）。改完代码看不出变化、或画面空白时先调它',
    {
      projectId: z.string().optional(),
      level: z.enum(['all', 'error']).optional().describe('只取 error（含 warn）还是全部（默认 all：errors + warnings 分开返回）'),
      limit: z.number().optional().describe('日志条数上限（默认 30，最多 120）'),
      clear: z.boolean().optional().describe('读完顺手清空日志缓冲，方便下一轮只看新增报错'),
    },
    async ({ projectId, level, limit, clear }) => {
      try {
        const pid = H.requirePid(projectId);
        const st = await hub.call(pid, 'runtime', { level, limit, clear }, 25000);
        return H.text(st);
      } catch (e) {
        return H.fail(H.friendlyRelayError(e, '浏览器里的页面还是旧版本前端，请刷新编辑页后重试'));
      }
    },
  );
}

module.exports = { register };
