# ha3d-plugin-studio

图形化的 [ha-3d-home](../ha-3d-home) 3D 插件开发台：在浏览器里创建插件项目、装配模型、绑定实体、实时预览，并通过内置 **MCP Server** 让 AI 助手（如 WorkBuddy）全流程读写与验证——从一句话需求到可安装的插件压缩包。

配套的 WorkBuddy 技能（已整理为独立仓库，持续维护）：**<https://gitee.com/sunhuip/ha3d-skill.git>**

## 核心能力

### 1. MCP 能力（30 个工具）

服务内置 MCP Server（SSE 传输），连接地址：

```
http://localhost:8098/mcp/sse
```

在 WorkBuddy 等支持 MCP 的客户端中添加该地址即可。工具一览（按用途排列）：

**配置读取**

| 能力 | 说明 |
| --- | --- |
| `studio_get_project` | 一站式读取全部配置（属性 / 字段 / 样式 / 部件 / 提示词 / 快照状态），开工第一步 |
| `studio_get_code` | 读自定义代码（唯一的信息入口） |
| `studio_write_code` | 提交代码：语法体检 → 落盘 → 前端实时重建渲染 |
| `studio_sync_config` | **配置写入**：传最终版 `styles` / `fields` 清单 → 整表替换前端样式 / 字段 tab 的数据 + 落盘 `project.json`，传什么就是什么。不合并、不留删除标记：清单里没有的旧条目即删除（代码里仍声明也不会复活）。落盘是主目标：页面重渲染失败也照样写入（原因在 `hint` / `warn`）。返回 `diff`（落盘前后增删）+ `parity`（tab 实际值 vs 磁盘 JSON）。未传的维度（只传 styles 时）保持不动 |
| `studio_lock_config` | **锁定配置（人机互斥）**：编辑页左侧浮层里的输入控件转只读，避免 AI 改配置的同时用户手改互相覆盖；纯前端状态，用户刷新页面即自动解锁。可选 `note` 说明锁的用途 |
| `studio_unlock_config` | 解锁配置，把编辑权交还用户 |
| `studio_get_lock` | 查当前锁状态（是否锁着、谁锁的） |
| `studio_render` | 立刻重新渲染：重跑插件代码 + 按当前配置合并后重建场景，返回样式 / 实体 / 参数实际取值。只重渲不写盘；`refreshConfig:true` 先从服务器重读配置，`view` 可套用视角预设 |
| `studio_list_projects` | 列出所有项目（id / 名称 / 类型 / 模型数） |
| `studio_where` | 当前编辑页停在哪：启动页（`page:"home"`）/ 项目编辑页（返回 `projectId`）/ 没打开页面（`"none"`），判断依据是 URL 路由 `#/project/<id>`；`tabs` 列出每个标签页的 `clientId` / 可见 / 聚焦 |
| `studio_single_window` | **单窗口收敛**：同时开着多个标签页时，MCP 操作会在它们之间乱跳。先问一遍所有连接「谁可见/有焦点」，挑一个保留（有焦点 > 可见 > 最近连上，可用 `keepClientId` 指定，`projectId` 限定范围），其余前端收到关闭指令后自动断开中继并关掉页面；不认指令的旧页面由服务端兜底断开。`dryRun` 只列计划 |
| `studio_open_project` | 让编辑页切换到指定项目（URL 直跳） |
| `studio_view` | 转模型 / 移模型、转相机 / 平移 / 缩放（先摆姿态再出图） |
| `studio_screenshot` | 按预设视角（iso / front / top…）截图 |
| `studio_set_entity` | 给绑定实体推状态，验证「状态变化 → 造型变化」 |
| `studio_click` / `studio_label` | 模拟点击设备 / 读取状态标签 |
| `studio_set_style` | 切换样式，验证多造型 |
| `studio_set_option` | 调节样式参数取值（等价拖左下卡片滑条）：改 `options[].def` 后重跑代码出图，返回改前/改后值 + 引擎实际吃到的 `ctx.options`；不传 `key` 只读当前参数值，供 AI 自动核验参数效果 |
| `studio_upload_model` | 上传 GLB 模型到项目模型库 |
| `studio_list_models` | 列出当前项目的模型：大小、更新时间、代码引用条数、可选结构摘要 |
| `studio_get_model` | 把项目里的 GLB 导出到本机（返回绝对路径 + 结构摘要：mesh/材质/动画数、包围盒、逐 mesh 尺寸、顶层节点名），便于 AI 本地量尺寸、拆部件 |
| `studio_split_model` | 按顶层节点把 GLB 拆成多个独立部件模型（顶点已烘焙世界变换） |
| `studio_delete_model` | 删除模型文件，并返回仍在引用它的代码行 |
| `studio_rename_model` | 重命名模型文件，并返回仍在用旧文件名的代码行 |
| `studio_fix_model_materials` | 修复 GLB 材质发黑（sRGB 未转 / metallic 偏高 /  roughness 偏低 / 压暗扩展）；**原地改写不留备份**（幂等可反复跑），`dryRun` 只体检 |
| `studio_get_runtime` | 运行期体检：渲染错误、当前样式与参数实际取值、实体状态、引擎实例数、浏览器控制台报错（含被引擎吞掉的 `update` 异常） |
| `studio_reload` | 刷新编辑页（加载新构建） |
| `studio_export_project` | 导出插件压缩包（zip 以 base64 放在返回的 `zipBase64` 字段，不落盘、不改版本号）。返回里的 `configDrift` 是「配置 vs 快照」的差异（不阻断导出） |
| `studio_publish_project` | 发布到 ha-3d-home（远程安装 + 版本号写回）。返回里的 `configDrift` 同上 |

> 项目 id 可省略：自动使用当前打开了编辑页的项目。截图 / 写码立即运行等前端中继工具依赖浏览器打开着编辑页。
> **同时开了多个标签页时，先 `studio_single_window` 收敛成一个再动手** —— 否则截图、调参、写码可能落到不同标签页，看到的画面和代码对不上。

### 2. 接入 WorkBuddy 快速零代码开发

配合 WorkBuddy 技能 **`ha3d-plugin-studio`**，用自然语言一句话即可生成插件（如「用 ha3d-plugin-studio 技能开发一个落地灯插件」）。技能内化的流程：

1. **环境检查 + 锁定项目** —— 确认 MCP 在线、编辑页停在项目编辑页，然后 `studio_lock_config` 把左侧面板转为只读，避免 AI 改配置与用户手改互相覆盖（纯前端状态，刷新页面即解锁）；
2. **拉取配置与代码** —— `studio_get_project` 拿属性 / 字段 / 样式 / 部件 / 提示词（`aiPrompt` 为用户需求，必读）+ `studio_get_code`；多轮迭代可基于对话内记忆，出现「用户手改过 / 验证结果不符」等情况必须重拉；
3. **阅读参考** —— 读 ha-3d-home 的 `PLUGIN-DEV.md`（ctx API 权威口径）与同类插件源码，资料不足会弹窗向用户补问；
4. **配置项规划与同步** —— 需要新增 / 调整样式、字段时，**先用 `studio_sync_config` 把配置覆盖到服务端与前端**，再按新配置写代码（引擎渲染时配置会覆盖代码声明，不同步则验证结论不可信）；
5. **生成代码** —— 写单文件 `plugin.js` 并 `studio_write_code` 提交（服务端先做语法体检）；
6. **验证效果** —— `studio_set_entity` 构造实体状态覆盖边界，`studio_set_option` 调样式参数（如亮度）并回读实际生效值，`studio_screenshot` 截图确认形态与动画；
7. **解锁 + 收尾** —— `studio_unlock_config` 交还编辑权，汇报改动与验证结果，可选 `studio_publish_project` 直接发布（配置漂移由前端在发布时自动检测确认）。

整个过程无需手写一行代码，模型上传、样式参数、实体绑定都在 studio 界面或 MCP 工具中完成。

#### 技能包获取与安装

技能已经整理成独立仓库，**以该仓库为准**（持续维护，跟着本项目的 MCP 工具与流程迭代）：

```bash
git clone https://gitee.com/sunhuip/ha3d-skill.git
```

- **仓库地址**：<https://gitee.com/sunhuip/ha3d-skill.git>
- **安装**：把仓库目录放到 WorkBuddy 的技能目录即可（详见仓库内的 `README.md` 安装说明，含前置条件、三种安装方式、验证步骤与排查表）：

  ```bash
  rsync -a --exclude '.git' --exclude '.DS_Store' \
    ha3d-skill/ ~/.workbuddy/skills/ha3d-plugin-studio/
  ```

- 技能**不在本仓库内维护**（早期的 `skill/` 导出副本已迁出），请直接使用上面的仓库，避免两边版本分叉。

> **说明**：借助 AI Agent 开发模型插件的最终质量，很大程度上取决于提示词（需求描述）的质量——描述得越具体（设备类型、样式细节、参数期望、验证要点），产出越贴近预期；反之则可能需要多轮修正。效果因人而异，属于正常现象。

### 3. 配置快照与「重新生成」提醒

`plugin.js` 是按**某一版配置**写的：读哪些 `options`、绑哪些字段、有哪些样式。用户在面板上改了配置，代码不会自己跟着变，于是出现「配置改了、画面没变」。

- **记录**：`studio_snapshot`（或编辑页顶栏的快照徽标）把当前的 `settings` / `fields` / `styles` 复制进 `project.snapshot`（含时间、备注、当时版本与代码行数）。
- **对账**：每次保存后、以及发布 / 导出前，服务端按 key 比对（样式按 id、参数按 key、字段按 key；`version` 不参与，发布 bump 不算漂移）。
- **提醒但不拦**：不一致时编辑页顶栏徽标变橙并弹窗列出差异（属性 x 处 / 样式 y 处 / 字段 z 处），确认后仍可继续发布或导出；MCP 的 `studio_export_project` / `studio_publish_project` 也会在返回里带 `configDrift`。**不强制**重新生成。
- **刷新**：让 AI 按新配置重新生成后，再记录一次快照即可。快照只能通过 `/api/projects/:id/snapshot` 维护，编辑页保存不会覆盖它。

### 4. 样式与参数以项目为准

AI 生成的 `plugin.js` 里常把 `styles` / `options` 写死（生成那一刻的快照）。studio **不把它当依据**：

- **预览**：`PluginEngine.register()` 注册时，用项目的 `styles` / `fields` 覆盖代码里的同名字段（`client/src/engine/project-config.js`）。样式按 id 对齐，代码里同 id 的条目只贡献函数（背景插件的 `style.apply` 是渲染主体）；项目完全没配时才退回代码里的。
- **发布 / 导出**：打包产物就是项目里那份原始代码（AI 输出什么样就打包什么样，**不包配置注入层**）。配置与代码的一致性由开发流程保障：AI 按快照照抄配置 + 面板改动后重新生成；页面预览用的 `GET /api/projects/:id/build` 同样返回原始代码，所以代码面板里看到的就是打包出来的那份。
- **前提**：代码逻辑必须读 `ctx.options.<key>`（而不是写死常量），否则在面板/卡片里调参数不会影响画面。

### 5. 三种项目类型（kind 创建时选定，之后不可改）

| kind | 典型设备 | 特点 |
| --- | --- | --- |
| `device` 设备（**含门/窗**） | 灯、开关、风扇、摄像头、传感器…；门 / 窗用 `type: 'door'` / `'window'` | 实体状态驱动造型变化（亮灭 / 开关 / 巡视 / 开合）；支持点击交互（click 配置）与悬浮状态标签；plan2d 绘制平面图标。门/窗是「贴墙设备」：`kind` 同样是 `device`，只是 `type` 不同、默认不显示 3D 标签、门的离地高度固定 0 |
| `background` 背景 | 草地、沙滩、马路、院子… | `apply(ctx)` 直接返回渲染好的 3D 内容（`{ group }`），不调用 model3d / plan2d；用「安全范围」长宽占位盒代替房屋体块，范围内禁止放置物品。`ctx.house` / `ctx.safe` 与 ha-3d-home 同口径：原点 = 背景中心，`offsetX/offsetZ`（房屋相对背景中心的偏移）先算进 house/safe，背景 group 再摆到「房屋中心 − 偏移」，占位盒钉在世界原点 |
| `catalog` 家具包 | 沙发、床、桌椅、柜子… | **一个项目 = 一个家具包**：导入多个 GLB，每个模型一条描述（名称 / 分类 / 尺寸 / 兜底色），整包发布到 ha-3d-home 的 `custom/models/<项目id>/`。走**独立编辑页**（`CatalogEditor.vue`：清单 + 3D 预览 + 属性），不涉及样式 / 字段 / 代码 |

> **开/合判定只有一个入口**：插件在 register 顶层声明 `isOn(obj, get)`（设备与门/窗共用）。`click` 只描述「点下去发什么服务」（`on` / `off` / `label` / `defaultOn`），不再有 `click.isOn`。判定结果同时驱动 3D 标签高亮、2D 平面填充色与点击方向。

#### 家具项目（kind: `catalog`）

- **新建**：启动页「新建项目」先选类型（设备 / 背景 / 家具包）再填名称；`kind` 由服务端记在 `project.json`，`PUT` 时与磁盘比对，改了就 409 拒回（`POST /api/projects` 传 `kind`）。
- **清单**：`project.catalog.items[]`，一条对应一个 GLB —— `{ id, name, type, w, d, h, color, model }`。导入模型时前端用 `GLTFLoader` 实测包围盒自动填 `w/d/h`（宽 = X、深 = Z、高 = Y），也可在右侧点「按模型实测」重算。
- **分类**：`type` 必须命中 ha-3d-home 的分类枚举。编辑页的下拉来自 `GET /api/catalog-types`：studio 服务端优先向 home 的 `/api/catalog` 取（`types` 是唯一出处），home 不可达才用本地兜底表。
- **产物**：家具包 = `item.json`（`kind:"catalog"` + `id`(=项目 id) + `items` 数组）+ 各条目引用的 `.glb` **平铺**在包根。
  - 导出：页面「导出家具包」/ `GET /api/projects/:id/export-catalog`
  - 发布：页面「发布到 ha-3d-home」/ `POST /api/projects/:id/publish-catalog`（同一个远程安装接口，home 按包内 `kind` 分流到 `custom/models/<项目id>/`，包内 `id` 必须与 `?id` 一致）
  - 插件端点（`/export`、`/publish`）遇到 `catalog` 项目会直接 400 并指路，不会打出半套插件包
- **home 侧条目 id**：`<项目id>:<条目id>`，所以不同家具包用同名条目（都叫 `sofa`）也不会互相覆盖。
- **MCP 操作家具项目**（`server/mcp/tools-catalog.js`，与插件那套工具分开）：

  | 工具 | 作用 |
  | --- | --- |
  | `studio_list_catalog_items` | 列出当前页全部家具（属性 + 模型文件信息 + 可选 GLB 摘要），`saveTo` 可把全部 `.glb` 导出到本机；附分类、未引用模型、校验结果、item.json 预览 |
  | `studio_get_catalog_item` | 单件详情：右侧面板全量属性 + GLB 深度解析（节点树 / mesh / 材质贴图 / 动画 / 扩展 / 世界包围盒实测 w·d·h），`saveTo` 导出该 GLB |
  | `studio_get_catalog_types` | 读取现有家具类型（= 编辑页分类下拉全量：来自 home 的 `types`），并统计当前包各分类用了几件 |
  | `studio_set_catalog_item` | **全量属性覆盖**：`itemId + item` 单件整条替换，或 `items` 整张清单替换；`merge=true` 才增量合并；可选 `meta` 改包名/版本/说明 |
  | `studio_upload_catalog_model` | 上传本机 GLB（可多个）+ 右侧属性配置；未给的尺寸按 GLB 实测自动填；**同名模型直接覆盖**（更新原条目，不新增重复家具） |
  | `studio_delete_catalog_item` | 移除条目（可选连模型文件一起删；别的家具还在用该模型时会拦下） |
  | `studio_export_catalog` / `studio_publish_catalog` | 导出家具包 zip / 发布到 ha-3d-home |

  写操作会落盘 `project.json` 并通过 WebSocket 推 `what:'catalog'`：编辑页重拉清单、取消挂着的防抖保存（避免旧内存覆盖 AI 的改动）、刷新模型列表与 3D 预览。插件专用工具（`get_code` / `write_code` / `sync_config` / 预览中继 / 插件发布）落到家具项目时会直接指路，不会白等中继超时；`studio_get_project` 对家具项目额外返回 `catalog` 整张清单。
  GLB 深度解析复用 `split-glb.js` 的 chunk 解析与列主序矩阵工具（同一份口径），插件页 `studio_get_model(detail=true)` 也用它。

### 6. 离线打包与在线安装

**离线打包**（三种入口等价）：

- 页面右上角「发布到 ha-3d-home ▾」→ **导出插件包**；
- HTTP：`GET /api/projects/:id/export`；
- MCP：`studio_export_project` → zip 以 base64 放在返回的 `zipBase64` 字段（不落盘）。

包内结构（无顶层目录）：`plugin.json`（清单）+ `plugin.js`（注册代码）+ `models/*.glb`。拿到压缩包后也可在 ha-3d-home 页面手动导入（`/api/plugins/import`）。

**项目备份 / 迁移**（与插件包不同，这是整个项目文件夹原样打包）：

- 页面：「发布到 ha-3d-home ▾」→ **导出项目**；启动页右下角「导入项目」按钮（设置上方）可把备份 zip 还原成新项目（id 冲突自动换新 id）。
- HTTP：`GET /api/projects/:id/export-project` 导出，`POST /api/projects/import` 导入。
- 包内结构：`project.json` + `preview.png` + `models/*`（不含编辑器内部 backups/）。所有导出服务端都不落盘。

**在线安装**（一键发布到运行中的 ha-3d-home）：

- 页面「发布到 ha-3d-home」按钮 / MCP `studio_publish_project`；
- 流程：服务端打包 zip → `POST {host}/api/plugins/install?id=<插件id>&version=<v>`（Header 带 `X-Install-Key` 安装密钥）→ ha-3d-home 校验后解压到 `custom/plugins/<id>/`，已存在则整体替换（重复发布 = 覆盖升级）→ 成功后版本号写回项目 JSON；
- 「发布前升一位版本号」避免浏览器缓存旧 `plugin.js`；
- 发布目标（ha-3d-home 主机地址 + 安装密钥）在 studio 界面设置里配置，存于 `data/config.json`。

## 快速开始

```bash
npm install
npm run client:build   # 构建前端（Vue3 + Vite，产物 client/dist）
npm start              # 启动服务 → http://localhost:8098
```

前端开发模式（可选）：`npm run client:dev`（Vite dev server）。

发布到 ha-3d-home 前需该服务在线（默认 `http://localhost:8077`），并在 studio 设置里填好主机地址与安装密钥。

### Docker 部署

单容器、数据走卷（与 ha-3d-home 同款方案）：

```bash
docker compose up -d --build
```

| 项 | 说明 |
| --- | --- |
| 端口 | `8098`（编辑台 + MCP 同端口） |
| 数据卷 | `./data:/data` —— 插件项目（`projects/`）与全局配置（`config.json`），升级镜像不丢 |
| 健康检查 | `GET /api/health`（compose 已配 healthcheck） |
| MCP 地址 | `http://主机IP:8098/mcp/sse` |
| 环境变量 | `PORT`（默认 8098）、`HA3D_STUDIO_DATA_DIR`（默认容器内 `/data`） |

容器内访问宿主机上的 ha-3d-home 发布：Mac/Windows 填 `http://host.docker.internal:8099`，Linux 填宿主机内网 IP。

**推送到内网仓库**（默认只推 `linux/arm64`，同 ha-3d-home 的 `push:image` 体系）：

每次执行先把 `package.json` 的 `version` 递增一位（默认 patch，`1.0.0 → 1.0.1`），
然后只推两个 tag：

- `192.168.31.16:4000/sunhuipeng/ha3d-plugin-studio:<version>`（版本固定）
- `192.168.31.16:4000/sunhuipeng/ha3d-plugin-studio:latest`（始终最新，必推）

```bash
npm run push:image                # 自动升版 + 只推上面 2 个 tag
npm run push:image:arm64          # 显式平台，等价
BUMP=none npm run push:image      # 不升版，沿用当前 version 重推
BUMP=minor npm run push:image     # 升 minor
VERSION=2.0.0 npm run push:image  # 手动指定版本号（不自动升版）
```

前置条件：内网仓库是 **HTTP**，Docker 需把 `192.168.31.16:4000` 加进 `insecure-registries`
（Docker Desktop / OrbStack → Settings → Docker Engine → 重启）；首次推送先 `docker login 192.168.31.16:4000`。
目标机 `docker pull 192.168.31.16:4000/sunhuipeng/ha3d-plugin-studio:latest`，
或把 `docker-compose.yml` 的 `build: .` 删掉、`image:` 换成完整地址后 `docker compose up -d`。
x86 目标机不适用 arm64 镜像，需要时显式 `bash scripts/push-image.sh linux/amd64` 单独推。
不带登录态直接 `curl .../tags/list` 会返回 401，确认上传用 `docker pull` 或仓库页面。


## 项目结构

```
server/            Node 服务端（Express, 端口 8098）
  index.js         入口：静态托管 client/dist + API + WS + MCP(SSE)
  routes.js        REST API（项目 CRUD / 模型 / 构建 / 导出 / 发布 / 家具包）
  catalog-schema.js 家具项目的数据形状 + 校验 + item.json 清单构建（纯函数）
  catalog-pkg.js   家具包打包 + 远程发布（item.json + 多个平铺 glb）
  catalog-types.js 家具分类枚举（优先取 home 的 /api/catalog，失败回落兜底）
  glb-info.js      GLB 深度解析（节点树/材质/贴图/动画 + 世界包围盒实测尺寸，复用 split-glb 矩阵工具）
  mcp/             38 个 MCP 工具（config/preview/projects/models/publish/lock/catalog + helpers）
  mcp-tools.js     MCP 工具装配薄壳（把上面各域 register 进 server）
  mcp-sse.js       MCP SSE 传输
  ws-hub.js        WebSocket 中继（服务端 ↔ 浏览器编辑页）
  plugin-pkg.js    打包 + 远程发布（HTTP 与 MCP 共用）
  generator.js     manifest 拼装与配置校验（代码一律取 customJs）
  config.js        路径 / 项目读写 / 远程目标配置
client/src/        前端（Vue3 + Vite）
  components/      PluginStage（3D 预览）/ RightPanel / LeftRail / Home / CatalogEditor（家具编辑页）
  engine/          plugin-engine（插件装载与运行）/ plugin-preview / three-host
data/
  projects/<id>/   每个插件项目：project.json + models/*.glb + preview.png
  config.json      远程发布目标（host + key）
scripts/           push-image.sh 镜像构建推送
Dockerfile         多阶段构建：镜像内构建前端 → 轻量运行层（数据走 /data 卷）
docker-compose.yml 单容器部署（8098 端口 + /data 挂载 + healthcheck）
```

## 相关文档

- ha-3d-home：`../ha-3d-home/README.md`（主项目）、`../ha-3d-home/PLUGIN-DEV.md`（插件 API 权威口径）
- **WorkBuddy 技能（独立仓库，以此为准）**：<https://gitee.com/sunhuip/ha3d-skill.git> —— 完整开发流程（环境检查 → 锁项目 → 拉配置/代码 → 配置项同步 → 生成代码并验证 → 解锁）+ MCP 30 个工具的完整清单 + 背景插件规范；安装见仓库内 `README.md`

## 开源协议与更新维护

### 开源协议

本项目（含 ha3d-plugin-studio 与其配套主项目 ha-3d-home）基于 [PolyForm Noncommercial 1.0.0](LICENSE) 协议开源：

- ✅ **免费使用**：个人使用、学习研究、兴趣爱好项目等一切非商业用途完全免费
- ✅ **自由二次开发**：可以修改源码、基于本项目做二次开发、分发衍生版本
- ❌ **禁止商用**：不可出售、出租、付费分发本项目或基于它的作品，不可付费托管 / SaaS 化，不可用于任何商业目的
- ❌ **衍生项目同样禁止商用**：基于本项目二次开发的项目必须同样遵循本协议，也不能拿来卖钱或商用
- 💼 **商用授权**：确有商业使用需求，请单独联系作者获得商业授权
- 📋 **传递义务**：把本项目（或其衍生版本）提供给任何人时，必须同时附上本协议文本或其链接

> 协议要点为便于快速理解的中文摘要，法律效力以 [LICENSE](LICENSE) 中的英文原文为准。

### 更新与维护

本项目由作者**提供思路与需求 + AI Agent 全程开发**完成。项目维护需要消耗 token（AI 开发成本），因此：

- 在 token 充足的情况下会**持续维护**：修复 bug、跟进 ha-3d-home 引擎变化、打磨开发体验
- 维护节奏取决于可用资源，不承诺固定排期
- 欢迎提 Issue 反馈问题；按本协议提交的 PR 同样以非商业方式共享给所有用户
