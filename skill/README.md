# ha3d-plugin-dev 技能包

在 [ha3d-plugin-studio](../README.md) 里用一句话描述需求，让 AI 按固定流程生成 3D 插件（门窗 / 设备 / 背景）的技能包。本目录就是可分发版本，装到本机技能目录即可使用。

## 目录结构

```
ha3d-plugin-dev/
├── SKILL.md                     主流程：第 0 步环境检查 + 五步开发流程 + 四条硬规则
├── references/
│   ├── mcp-tools.md             26 个 MCP 工具的参数与用法
│   └── bg-house-safe.md         背景插件必读：ctx.house / ctx.safe 坐标系与避让规范
└── scripts/
    └── mcp-call.cjs             命令行调 MCP 工具的通用脚本（不依赖 MCP 客户端）
```

## 安装

WorkBuddy 个人级技能（对所有项目生效）：

```bash
mkdir -p ~/.workbuddy/skills
cp -R skill/ha3d-plugin-dev ~/.workbuddy/skills/
```

项目级技能（只对某个项目生效）：

```bash
mkdir -p <项目>/.workbuddy/skills
cp -R skill/ha3d-plugin-dev <项目>/.workbuddy/skills/
```

装好后在对话里说「用 ha3d-plugin-dev 技能开发一个落地灯插件」即可触发（触发词见 `SKILL.md` 的 frontmatter）。

## 使用前提

| 前提 | 说明 |
| --- | --- |
| studio 服务在线 | `cd <studio 项目根> && node server/index.js`，默认端口 `8098` |
| 浏览器开着编辑页 | 代码立即运行、截图、改样式等工具经浏览器中继，页面刷新后会自动加载新构建 |
| Node.js ≥ 18 | 跑 `scripts/mcp-call.cjs` 与服务端 |
| ha-3d-home 源码 | 技能的唯一参考基准（`PLUGIN-DEV.md` 与插件实现），用于查 API 口径 |

## 路径配置

技能里用两个变量指代目录，按你的实际位置替换即可：

| 变量 | 含义 | 默认值 |
| --- | --- | --- |
| `HA3D_STUDIO` | studio 项目根 | `scripts/mcp-call.cjs` 会依次尝试：环境变量 → 本技能所属仓库根（技能放在 `<studio>/skill/` 时）→ `~/WorkBuddy/home/ha3d-plugin-studio` → 当前目录 |
| `HA3D_HOME` | ha-3d-home 源码目录 | `$HA3D_STUDIO/../ha-3d-home` |

自动探测不中时显式指定：

```bash
export HA3D_STUDIO=/path/to/ha3d-plugin-studio
export HA3D_HOME=/path/to/ha-3d-home
```

## 自检

```bash
# 服务是否在线
curl -s --noproxy '*' -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8098/

# 拉当前打开项目的配置（能出 JSON 就说明 MCP 通路正常）
node scripts/mcp-call.cjs studio_get_project | head -20
```

`mcp-call.cjs` 用法：

```bash
node scripts/mcp-call.cjs <工具名> ['{json 参数}'] [截图输出路径.png]

# 例
node scripts/mcp-call.cjs studio_get_code
node scripts/mcp-call.cjs studio_set_entity '{"entityId":"binary_sensor.preview_door_entity","state":"on"}'
node scripts/mcp-call.cjs studio_screenshot '{"view":"iso","width":720,"height":560}' /tmp/shot.png
```

## 常见问题

- **报「找不到 ha3d-plugin-studio 项目根」**：没设 `HA3D_STUDIO`，且技能不在 studio 仓库内、当前目录也不是项目根。按上面的方式 `export` 一下即可。
- **工具报「插件渲染区初始化超时」/「不支持该工具」**：浏览器编辑页没开或没刷新，打开 `http://localhost:8098` 再试。
- **`curl` 返回空 / 连接被代理拦**：本机请求要带 `--noproxy '*'`。
- **背景插件生成的构图总是压房**：AI 没先读 `references/bg-house-safe.md`，确认 `ctx.house` / `ctx.safe` 的用法后再让它返工。
