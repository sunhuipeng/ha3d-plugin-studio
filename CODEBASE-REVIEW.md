# ha3d-plugin-studio 发布前代码卫生扫描报告

> 扫描范围：`server/`（15 个文件）+ `client/src/`（27 个文件），共约 1.06 万行。
> 方法：全量通读 + 交叉 grep 验证（所有「死代码」结论均已二次核实引用点）。
> 总体评价：**卫生状况良好** —— 无 console.log 调试残留、无 TODO/FIXME、方案 B（配置以项目为准）改造彻底、ws 协议两端对齐、快照链路完整。以下问题按优先级列出。

---

## 一、优先处理（疑似真 bug / 会产生实际影响）

1. **发布/导出时「没有 GLB 模型」警告恒误报**（已验证）
   - `server/plugin-pkg.js:40-44`：`validate(proj)` 在 `proj.models = listModels(...)` **之前**执行；
   - `server/routes.js:325-329`（/export）同样先 validate 后注入；
   - 而 `generator.js:84` 的警告依赖 `modelListOf(proj).length` → 发布/导出时 models 恒为空，**即使项目有模型也必触发该 warn**。/build 路径（routes.js:298 先注入后校验）则正常。
   - 修法：三条路径统一「先注入 models 再 validate」。

2. **MCP 导出与 REST 导出校验口径不一致**：`mcp-tools.js` 的 `studio_export_project` 不调 `validate`（error 也照常出包），`/api/projects/:id/export` 会 400 拦截。同一动作两个入口行为不同，需统一（建议都拦或都只提醒）。

3. **`client/src/ws-client.js:506` 死协议分支**（已验证）：前端处理 `refresh what:'config'`（分块拉新配置），但服务端**从无任何地方发送** `what:'config'`（只发 `models` / `snapshot`）——这是早期「MCP 服务端直改配置」方案的残留，可整块删除（连带 :7 的协议注释）。

4. **`routes.js:178-191` /home/house 鉴权存疑**：检查了 `remote.key` 存在性，但 fetch 时没带 `X-Install-Key` 头（对比 plugin-pkg.js:61 有带）。若 home 端本就免鉴权则检查条件应只看 host；否则是漏发。**需你确认 home 侧约定**。

## 二、高置信度死代码（可直接删）

前端：
1. `client/src/store.js:245` `act.clearSnapshot()` —— 定义后全项目零调用（UI 只用 take/load）。
2. `client/src/field-schema.js` `normalizeFields()`、`inferFieldType()` —— 导出后无任何引用（store 只用 `normalizeField`；「老数据推断」逻辑实际已废弃）。
3. `client/src/engine/plugin-engine.js:119/722` `this.ready` —— 只写 `false`，从未置 true、从未被读。
4. `client/src/store.js` `S.snapshot.changes` / `codeChanged` —— 只写不读（徽标只读 has/at/stale/changeCount/scopes/summary/hint）。
5. `client/src/style.css` 4 个无引用选择器：`.hidden`(36)、`.code-badge.custom`(937)、`.code-btn.on`(951)、`.pv-ent-val.opt` 及其 hover(1192/1219)。

服务端：
6. `server/config-snapshot.js:37/311` `SCOPE_LABEL` —— 定义即导出，零消费（diff 输出用的是硬编码中文）。
7. `server/config-snapshot.js:305-312` `configOf/codeFingerprint/summarize` 仅模块内部使用，导出属多余公开面（`server/config.js:54-58` 的 `CONFIG_FILE/DEFAULT_REMOTE_HOST/projectDir/projectFile` 同理）。
8. `server/mcp-tools.js:1229` `resolveProjectId` 死导出（scripts 无任何 require）。
9. `server/mcp-tools.js:405` `proj.models = listModels(pid)` 死赋值 —— `buildAll` 只读 `customJs`，不碰 models；纯浪费一次目录扫描（420 行又单独调了一次）。
10. `server/split-glb.js:99/110` `compSize` 算完不用、靠 `void` 压 lint，直接删；`:283` `makeMaterialRemap` 返回的 `materials` 成员无人解构。

注：探查中曾报 `plugin-engine.js` 的 `boundEntities()`/`labelOffset()` 为死方法，经核实**两者真实存在且为插件运行时 API**（labelOffset 兜底 0.3、boundEntities 遍历实体），已保留并在源码处补了防误删注释。

## 三、疑似残留 / 过期注释（改动小，建议顺手清）

- `ws-client.js:300` 注释仍说「切样式会清临时参数」—— styleOpts 时代的口径，现行注释（PluginStage.vue:512）明确无此行为。
- `routes.js:298` 与 `plugin-pkg.js:44` 注释「运行时注入：模板生成用」—— 模板生成已废除，注入现在只为 `validate` 能看到 models（顺带修正措辞）。
- `server/config.js:37` 「home 侧安装接口尚未实现」—— 早已实现，注释过期。
- `style.css:1103` 提到不存在的 `.pv-quickstyles`（实为 `.pv-styles-bar`）；`store.js:35` 注释「状态栏/MCP 读」漂移。
- `store.js:107-112` normalize 里连续 5 个 `delete proj.snapshot/code/codeMode/rules` 属历史数据清洗，若确认旧数据已刷过一轮，可降级为一次性迁移。
- `store.js:417-427` 模块级副作用块整体多 2 格缩进（搬运痕迹），格式修正即可。

## 四、重复实现（可合并，降低双改漏改风险）

1. **导出/打包三胞胎**：`routes.js /export`、`plugin-pkg.publishProject` 前半段、`mcp-tools.studio_export_project` 重复「readProject→diffSnapshot→注入→buildAll(inject)→zip」序列，可抽 `prepareExportZip(pid)`。
2. **diffSnapshot 手工展开 3 份**：`mcp-tools.js:342-358`（compareOnly）、`:150-160`（driftOut）、`routes.js:106-118`（GET snapshot），compareOnly 直接复用 driftOut 即可。
3. **快照记录流程 2 份**：`routes.js:121-135` 与 `mcp-tools studio_snapshot` recorded 分支同构。
4. **项目列表构建 2 份**：`routes.js:51-67` 与 `studio_list_projects`，可抽 `listProjectSummaries()`。
5. **双 `listModels`**：`config.js:49`（string[]）与 `mcp-tools.js:77`（{file,size}[]）各自 readdir，后者可由前者 map。
6. **`split(/[\s,，]+/)` 4 份拷贝**：server 侧 field-schema / config-snapshot / mcp-tools 各一份，收敛为 `splitList()`。
7. **方案 B 合并逻辑双实现（有意，但需显式同步约定）**：`server/inject-config.js` 的 styleOut/`__applyCfg` 与 `client/src/engine/project-config.js` 的 styleOut/`applyProjectConfig` 逐行同构；option-schema、field-schema 也是两端逐字拷贝。建议两处文件头互相注明「改此逻辑必须同步另一份」清单（目前只有单边注释）。
8. **前端小重复**：`clamp` 3 份（three-host/plan-draw/plugin-preview）；curStyle 查找 2 份（store vs PluginStage computed）；`kind` 提取三连 computed（PluginStage.vue:110-126）；GLB 加载+节点摘取 2 份（ModelPreview vs thumb.js，构图系数还微差，同一模型缩略图与大图取景不一致）；样式胶囊模板 2 处复制。
9. **`mcp-tools.js` 项目 id 校验两套口径**：部分工具 `resolveProjectId+safeId` 两连击（= requirePid），部分只 resolve 不查 safeId，建议统一走 requirePid。
10. `generator.js:62-68` validate 里手写 `raw==='bool'` 判断，`normalizeOptionType` 已覆盖同逻辑。

## 五、结构优化建议（发布后可做的重构）

1. `mcp-tools.js`（1229 行 / 26 工具）按域拆分：config / view / models / publish 四个模块 + 基础设施（glbSummary 93 行纯解析也适合独立）。
2. 26 处相同 `try/catch → fail(e.message)` 样板可收敛进 `wrapToolActivity`；顺带对 `server.tool` 4 参形态加参数个数断言（防 MCP SDK 3 参重载静默错位）。
3. `plugin-engine.js` 的 `_makeCtx`（约 140 行）与 `_spawnBackground`（约 95 行）可拆 ctx-kit / safe-zone 模块。
4. `ws-client.js` 的 MCP 横条状态机（约 80 行）可拆 `mcp-indicator.js`；`PluginStage.vue`（678 行）的 `status` ref 与 `S.previewStatus` 双记账可合并为单源 computed，refresh/refreshOpts 的「load 后四件套」重复可抽 `afterLoad()`。
5. 轻微问题：`PluginStage.vue` `setSafeSize` 无下界（可把占位盒 scale 打到 0/负值闪一下，建议即时钳 `Math.max(2,…)`）；`CodePanel.vue:158` 切样式整版重拉 /build 且会覆盖编辑中的代码（styles 已是运行时注入，切样式不必 reload，需确认是否有意）；`ws-hub/mcp-sse` 的连接日志建议加 DEBUG 开关。
6. 引擎暴露给插件运行时的 `PluginEngine.ico/isOnState/...` 等方法 client UI 不调用但属**插件 API 契约，不能删**，建议补注释防止后续被当死代码误清。

## 六、建议的清理顺序

1. 一.1 validate 顺序（3 处，一行级改动）；一.3 删 config 死分支；一.2 统一导出校验口径（需你拍板方向）。
2. 二组死代码一次性删（前端 5 项 + 服务端 5 项），构建 + 冒烟即可验证。
3. 三组注释/格式顺手清。
4. 四、五组放发布后的小迭代（方案 B 双实现同步约定建议先补上，成本低收益高）。

—— 报告完，未改任何代码。确认后我可以按上面顺序逐组清理。
