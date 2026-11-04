---
name: ha3d-plugin-dev
description: 在 ha3d-plugin-studio（3D 房屋设计工具的插件开发台，端口 8098）中用 MCP 全流程开发 3D 插件。五步流程：① 每次改动前必调 studio_get_project + studio_get_code 拉取最新项目信息与最新代码，核对属性/字段/样式/部件引用是否有变化（以最新信息为准）→ ② 只以参考项目 ha-3d-home 为唯一依据（README.md、PLUGIN-DEV.md、内置与自定义插件源码；资料不足时弹窗让用户补全）→ ③ 开发插件代码并提交，其中 styles 与 fields 必须从 studio_get_project 原样照抄、一个字都不改 → ④ 依次构造实体状态数据验证不同样式的动态效果并截图 → ⑤ 收尾汇报。触发词：开发插件、写插件、插件开发、修改插件、studio 插件、3D 插件、ha3d、门窗插件、背景插件、门缝/缝隙、模型尺寸对不上、分析 glb 模型。
agent_created: true
---

# ha3d-plugin-studio 插件开发流程

在 ha3d-plugin-studio 中开发一个 3D 插件（如门窗、设备），按「第 0 步环境检查 + 五步主流程」执行。MCP 工具完整清单见 `references/mcp-tools.md`；背景插件的 `house` / `safe` 用法规约见 `references/bg-house-safe.md`（写背景插件前必读）。

七条贯穿全程的硬规则：
1. **第 1 步（拉最新配置 + 最新代码并核对引用）在每次改动前都必须重跑**，不可跳过。
2. **`styles` / `fields` 以项目配置为准**：预览与安装端渲染时，引擎都会用 `studio_get_project` 返回的 styles / fields 覆盖代码里注册的同名字段（代码里那份只是「自带初始值」，不是权威）。所以代码里照抄一份便于阅读/导出即可，真正必须守住的是第 6 条。
3. **参考资料只认 `$HA3D_HOME`（ha-3d-home 源码目录）**（文档 + 源码 + 同类插件实现），其他来源一律不算依据（见第 2 步）。
4. **背景插件必须用足 `ctx.house` / `ctx.safe`**：构图基准只能从 `house` 推导，所有高出的体块与线性元素都要按 `safe` 避让，禁放区里不放任何不必要的东西（见 `references/bg-house-safe.md`，写背景插件前必读）。
5. **模型尺寸问题必须量数据，不许目测猜**：遇到门扇比门框窄、模型悬空/穿模、部件拼不上这类问题，先用 `studio_get_model` 把相关的 glb 导出到本机，解析出真实包围盒 / 顶点坐标（零部件各多大、洞口内径多少），再按数据算缩放，并在汇报里给出量到的数字。
6. **所有可调参数必须运行时读 `ctx.options.<key>`，禁止把值写死成常量**：面板和左下卡片调参能生效，靠的就是这一点（例：`const b = Number(ctx.options.brightness ?? 0.6)`）。写成 `const b = 0.6`，用户改参数画面不会有任何变化，属于返工项。
7. **配置快照是「代码 ↔ 配置」的对账基线**：`studio_get_project` 返回的 `snapshot.stale === true` 表示用户在快照之后改过属性 / 字段 / 样式 —— 这轮的本质就是「按新配置重写代码」，别只改无关代码。开发完成（代码已按当前配置对齐）后调 `studio_snapshot { label }` 记录新基线。发布 / 导出遇到漂移**只提醒、不阻断**，是否先重新生成由用户决定，不要擅自替用户发布或跳过提醒。

## 路径约定（开工前先确认这两个目录）

本文用两个变量指代目录，落地时换成你自己机器上的真实路径（可直接 export 到 shell 环境）：

| 变量 | 含义 | 默认 |
| --- | --- | --- |
| `$HA3D_STUDIO` | ha3d-plugin-studio 项目根（服务端 + 前端） | 本 skill 若放在 studio 仓库的 `skill/` 下，自动取仓库根 |
| `$HA3D_HOME` | 参考项目 ha-3d-home 源码目录（唯一参考基准） | `$HA3D_STUDIO/../ha-3d-home` |

`scripts/mcp-call.cjs` 会按「环境变量 `HA3D_STUDIO` → 本 skill 所属仓库根 → `~/WorkBuddy/home/ha3d-plugin-studio` → 当前目录」的顺序自动找 studio 根，找不到时才需要手动 `export HA3D_STUDIO=...`。

## 第 0 步：环境检查（开发前必做）

1. 探活：`curl -s --noproxy '*' -o /dev/null -w "%{http_code}" http://127.0.0.1:8098/`（本机必须加 `--noproxy '*'`）。
2. 不在线时到项目根目录后台启动：`cd "$HA3D_STUDIO" && node server/index.js`（日志 `/tmp/ha3d-studio.log`；入口是 `server/index.js` 不是 `server.js`）。
3. 前端中继类工具（`studio_write_code` 的立即运行、`studio_set_style`、`studio_set_option`、`studio_set_entity`、`studio_screenshot`）依赖浏览器打开着编辑页。若报「插件渲染区初始化超时」「不支持工具」，提醒用户打开或刷新编辑页（刷新后自动加载新构建）。
4. **页面停在哪可以先问 `studio_where`**：`page:'home'` = 启动页（没有打开任何项目，此时项目类工具会报「没有前端打开项目」，需先 `studio_open_project`）；`page:'project'` 会直接给出 `projectId`；`page:'none'` = 浏览器没开页面。
5. **开了多个标签页先收敛**：`studio_where` 的 `tabs` 有多个 `clientId` 时，先 `studio_single_window`（默认保留「有焦点 > 可见 > 最近连上」，可用 `keepClientId` 指定，先 `dryRun:true` 看会保留谁），否则截图 / 调参 / 写码可能落到不同标签页，看到的画面和代码对不上。收敛后多余标签页会自动断开中继并关闭；关不掉的会显示「本标签页已被 MCP 关闭」提示。

## 第 1 步：拉取最新项目信息 + 最新代码（任何改动前必做，无一例外）

**铁律**：只要要动 studio 的项目（改代码、加样式、调参数、修 bug），就必须在动手前**同时调用两个工具**拿服务端真身，**不允许**依赖上一轮对话里读过的信息、脑中的印象或本地缓存文件：

```bash
node <本skill目录>/scripts/mcp-call.cjs studio_get_project   # 最新项目配置
node <本skill目录>/scripts/mcp-call.cjs studio_get_code      # 最新已落盘的代码
```

两步可并行执行。`studio_get_project` 返回：`aiPrompt`（用户写的开发要求，**必须先读**）、`settings`（插件属性 id/kind/type 等）、`styles`（样式 + 参数 schema + icon）、`fields`（实体绑定 key 与候选域 domains）、`models`（可用 GLB 清单）、`snapshot`（配置快照对账：`stale` / `changeCount` / `summary`）。
`studio_get_code` 返回当前项目目录里真实的 plugin.js ——这是唯一可信的代码基线，**不要**用上次写过的那份代替（用户可能在面板里改过、也可能回滚过）。

### 1.1 引用核对（动手改之前必须做）

拿到最新代码后，逐项比对新旧信息，确认代码里引用的东西是否还成立：

| 核对项 | 检查代码里的 | 以 studio_get_project 的哪部分为准 |
| --- | --- | --- |
| 插件本体 | `register({ id, kind, type })` | `settings` |
| 实体绑定 | `ctx.getState('key')` 用的 key、fallback 实体名 | `fields[].key` 与 `fields[].domains` |
| 样式 | `styles[].id`、`styleOf`、样式分支里的 id 字符串、`options` 读取的 key | `styles[].id` / `styles[].options`（key、type、min/max、def） |
| 部件 / 模型 | `model3d` 里加载的 GLB 文件名、部件命名 | `models` 清单（文件名大小写敏感） |
| 提示词 | 与实现语义是否一致 | `aiPrompt` |
| 配置快照 | 本轮要不要按新配置重写代码 | `snapshot`：`stale:true` + `summary` 列出改动的属性 / 样式 / 字段 |

**判定规则**：
- 信息与代码一致 → 按原计划改。
- 有变化（字段 key 改名/删除、domains 换了、样式 id 或 options schema 改了、GLB 换了）→ **一律以 `studio_get_project` 的最新信息为准**，先把代码里对应引用改成新值（仅限逻辑代码里的引用；schema 本身按下一行原样搬用），缺失的引用补兜底避免 `getState` 拿到 undefined，再开始开发；并在最终汇报里列出不一致点。
- 最新配置本身残缺或语义不清（字段没有 domains、样式没有 options、提示词为空）→ 按第 2 步的「资料不足」规则弹窗问用户，不要靠猜补齐。
- `styles` / `fields` 的 schema 是用户在面板里配的**真身**：代码里只原样搬用、绝不改写（详见第 3 步第 1 条）。「以最新信息为准」是让**逻辑代码**去对齐它，不是反过来把它改成代码习惯的样子。
- `snapshot.stale === true` → 用户在快照之后改过配置，这一轮必须**按新配置把代码改到位**（新增的参数要读、改名的字段要跟着换、新增样式要能出形），并在完成后 `studio_snapshot` 刷新基线；只字面改点无关代码属于返工。

## 第 2 步：阅读参考资料（唯一来源：ha-3d-home）

**参考基准只有一个**：`$HA3D_HOME`（ha-3d-home 源码目录）。这里面的**源代码、同类插件实现、`README.md`、`PLUGIN-DEV.md`** 就是全部依据。

- 允许来源：该目录下的文档、`public/js/`（引擎实现，如 `plugins.js` 的 `register` / `bgKit` / `mergeOptions`）、`assets/plugins/<名>/plugin.js`（内置插件）、`custom/plugins/<名>/plugin.js`（用户自定义插件）。
- **禁止来源**：studio 端的模板/旧生成器代码（模板机制已删除）、其他项目、网上示例、模型记忆里的写法。API 名字、`ctx` 字段、契约形态、`options` 保留键，全部以 home 为准，不臆造、不“看起来应该这样”。
- 冲突处理：home 的代码与文档互相矛盾时，**以 home 的实际运行代码为准**（`public/js/plugins.js` 与 `assets/plugins/` 的真实实现），并在汇报里指出文档哪一处过时。

按需读：

1. `README.md` —— 项目全貌。
2. `PLUGIN-DEV.md` —— 插件开发手册（权威口径）：`ctx` 全部 API、坐标系、生命周期（register / model3d / updateAll / tick）、三类 kind（device / opening / background）与 type 枚举、plan2d 单画布绘制。写代码前必读相关章节。
3. 同类插件源码：内置 `assets/plugins/<名>/plugin.js`（现有：`background` / `door` / `window` / `light` / `switch` / `cover` / `fan` / `sensor` / `climate` / `camera` / `speaker` / `vacuum` / `water_heater`，另有 `assets/plugins/README.md` 汇总），用户自定义 `custom/plugins/<名>/plugin.js`（现有：`door_rolling` / `window_fixed` / `garden` / `mylamp` / `p3f93e60e` / `p77bd60e3`）。开发前先按 **kind 相同**找最接近的实现来对照——门/窗类读内置 `door`、`window` 与自定义 `door_rolling`；背景类读内置 `background`（`K.offsetOpts()`、`ctx.safe.allowed()` 的标准用法）；设备类读内置 `light` / `switch` / `cover` 与自定义 `mylamp` 按需取用。
4. **要写 `kind: 'background'` 的插件时，先读本 skill 的 `references/bg-house-safe.md`**（`house` / `safe` 全部字段、坐标系、必须做到的自检清单、常见反例）。这是背景插件的硬性前置，不读不写代码。
5. **glb 模型的真实尺寸靠 `studio_get_model` 量，不靠猜**：它把项目 `models/` 里的文件导出到本机并给出结构摘要（整体 bbox、逐 mesh 名称/顶点数/三角数/尺寸、`nodeList` 顶层节点名）。要精确到「门框洞口内径」「门扇宽高」「把手位置」这类细节时，用本地脚本解析导出的 glb 顶点（GLB = 12 字节头 + JSON chunk + BIN chunk，从 `meshes[].primitives[].attributes.POSITION` 对应的 accessor 读 `min/max` 或直接读顶点），拿到数字再算缩放系数。
   - 模型管理配套：`studio_list_models`（当前项目清单 + 代码引用条数 + 可选摘要）、`studio_split_model`（按顶层节点拆成独立部件，拆出的模型在原点需自己摆位）、`studio_delete_model` / `studio_rename_model`（删/改名后**必须**按返回的 `codeRefs` 把代码里的引用一起改掉，否则预览加载失败）。

**资料不足时的处理（重要）**：出现以下任一情况——提示词（aiPrompt）为空、字段缺失或语义不明、找不到同类插件可参考、用户描述的交互无法从现有资料确认 API 用法——用 AskUserQuestion 弹窗向用户说明缺口，请其补全资料（补充提示词 / 上传模型 / 说明期望交互），**不要凭空猜测继续开发**。

## 第 3 步：开发插件代码

0. 以第 1 步 `studio_get_code` 拿到的**全文**为基线做「读—改—整文件提交」，不要凭记忆从头重写（会丢用户在手写代码里的改动）。
1. **`styles` 与 `fields` 照抄 `studio_get_project` 的返回即可，但要知道它不是权威**（引擎会用项目配置覆盖，见硬规则 2）：
   - `styles`：每个条目的 `id / name / desc / z / icon`，以及 `options` 里每个参数的 `key / label / type / def / min / max / step / choices / tip` 照原样写，不要换 key 名、不要“顺手润色” label/tip 文案、不要合并或增删样式——面板、`ctx.options` 的读取和安装端都按同一份 key 对齐。
   - `fields`：每个字段的 `key / label / domains / placeholder / tip / entityId` 原样搬入；`domains` 数组的元素一个不能少、大小写不能改。**新增的 `valueType`（`number` 数值类 / `text` 字符类 / `enum` 枚举类）与 `enumValues`（枚举可选值数组）也要照抄**——它们不参与渲染，是给人看和给你（AI）读的说明：`valueType: 'enum'` + `enumValues` 直接告诉你这个字段会出现的状态字符串有哪些，写状态判断时优先按它覆盖，不要自己编状态名。
   - **参数值只当兜底，逻辑里必须先读 `ctx.options`**：`const b = Number(ctx.options.brightness ?? 0.6)`；`const b = 0.6` 这种写法会让用户在面板里改参数完全没效果（硬规则 6）。
   - **不要按样式 id 硬编码分支**：样式 id 由项目配置决定（代码里写的会被覆盖），需要区分造型时优先读 `ctx.options.<key>`，而不是 `if (ctx.style.id === 'floor')`。
   - 唯一例外：用户当轮**明确要求**改某个样式/字段时才动，并在汇报里写明改了哪一项、为什么。
   - 转写方式：把 JSON 原样转成 JS 对象字面量（`"key": "offsetX"` → `key: 'offsetX'`），只去掉键的引号，**内容与顺序不动**；拿不准就先照抄完整 schema，再往下写逻辑。
2. 写单文件 plugin.js：IIFE + `'use strict'` 包裹；`PluginEngine.register({ id, kind, type, styles, fields, model3d, plan2d, ... })`，其中 `id / kind / type` 取自 `settings`，`styles / fields` 即上一条照抄的内容（运行时会被项目配置覆盖，所以别指望在这里改值来调参）。其余 API 一律以 home 的 `PLUGIN-DEV.md` 与同类插件源码为准，不臆造。
   - **模型部件的缩放按量到的尺寸算，按「真实合缝」取值**：例如门扇填门框洞口，左右各留 1cm 左右（`scale.x = (L - 0.02) / 模型宽`）、高度对齐洞高，而不是凭感觉留 5~8cm；缩放前先用 `studio_get_model` 导出 glb 量出部件原始尺寸和洞口内径。
   - 加载失败要留兜底（`ctx.glb()` 返回 null 时用 `ctx.box` 拼一个简版），避免模型缺失时整个插件不渲染。
3. 状态逻辑：从 `ctx.getState(key)` 读字段绑定实体的状态，做好「未绑定」「异常值」的兜底；开合类动画用 `ctx.animate` 缓动（dt 系数 3~5），不要瞬跳。
4. plan2d：按平面图惯例画（门洞 + 开启弧 / 窗 + 三线等），并实现 `isOn`。
5. **背景插件（`kind: 'background'`）额外要求**（细则与自检清单见 `references/bg-house-safe.md`，必须逐条做到）：
   - `apply(ctx)` 开头先接住 `const { house, safe, planeSize } = ctx;`，**所有构图坐标只能从 `house` 推导**，禁止写死数字或假设房屋在画布中心。
   - 画布 ↔ 米：`S = 画布宽 / planeSize`；`px = 宽/2 + x*S`、`py = 高/2 + z*S`（画布 y 向下 = 3D +z 南）。`planeSize` 会随偏移放大，别当 120 用。
   - 线性元素（马路 / 河道 / 步道 / 篱笆）绕开禁放矩形：锚点写成 `house.maxY + 6`、`house.minX - 4` 这类表达式，绝不压到 `safe.x0..x1 / y0..y1`。
   - 高出的体块（树 / 石头 / 草丛 / 路灯 / 花坛）：建 mesh 之前先 `if (!safe.allowed(x, z)) continue;`；随机种子取 `house.hash`（不要裸 `Math.random()`，否则每次重放位置都变）。
   - **禁放区（房屋占地 + 1.5m 走廊）里不放任何不必要的东西**——装饰、点缀、发光体、可交互物件一律让开；平坦基底整图可以铺满（房子会压住它），但路面 / 水面 / 台阶 / 铺装这类有语义的图案不得延伸进禁放区。
   - 房屋本体不由背景画（home 里是真建筑），背景只管地面与环境。
   - **能复用 `PluginEngine.bgKit` 就别自己抄一遍**（`canvas / speckle / seed / rand / retile / fullPlane / flat / repeatOpt / offsetOpts`，与 home 同源，一览见 `references/bg-house-safe.md` §6）。
   - 提交前按 `references/bg-house-safe.md` §5 自检：用 `offset = (0,0) / (8,-6) / (55,0)` 三组 house 桩数据跑撒点，压房数必须为 0；线性元素中线取样点 `safe.forbidden()` 必须全 false。
6. 提交前本地预检：`node --check <文件>`。
7. 提交运行：`studio_write_code { code }` —— 服务端先做语法体检（有错不落盘并报错），通过后落盘并让前端清空旧渲染重建，返回渲染结果。传空串 = 清空代码（预览会报 `plugin.js 为空`），谨慎使用。

## 第 4 步：构造数据验证效果

1. 找出字段绑定的实体 id（预览实体在页面未绑定时自动 mock，形如 `binary_sensor.preview_door_entity` / `sensor.preview_opening_ratio`，可在 `studio_write_code` 返回的 `entities` 里确认）。
2. 用 `studio_set_entity { entityId, state }` 逐个推状态，覆盖边界：关闭基线 / 中间比例 / 全开 / 传感器 off 强制关闭（若语义如此）。
3. **每次推状态后等约 1.8~2.2 秒再截图**——缓动动画需要时间收敛，否则拍到的是中间态。
4. `studio_screenshot { view: 'iso', width: 720, height: 560 }` 出图，用看图工具确认形态正确（开角、遮挡关系、无穿模悬空）。
5. 多样式插件用 `studio_set_style { styleId }` 逐个样式完整走一遍第 2~4 点，最后记得切回默认样式。
6. **参数类效果（亮度 / 开合角 / 手向 / 密度…）必须用 `studio_set_option` 逐个取值验证**（等价拖左下卡片滑条）：只传 `key` 不传 `value` 先读当前值 → 传 `value` 改值 → 看返回的 `applied`（引擎实际吃到的 `ctx.options`）是否等于设定值 → `studio_screenshot` 同机位对比。灯 / 发光类要**先把主实体推成 on 再调亮度**（调参数不会把状态清回 off，但从来没过开灯就看不到差别）。核验完把参数调回原值（`from` 字段里有）。
7. 需要摆机位时先 `studio_view`（转/移模型、转/平移/缩放相机），再 `studio_screenshot`。
8. **背景插件专项验证**：把样式里的 `offsetX / offsetZ` 依次拉到 `0,0` → `8,-6` → 极值（如 `30,30`），每档等预览重画完成后截图，逐张确认：
   - 房屋（占位长方体）始终压在地面上，不悬空、不出界；
   - 禁放区里没有树 / 石头 / 装饰 / 发光体，没有路面或水面穿进来；
   - 线性元素（马路 / 河道）整体跟着房屋走，不出现「房子挪了马路没挪」；
   - 撒点密度在画面外圈（`outer` 45m 附近）渐稀，而不是一直铺到看不见的地方。
9. **看不出变化 / 画面空白 / 怀疑报错时先 `studio_get_runtime`**：它返回渲染状态、当前样式与参数**实际取值**、实体状态、引擎实例数，以及浏览器控制台最近报错。引擎会把 `update` / `plan2d` / `stateText` / 动画帧里的异常吞成 `console.warn`，只有这个工具能看到 —— 别靠截图猜。`clear: true` 可在每轮验证前清空缓冲，只看本轮新增。

## 第 5 步：收尾

1. 删除过程中的临时脚本（约定放 `scripts/.tmp-*.cjs`，用完即删）。
2. **记录配置快照**：`studio_snapshot { label: '<这轮做了什么>' }` —— 代码已按当前属性 / 字段 / 样式对齐了，把这份一起存成基线。之后用户再改配置，`studio_get_project` 的 `snapshot.stale` 就会提醒「要按新配置重写」。只在代码确实按当前配置对齐后才记录（别为了消掉提醒盲刷）。
3. 向用户汇报：改了什么、`styles` / `fields` 是否原样沿用（有改动必须说明是用户当轮明确要求、改了哪一项）、验证了哪些状态（附关键截图路径）、遗留待确认项。
   - 背景插件另需说明：构图用了 `house` 的哪些字段、`safe` 怎么参与避让、禁放区是否清空、撒点压房数自检结果。
4. 发布 / 导出前若 `snapshot.stale === true`，先告诉用户「配置有 x 处改动，代码可能还没跟上」，由用户决定是先重新生成还是直接发；`studio_export_project` / `studio_publish_project` 返回的 `configDrift` 里就是差异明细。
5. **不执行 git commit / push**，由用户自己决定提交。
