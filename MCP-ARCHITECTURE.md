# studio MCP 实现归属分析

> 分析日期：2026-11-12。回答的问题：**MCP 的 42 个工具，哪些在服务端实现、哪些在前端实现、哪些前后端协作。**

## 整体链路

```
MCP 客户端(WorkBuddy) ──SSE──▶ 服务端 mcp/sse.js + tools.js（42 工具注册）
                                    │
                    ┌───────────────┼────────────────┐
              纯服务端执行      hub.call 中继        hub.notify 广播
           (fs/构建/打包/HTTP)  ▼                   (仅刷新 UI，不影响成败)
                              前端 ws-client.js 的 handlers 表（18 个执行器）
                              编辑页 / 家具页 harness，操作浏览器里的真引擎
```

- **服务端注册层**：`server/mcp/tools.js` 装配、`server/mcp/sse.js` 提供 SSE 端点（`/mcp/sse`），工具实现按域拆在 `server/mcp/tools-*.js`（config / projects / models / catalog / publish / preview / lock）。
- **中继层**：`hub.call(pid, name, args, timeout)` 走 WebSocket 转发给浏览器里的前端页面；`hub.notify(...)` 是 fire-and-forget 广播，不算中继。
- **前端执行层**：`client/src/ws-client.js` 的 `handlers` 表（编辑页与家具页共用一套 viewport 门面 `ensureViewportStage`），直接操作浏览器里的 THREE 引擎与 Vue 状态。

**判定口径就一条**：handler 里有没有 `hub.call`。有 → 前端必须在线才成功；只有 `hub.notify` → 前端不在线也不影响工具成败。

---

## 一、纯服务端实现（21 个）——浏览器不用开

| 域 | 工具 | 服务端做什么 |
|---|---|---|
| projects | `studio_list_projects` | 读项目目录摘要 |
| config | `studio_get_project`、`studio_get_code` | readProject + generator 现场构建 plugin.js |
| models | `studio_upload_model` / `studio_get_model` / `studio_list_models` / `studio_split_model` / `studio_delete_model` / `studio_delete_models` / `studio_rename_model` / `studio_fix_model_materials`（8 个） | 纯文件操作 + 返回完整 url 路径（不含主机端口，AI 拼 MCP 服务器地址自行下载），MCP 不写本机文件；仅 `splitGlb`（拆分）与 `fixGlbMaterials`（修材质）在服务端解析 GLB |
| catalog | `studio_list_catalog_items` / `studio_get_catalog_item` / `studio_set_catalog_item` / `studio_upload_catalog_model` / `studio_delete_catalog_items` / `studio_get_catalog_types`（6 个） | 读写 project.json 的 `catalog.items`；`resolveCatalogTypes` 代理 home 的 `/api/catalog`。删家具（含单件）一律走 `studio_delete_catalog_items`（条目 + 模型文件 + 清单三处同步，`deleteModel:false` 只删条目），`studio_delete_models` 只对插件项目开放 |
| publish | `studio_export_project` / `studio_publish_project` / `studio_export_catalog` / `studio_publish_catalog`（4 个） | zip 打包、版本号 bump、POST 到 home 的 `/api/plugins/install` |

这些工具里的 `hub.notify` 只是**顺带广播**「文件变了，前端刷一下列表」——发不出去不影响工具成功。

---

## 二、纯前端实现（15 个）——服务端只当中继，页面必须开着

服务端 `hub.call(...)` 转发，前端 `ws-client.js` 的 handlers 执行；页面不开 / 超时就失败：

| 工具 | 前端执行器 | 前端做什么 |
|---|---|---|
| `studio_lock_config` / `studio_unlock_config` / `studio_get_lock` | `lock` | 锁状态**只存在前端页面内存**里，服务端不落盘（刷新页面自动解锁） |
| `studio_click`、`studio_label`、`studio_set_entity`、`studio_get_runtime` | `click` / `label` / `set_entity` / `runtime`（`get_runtime` 非同名） | 直接操作浏览器里的插件引擎实例（点击 / 读标签 / 推实体 / 收运行期状态） |
| `studio_render` | `render` | 触发引擎重绘 |
| `studio_view`、`studio_screenshot` | 公共 viewport 门面（`ensureViewportStage`） | 编辑页 / 家具页共用同一套相机与截图实现 |
| `studio_reload` | `reload` | 让页面自刷新拉新 bundle |
| `studio_where` | `where` | 前端回报自己开着哪个项目 / 页面 |
| `studio_single_window` | 服务端编排多个 `hub.*` 调用 | 多开页面的 keeper 选举与关窗，**执行全在前端**（keeper 由前端 presence：visibilitychange/focus 上报选举） |
| `studio_select_catalog_item`、`studio_get_catalog_selection` | `catalog_select` / `catalog_current` | **切换 / 读取「当前预览哪件家具」**：`catalog_select` 改左侧清单选中项并等 GLB 真正进场景（等价于点该行），返回实测包围盒与相机状态；`catalog_current` 只读。纯 UI 状态，**不落盘**（代码注释明确） |

---

## 三、前后端协作（6 个）——服务端先干一半，前端干另一半

| 工具 | 服务端部分 | 前端部分 |
|---|---|---|
| `studio_write_code` | 校验 + 写 `custom.js` 落盘 | `run_code`：重建引擎跑新代码 |
| `studio_sync_config` | 校验 + 写盘（styles/fields 双写整表替换） | `sync_config`：热应用配置 + 回传 `parity` 一致性 |
| `studio_set_style` | 读盘校验 styleId 存在 | `set_style`：清空旧渲染重建 3D |
| `studio_set_option` | 校验 key/value + range 夹取（**只读分支不 relay，纯服务端**） | `set_option`：改 def 重跑代码，回传 `ctx.options` 实际取值 |
| `studio_open_project` | 读目标项目 | `open_project`：页面跳转 / 切项目 |
| `studio_refresh_catalog` | 触发 | 前端重新拉服务端 models 目录重建清单 + notify 广播 |

---

## GLB 处理边界（2026-11-12 起）

服务端把项目里的 GLB 当**静态文件集合**管理，只有两类写操作解析 GLB：`splitGlb` / `splitGlbOne`（拆分，需逐顶点烘焙世界变换）与 `fixGlbMaterials`（修复材质发黑，只改 `materials`）。二者同时被 MCP 工具与编辑页 HTTP 路由（`routes/models.js` 的 `/split`、`/fix-materials`）共用，设备 / 背景插件「部件」面板依赖它们，必须保留。

**不在服务端解析、也不返回**：`glbSummary` / `glbDetail` / `measureGlb` 与 `lib/glb-info.js` 已下线；`studio_get_model` / `studio_get_catalog_item` / `studio_list_catalog_items` 的 `detail` / `withSummary` / `withGlbSummary` / `includeGlbDetail` / `measure` 参数及 `glb` / `glbDetail` / `measured` / `sizeDiff` / `sizeMatch` / `localBBox` 返回字段全部移除。详细数据走「AI 按返回的 `url` 拼 MCP 服务器地址下载 → **用 Python 或 Node.js 自己解析**」（`helpers.js` 的 `GLB_PARSE` 是唯一口径：GLB = 12 字节头 + JSON chunk + BIN chunk，读 `accessors` 即得节点树 / 包围盒 / 材质，**零依赖，不引 three.js 等第三方库**）；家具 `w/d/h` 解析后经 `item` / `set_catalog_item` 写入，或由前端「按模型实测」按钮本地计算。

浏览器编辑页本来就是本地解析（节点树 `thumb.js` 用 `GLTFLoader`、尺寸 `CatalogEditor.vue` / `three-host.js` 用 `THREE.Box3`、顶点数 `ModelPreview.vue` 遍历 geometry），符合边界，功能不变。

`studio_list_catalog_items` 按「一个工具一件事」进一步收窄：**只返回 `items` 数组**（每项 = 家具全量属性 + `modelFile`），不再附 `models` / `types` / `unusedModels` / `validation` / `manifestPreview` / `count` 等顶层字段。这些各有独立来源：`studio_get_catalog_types`、`studio_list_models`（含孤儿 glb）、写操作返回的 `validation` 与 `manifestPreview`。所有 MCP 工具都是**纯数据接口**：没有任何 `saveTo` 参数、不写任何本机文件。`studio_get_model` / `studio_list_models` / `studio_get_catalog_item`（`model.url`）/ `modelFile.url` 返回的都是完整 `url` 路径（不含主机与端口），由 **AI 拼上自己连接的 MCP 服务器地址**后直接下载 `.glb`；`studio_export_catalog` 改用 `zipBase64` 返回整包，由 AI 解码落盘（仅用户明确要求导出时）。这样本地 / 远程部署都成立，服务端不需要探测自身 host。

## 关键设计点

1. **前端 harness 是唯一真源**：凡涉及「渲染结果、运行期状态、页面 UI」的操作只能前端做——服务端没有 THREE 引擎，这类工具在页面没开时必然超时失败，这是设计使然。
2. **混合工具的服务端前置**都是「读盘校验、别把明显错的参数发给浏览器白等超时」，例如 `set_style` 先查 styleId 在不在 styles 里。
3. **锁和窗口管理完全在前端**：锁不落盘；多窗口 keeper 由前端 presence 选举。
4. **42 个工具归属速记**：21 纯服务端 + 15 纯前端 + 6 前后端协作。改动某个行为前先按此表判断该落在哪一侧。

## 排查时的注意点（给以后的维护者）

- `tools-*.js` 里 `hub.notify` ≠ 中继，别把它当「需要页面在线」的依据。
- `set_option` 的**只读分支**（只查不写）不会 relay，是唯一「同一工具内纯服务端与纯前端两个分支并存」的特例。
- 前端 handlers 表在 `client/src/ws-client.js`，新增前端执行器要同步 `server/mcp/tools-*.js` 的 `hub.call` 名称与超时，两端字符串必须一致。
