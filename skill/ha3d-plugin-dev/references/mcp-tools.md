# ha3d-plugin-studio MCP 工具清单（共 26 个）

服务端：studio 项目内的 `server/mcp/`（按域拆分，`server/mcp-tools.js` 是装配薄壳）。SSE 端点 `http://127.0.0.1:8098/mcp/sse`。
除特别说明外均有可选参数 `projectId`（省略时自动用唯一已打开的项目）。
（配置的分项读取 / 分项更新工具已删除：配置一律走 `studio_get_project` 一站式读取，配置修改在页面面板里做。）

## 读配置（任何改动前必调，不许用旧印象）

> 改项目之前必须 `studio_get_project` + `studio_get_code` 同时拉一次：前者是最新配置真身（属性/字段/样式/模型），后者是磁盘上最新代码。核对代码里的引用（settings、fields.key/domains、styles.id/options、GLB 文件名）有没有变；有变就以 studio_get_project 为准让**逻辑代码**去对齐。
>
> **`styles` 与 `fields` 是配置真身，写代码时必须原样照抄**：键盘名、取值、类型、顺序、条数全不改；空字段（`desc: ''`、`icon: ''`）照写，不补默认值、不润色文案、不增删样式。只有用户当轮明确要求时才改。

| 工具 | 参数 | 说明 |
|---|---|---|
| `studio_get_project` | — | **一站式**：aiPrompt 提示词 + settings 属性 + styles（含 icon、参数 schema，**原样搬进代码**）+ fields 实体绑定（**原样搬进代码**）+ models 清单 + snapshot 快照对账（`stale` / `changeCount` / `summary`）。改动前必调 |
| `studio_snapshot` | `label?`、`compareOnly?`、`clear?` | **配置快照**：把当前 `settings` / `fields` / `styles` 复制进 `project.snapshot`。默认=记录（覆盖旧快照，返回 `replaced` + `changesSincePrevious`）；`compareOnly:true` = 只对比（返回 `stale` / `changeCount` / `scopes` / `summary` / `changes`）；`clear:true` = 删除。**开发完成后调一次记录基线**；用户改过配置而代码没重写时，发布 / 导出会提醒（不阻断） |
| `studio_where` | — | 当前页面在哪：`page:'home'` 启动页 / `page:'project'` + `projectId` 项目编辑页 / `page:'none'` 没开页面。判断依据是 URL 路由 `#/project/<id>`；`tabs` 列出每个标签页的 `clientId` / `visible` / `focused` / `chosen`。**开工前不确定页面停在哪就先调它**：在启动页时 `studio_get_project`（自动选项目）会报「没有前端打开项目」 |
| `studio_single_window` | `keepClientId?`、`projectId?`、`dryRun?` | **单窗口收敛**：多个标签页同时开着时，MCP 操作会在它们之间跳来跳去。先向所有连接问一遍 presence，挑一个保留（`focused` > `visible` > 最近连上），其余收到 `close_extra` 后自动断开中继并关页面，不认指令的旧页面由服务端兜底断开。返回 `kept` / `closed[]`（`selfClosed` / `forced`）/ `before` / `after`。`dryRun:true` 只列计划。**开工前先收敛到一个窗口** |

> `fields[]` 里除 `key / label / domains / placeholder / tip / entityId` 外，还有两个**只用于理解**的元信息：
> `valueType`（`number` 数值类 / `text` 字符类 / `enum` 枚举类）与 `enumValues`（枚举类才有）。
> 它们不参与引擎渲染，但直接告诉你这个字段会出现哪些状态字符串——写状态判断时按 `enumValues` 覆盖，别自己编状态名；照抄进代码即可。

## 读代码 / 写代码

| 工具 | 参数 | 说明 |
|---|---|---|
| `studio_get_code` | — | 插件代码全文 + 概要（plugin / styles / fields / models / lines）。代码一律取自 `customJs`（模板生成机制已删除）。**改代码前必调，是唯一可信的代码基线**（不要用上一轮写过的版本代替） |
| `studio_write_code` | `code`（完整源码）、`view?`、`run?`（默认 true） | 先语法体检（有错不落盘并报错），落盘后前端清空旧渲染重建。返回 `render`（当前样式/尺寸/实体列表）。**传空串 = 清空代码**（预览会报 `plugin.js 为空`） |

## 看效果（走前端中继，需要编辑页在线）

| 工具 | 参数 | 说明 |
|---|---|---|
| `studio_set_style` | `styleId` | 切换预览样式，立即重建 3D。styleId 见 studio_get_project |
| `studio_set_option` | `styleId?`、`key?`、`value?` | **样式参数调节（核验参数效果用）**：改 `styles[].options[].def`（面板左下卡片滑条上的那个值）→ 重跑代码出图，返回 `from` / `to` / `options`（改后的值）/ `applied`（引擎实际吃到的 `ctx.options`）。`range/number` 传数字（按 min/max 夹取）、`checkbox` 传 `true/false`、`select/text` 传字符串。**不传 `key` = 只读当前样式的全部参数值**。参数改动会保留已推的实体状态（开着灯调亮度，灯不会变回关） |
| `studio_view` | `modelRotate[3]` / `modelMove[3]` / `modelSet{rx,ry,rz,x,y,z}` / `modelReset`（模型姿态）；`view` / `azimuth` / `elevation` / `distance` / `zoom` / `target[3]` / `orbitAzimuth` / `orbitElevation` / `panX` / `panY` / `zoomFactor`（相机） | 只摆姿态不出图。view 预设：iso(四分之三)/front/back/left/right/top/low(低角)/detail(特写) |
| `studio_screenshot` | 同 studio_view 的机位参数 + `width?` `height?`（64~2048）`withGrid?` `background?`（0xRRGGBB 十进制，-1 透明） | 返回 PNG（image 内容）+ preview 概要。**推状态后等 ~1.8s 再拍**，否则是缓动中间态 |

## 验状态 / 模型管理

| 工具 | 参数 | 说明 |
|---|---|---|
| `studio_set_entity` | `entityId`、`state`（字符串，如 'on'/'off'/'25'）、`attributes?` | 模拟 HA 推实体状态，触发插件 update/重绘。实体 id 在 write_code 返回的 entities 或插件代码 fields 里 |
| `studio_list_models` | `withSummary?` | **当前项目的模型列表**：文件名、大小、更新时间、`codeRefs`（代码引用行数）、`unused`（没被代码引用的）。`withSummary: true` 附 glb 结构摘要（mesh/节点/材质/动画数 + 包围盒尺寸，最多解析前 20 个）。上传/删除/改名前后对账用 |
| `studio_upload_model` | `filePath`（本机 .glb 绝对路径）、`name?` | 上传到项目 models 目录，前端自动刷新列表 |
| `studio_get_model` | `file`（如 `frame.glb`）、`saveTo?` | **把项目内的 glb 导出到本机**，返回绝对路径 `savedTo` + 结构摘要（mesh/node/材质/动画数、整体 bbox 尺寸、逐 mesh 的名称/顶点数/三角数/尺寸、`nodeList` 顶层节点名）。`saveTo` 传目录（可不存在，自动建）→ 追加原文件名；传带 `.glb` 的文件路径 → 按该路径落盘；省略 → `系统临时目录/ha3d-models/<projectId>/` |
| `studio_split_model` | `file`、`node?` | 按**顶层节点**把 glb 拆成多个独立 `.glb`（`<base>__<节点名>.glb`，顶点已烘焙世界变换、模型在原点）。传 `node` 只导该节点。拆分前先 `studio_get_model` 看 `nodeList` |
| `studio_delete_model` | `file` | 删除模型文件；返回 `codeRefs`（仍在引用它的代码行）与 warning，删完记得把代码里的引用一起改掉 |
| `studio_rename_model` | `file`、`to` | 重命名（`to` 必须 `.glb` 结尾、不能重名）；返回 `codeRefs` 提醒改代码 |
| `studio_fix_model_materials` | `file?`（不传 = 全部 .glb）、`dryRun?` | 修 GLB 材质发黑（sRGB 未转 gamma 提亮 / metallic 压 0 / roughness 抬 0.7 / 移除压暗扩展），与编辑页「✨ 修复材质」同一套逻辑，可重复跑；**原地改写、不生成备份**。模型在 3D 里发暗、发黑、像塑料金属反光时先调它（`dryRun: true` 只体检） |

## 交付：导出 / 发布（带配置漂移提示）

| 工具 | 参数 | 说明 |
|---|---|---|
| `studio_export_project` | — | 打包 zip 以 base64 放在返回的 `zipBase64` 字段（不落盘、不发布、不改版本号），需要文件时自行解码保存。返回 `configDrift` |
| `studio_publish_project` | `bump?` | 打包 → 远程安装到 ha-3d-home → 版本号写回。返回 `configDrift` |

> 两者都**不阻断**。`configDrift.stale === true` 表示快照之后配置改过（`summary` 是明细）：先把差异告诉用户、建议重新生成，是否直接发由用户决定 —— 不要擅自跳过，也不要替用户拦死。

## 运行期排错（看不出变化、画面空白时先调它）

| 工具 | 参数 | 说明 |
|---|---|---|
| `studio_get_runtime` | `level?`（`all`/`error`）、`limit?`、`clear?` | 运行期体检：`render`（ok/error/loading/plugin/style/instance 参数实际取值/size/label/plan2d/camera/model/entities）+ `engine`（defs/instances/lastError）+ `console`（`stats`、`errors`、`warnings`）。**引擎把 `update` / `plan2d` / `stateText` / 动画帧里的异常都吞成 `console.warn`，只有这里能看到**；`window.onerror` 与未处理 Promise 也收。`clear: true` = 读完清空缓冲（先返回快照再清空）。日志按项目标记，切项目不会串 |

## 前端中继排错

- 「插件渲染区初始化超时」：没有浏览器页面打开编辑页。
- 「不支持工具」：页面跑的是旧构建，让用户刷新编辑页（或先调 `studio_reload`）。
- 两者都重试即可恢复，不需要改代码。
