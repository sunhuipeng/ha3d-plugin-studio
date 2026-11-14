/* MCP 工具定义（SSE 传输，见 mcp/sse.js）——装配入口
 *
 * 设计原则：一切以「插件代码」为中心。
 * 造型、模型、实体绑定、状态判断全部写在 plugin.js 里，AI 读代码就知道全部信息。
 *
 * 工具按域拆在 server/mcp/ 下（详见 mcp/helpers.js 头注释）。
 * 能力分三层，能共用的都压在底层，不做无谓的适配层：
 *   公共层（与项目类型无关）：页面定位 / 单窗口收敛 / 打开项目 / 列项目 / 新建与复制项目 / 配置锁；
 *     模型文件操作（list / get / upload / delete / split / rename / fix materials / delete_models 批量）；
 *     视图与截图（studio_view / studio_screenshot / studio_reload）——插件页与家具页共用同一个
 *     ThreeHost（client/src/engine/three-host.js），前端只各自注册一个同形状预览门面，
 *     ws-client.js 的 ensureViewportStage 统一取用，applyPose / 截图构造全链路复用。
 *   插件项目独占：代码 / 样式 / 参数 / 实体 / 点击 / 运行期 / 插件导出发布（tools-config / preview / publish）。
 *   家具包独占：清单 / 单件属性 / 分类枚举 / 上传并建条目 / 点选清单 /
 *     家具包导出发布（tools-catalog）——这些返回的是「家具条目」数据形状，与模型文件清单不是一回事，
 *     强行合并成同一个工具只会让返回结构分叉、增加维护成本，故保持两套入口、共用底层 helpers。
 * 家具项目没有插件引擎：插件专属中继动作由 H.assertPluginProject 提前挡掉（见 tools-preview.js 的 relay）。
 *
 * 0a. studio_get_project    一站式读全部配置（属性/字段/样式/部件/提示词）——开工第一步
 *   1.  studio_get_code       读代码（唯一的信息入口）
 *   2.  studio_write_code     改完提交：语法体检 → 落盘 → 前端清空旧渲染并重建
 *   2b. studio_sync_config    写 styles / fields：清单整表替换前端 tab 数据 + 落盘 project.json（以清单为准）
 *   2c. studio_render         立刻重新渲染（重跑代码 + 按当前配置合并，不写盘）
 *   3.  studio_view           摆姿态：转/移模型、转/平移/缩放相机（先调好再看）
 *   4.  studio_screenshot     按指定角度出图
 *   5.  studio_set_entity     给绑定实体推状态，验证「状态变化 → 造型变化」
 *   6.  studio_upload_model   代码里 glb() 更需要的模型文件
 *   7.  studio_export_project 导出插件压缩包（zip 以 base64 放在返回里，不落盘、不改版本号）
 *   8.  studio_publish_project 发布到 ha-3d-home（打包 → 远程安装 → 版本号写回）
 *   9.  studio_get_model      返回 glb 的完整 url 路径 + 文件基本信息（AI 拼 MCP 服务器地址自行下载）
 *   10. studio_list_models    列出当前项目的模型（大小/更新时间/代码引用条数/URL，不解析内容）
 *   11. studio_split_model    按顶层节点把 glb 拆成多个独立部件
 *   12. studio_delete_model   删除插件项目的模型文件（附代码引用告警；家具包请用 28）
 *   13. studio_rename_model   重命名模型文件（附代码引用告警）
 *   14. studio_fix_model_materials 修复 GLB 材质发黑（metallic 偏高 / sRGB 未转 / 压暗扩展）
 *   15. studio_get_runtime    运行期体检：渲染状态 + 当前样式/参数/实体 + 控制台报错
 *   16. studio_set_option     样式参数调节：改 options[].def → 重渲，供 AI 自动核验参数效果
 *   17. studio_where          当前页面在哪：启动页 / 某项目编辑页（项目页返回 projectId）
 *   18. studio_single_window  单窗口收敛：只保留一个标签页，多余的让前端自己关掉
 *   19. studio_lock_config    锁用户左侧面板（纯前端只读，刷新即解锁；同步同项目所有页面）
 *   20. studio_unlock_config  解除左侧面板只读（同步同项目所有页面）
 *   21. studio_get_lock       查前端锁状态（是否只读 / 谁锁的 / 同项目页面数）
 *   21b. studio_create_project 新建项目（纯服务端，与 REST 共用 lib/project-ops.js）
 *   21c. studio_copy_project   复制项目（整份配置 + models/，纯服务端，同上）
 *
 * 家具项目（kind:'catalog'）另有一套工具，见 mcp/tools-catalog.js：
 *   22. studio_list_catalog_items   列全部家具（纯列举，只返回 items 数组：每项含全量属性 + modelFile）
 *   23. studio_get_catalog_item     单件详情（纯读：全量属性 + 模型文件信息（含 model.url 下载地址），不下载）
 *   24. studio_set_catalog_item     全量属性覆盖（单件整条替换 / 整张清单替换）
 *   25. studio_upload_catalog_model 上传 GLB（可多个）+ 右侧属性配置
 *   26. studio_get_catalog_types    读取现有家具类型（分类下拉全量 + 当前包各分类使用统计）
 *   27. studio_delete_catalog_items 删家具：按 itemIds 移除条目 + 默认连模型删 + 同步 catalog.items（删单件也用它）
 *
 * GLB 处理边界：服务端仅 split / fix materials 两类写操作解析 GLB；其余一律只做
 *   文件级操作 + 返回完整 url 路径（不含主机端口，AI 拼 MCP 服务器地址自行下载），
 *   MCP 不写任何本机文件；详细结构由 AI 自己下载后用 Python / Node.js 直接解析（零依赖读二进制容器，
 *   不引 three.js 等第三方库），服务端不再返回顶点/尺寸/材质明细。
 *
 * 项目 id 可省略：自动使用当前唯一打开了编辑页的项目。
 * 每次调用都会向前端广播 { type:'mcp', event:'activity' }，顶部横条提示（wrapToolActivity 统一做）。
 */
'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { wrapToolActivity } = require('./helpers');
const toolsConfig = require('./tools-config');
const toolsPreview = require('./tools-preview');
const toolsProjects = require('./tools-projects');
const toolsModels = require('./tools-models');
const toolsPublish = require('./tools-publish');
const toolsLock = require('./tools-lock');
const toolsCatalog = require('./tools-catalog');

function buildMcpServer() {
  const server = new McpServer({ name: 'ha3d-plugin-studio', version: '0.5.0' });
  wrapToolActivity(server);

  toolsConfig.register(server);     // 配置：读项目 / 快照 / 读写代码
  toolsPreview.register(server);    // 预览：切样式 / 调参数 / 点击 / 截图 / 体检
  toolsProjects.register(server);   // 项目：列表 / 新建 / 复制 / 页面定位 / 单窗口 / 切换项目
  toolsModels.register(server);     // 模型：上传 / 导出 / 列表 / 拆分 / 删改 / 材质修复
  toolsPublish.register(server);    // 发布：导出 zip / 远程安装
  toolsLock.register(server);       // 配置锁：加锁 / 解锁 / 查状态（人机互斥编辑）
  toolsCatalog.register(server);    // 家具包：清单 / 单件详情 / 全量覆盖 / 上传模型 / 分类 / 删除

  return server;
}

module.exports = { buildMcpServer };
