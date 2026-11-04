/* MCP 工具定义（SSE 传输，见 mcp-sse.js）——装配入口
 *
 * 设计原则：一切以「插件代码」为中心。
 * 造型、模型、实体绑定、状态判断全部写在 plugin.js 里，AI 读代码就知道全部信息。
 *
 * 工具按域拆在 server/mcp/ 下（详见 mcp/helpers.js 头注释）：
 *   0a. studio_get_project    一站式读全部配置（属性/字段/样式/部件/提示词/快照状态）——开工第一步
 *   0b. studio_snapshot       配置快照：记录/对比/清除「属性+字段+样式」，发布前对账用
 *   1.  studio_get_code       读代码（唯一的信息入口）
 *   2.  studio_write_code     改完提交：语法体检 → 落盘 → 前端清空旧渲染并重建
 *   3.  studio_view           摆姿态：转/移模型、转/平移/缩放相机（先调好再看）
 *   4.  studio_screenshot     按指定角度出图
 *   5.  studio_set_entity     给绑定实体推状态，验证「状态变化 → 造型变化」
 *   6.  studio_upload_model   代码里 glb() 更需要的模型文件
 *   7.  studio_export_project 导出插件压缩包（zip 以 base64 放在返回里，不落盘、不改版本号）
 *   8.  studio_publish_project 发布到 ha-3d-home（打包 → 远程安装 → 版本号写回）
 *   9.  studio_get_model      导出项目内 glb 到本机路径 + 结构摘要（供 AI 本地分析模型）
 *   10. studio_list_models    列出当前项目的模型（大小/更新时间/结构摘要/代码引用条数）
 *   11. studio_split_model    按顶层节点把 glb 拆成多个独立部件
 *   12. studio_delete_model   删除项目里的模型文件（附代码引用告警）
 *   13. studio_rename_model   重命名模型文件（附代码引用告警）
 *   14. studio_fix_model_materials 修复 GLB 材质发黑（metallic 偏高 / sRGB 未转 / 压暗扩展）
 *   15. studio_get_runtime    运行期体检：渲染状态 + 当前样式/参数/实体 + 控制台报错
 *   16. studio_set_option     样式参数调节：改 options[].def → 重渲，供 AI 自动核验参数效果
 *   17. studio_where          当前页面在哪：启动页 / 某项目编辑页（项目页返回 projectId）
 *   18. studio_single_window  单窗口收敛：只保留一个标签页，多余的让前端自己关掉
 *
 * 项目 id 可省略：自动使用当前唯一打开了编辑页的项目。
 * 每次调用都会向前端广播 { type:'mcp', event:'activity' }，顶部横条提示（wrapToolActivity 统一做）。
 */
'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { wrapToolActivity } = require('./mcp/helpers');
const toolsConfig = require('./mcp/tools-config');
const toolsPreview = require('./mcp/tools-preview');
const toolsProjects = require('./mcp/tools-projects');
const toolsModels = require('./mcp/tools-models');
const toolsPublish = require('./mcp/tools-publish');

function buildMcpServer() {
  const server = new McpServer({ name: 'ha3d-plugin-studio', version: '0.4.0' });
  wrapToolActivity(server);

  toolsConfig.register(server);     // 配置：读项目 / 快照 / 读写代码
  toolsPreview.register(server);    // 预览：切样式 / 调参数 / 点击 / 截图 / 体检
  toolsProjects.register(server);   // 项目：列表 / 页面定位 / 单窗口 / 切换项目
  toolsModels.register(server);     // 模型：上传 / 导出 / 列表 / 拆分 / 删改 / 材质修复
  toolsPublish.register(server);    // 发布：导出 zip / 远程安装

  return server;
}

module.exports = { buildMcpServer };
