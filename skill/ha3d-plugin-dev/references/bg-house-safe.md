# 背景插件：`ctx.house` 与 `ctx.safe` 必须用足

> 适用：`kind: 'background'` 的插件（草地、马路、沙滩、院子…）。
> 写 `apply(ctx)` 之前先读完这份；**任何背景插件都必须用 `house` / `safe` 构图与避让**，
> 拿固定常数（120 / 8 / 512 一半…）硬编码的构图一律视为不合格。
> 权威实现：`ha-3d-home/public/js/plugins.js` → `applyBackground` / `safeZone`；
> 文档：`ha-3d-home/PLUGIN-DEV.md` §4.3–4.5。本文与它们冲突时以 home 代码为准。

## 0. 坐标系（新手翻车第一名，先看这三行）

- 2D 编辑器平面坐标 `(x, y)` → 3D 世界坐标 `(x, z)`；高度方向是 **y 轴**（向上）
- 平面上的 y（南北向）在 3D 里叫 **z**：`house.minY / maxY / cy` 都是「平面 y = 世界 z」
- **原点 = 背景中心**（= `ctx.plane()` 的平面中心 = 画布中心），**不是房屋中心**。
  房屋可以因样式参数 `offsetX / offsetZ` 偏离画面中心，此时 `house.cx / cy` 就是那个偏移量
  （`0 / 0` = 房屋正落在画面正中）。`safe` 与 `house` 同一套坐标，已含偏移。
- 引擎负责把背景 group 摆到「房屋中心 − 偏移」，**插件不要自己加整体偏移**，只在自己的 group 内部组装。

## 1. `house` —— 全屋包围盒（所有楼层墙体的并集），单位：米

| 字段 | 含义 |
|---|---|
| `minX` / `maxX` | 房子最西 / 最东的墙边（背景坐标系里 x 的最小 / 最大值） |
| `minY` / `maxY` | 房子最北 / 最南的墙边（对应 **z** 的最小 / 最大值，名字沿用编辑器的 y） |
| `w` / `d` | 东西向宽 / 南北向深（= `maxX - minX` / `maxY - minY`） |
| `cx` / `cy` | 房屋中心点：平面坐标 `(cx, cy)`，在 3D 里就是 `(cx, 高度, cy)`。想让地面跟着房子居中才写 `base.position.set(house.cx, -0.05, house.cy)`；引擎给的 `ctx.plane()` 已把平面中心放在背景中心，直接 `add` 就是对的 |
| `floors` | 有墙的楼层数（没画墙的层不算） |
| `hash` | 尺寸指纹（字符串）。墙 / 楼层变了它才会变；引擎发现变化会自动重放背景（**你不需要自己监听重建时机**）。拿它当随机种子，可以让「同一栋房子每次重建，草的位置完全一样」：`const rnd = K.rand(K.seed(house.hash));`（`K = PluginEngine.bgKit`） |

项目里一堵墙都没有时，引擎给的是 0~8 米的正方形兜底值 —— 不要假设它一定很大，所有构图都要按实际 `w / d` 推导。

## 2. `safe` —— 安全边界（帮道具避开房子）

| 成员 | 含义 |
|---|---|
| `inner = 1.5` | 房屋占地向外扩多少米算「禁放区」（留一条走廊，别贴到墙上） |
| `outer = 45` | 建议最远布置半径（超出这个圈再撒东西玩家也看不见） |
| `x0, x1, y0, y1` | 禁放矩形的四条边（= `house` 四条边各向外 ±`inner`） |
| `forbidden(x, z)` | 传平面坐标，`true` = 落在禁放区（会压到房子，别放） |
| `allowed(x, z)` | 传平面坐标，`true` = 在房子外面且离中心不超过 45m（推荐撒点范围） |

典型用法（撒任何东西之前先问一句）：

```js
if (ctx.safe && !ctx.safe.allowed(x, z)) continue;   // 这个点不合适，换一个
```

## 3. 必须做到（逐条自检，缺一条即返工）

1. **构图基准全部从 `house` 推导**：马路贴哪侧、河离房子多远、院墙围多大，都要用
   `house.minX / maxX / minY / maxY / w / d / cx / cy` 算，禁止写死数字或假设「房子在画布中心」。
2. **线性元素（马路 / 河道 / 篱笆 / 步道）绕开禁放矩形**：锚点用 `house.maxY + 距离`、
   `house.minX - 距离` 这类表达式，绝不把路面/水面画进 `safe.x0..x1 / y0..y1`。
3. **高出的体块（树、石头、草丛、路灯、花坛、栅栏桩）落点必须先过 `safe.allowed()`**；
   批量撒点时先筛再建，统计「压房数」必须为 0。
4. **随机必须可复现**：种子取自 `house.hash`，写法 `const rnd = K.rand(K.seed(house.hash))`
   （`K = PluginEngine.bgKit`，home 与 studio 都有这一套）；不要在 `apply` 里裸用 `Math.random()` ——
   房屋尺寸一变位置全乱、每次重放都不一样。
5. **画布 ↔ 米换算用 `ctx.planeSize`**：`S = 画布宽 / ctx.planeSize`，画布中心 = 背景中心，
   `px = 宽/2 + x*S`、`py = 高/2 + z*S`（画布 y 向下 = 3D +z 南）。
   `planeSize` 会随偏移自动放大（≥120），别假设它始终是 120。
6. **地面平坦基底（草地/沙地/雪地整图）可以铺满整块**——房子会压住它，这是允许的；
   但**有语义的地面图案**（路面、水面、台阶、铺装边界）不得延伸进禁放区。
7. **不要在禁放区里放任何「不必要的东西」**：装饰、点缀、发光体、粒子、可交互物件一律让出
   `safe.forbidden` 的范围；宁可空着，也不要贴墙。
8. **房屋本体不由背景画**：home 里房屋是真实建筑，背景只负责地面与环境。

## 4. 常见反例（都会在预览里翻车）

| 反例 | 后果 |
|---|---|
| `base.position.set(0, -0.05, 0)` 当作房屋居中 | offset 一调，房子偏出画面，地面没跟上 |
| 马路固定画在 `py(40)` | 房屋深 16m 时贴得太近或穿房；偏移后更糟 |
| 树 / 草丛随机撒 `rand(-50, 50)` 不过 `allowed` | 树穿墙、压在屋顶上 |
| 用 `Math.random()` 撒点 | 每次重放（改参数、改房屋尺寸）位置都变，玩家看到「树在跳」 |
| 用 2048 画布 + 写死 120m 换算 | `planeSize` 放大到 138 时比例全错 |

## 5. 交付前自检（可在本地临时脚本里跑，跑完删掉）

```js
// 把「会撒的点位生成逻辑」抽成纯函数，用 house/safe 桩数据验一遍
let hit = 0;
for (let i = 0; i < 400; i++) {
  const p = pickPoint(i);                 // 与 apply 里同一套撒点逻辑
  if (safe.forbidden(p.x, p.z)) hit++;    // 必须 0
  if (!safe.allowed(p.x, p.z) && isDecor(p)) hit++;
}
if (hit) console.warn('有', hit, '个道具落在禁放区/圈外');
```

- 用三组 `house` 桩数据跑：`offset = (0,0)`、`(8,-6)`、`(55,0)`。
  每组都要求：房屋中心换算到世界坐标 = 原点、撒点压房数 = 0。
- 线性元素：把它的关键锚点（起点 / 终点 / 中线）逐点过一遍 `forbidden()`，全部 false。

## 6. 背景插件共用底座 `PluginEngine.bgKit`（能复用就别自己抄）

home 与 studio 都挂了同一套 `PluginEngine.bgKit`，插件里标准写法：

```js
const K = PluginEngine.bgKit;
```

| 函数 | 作用 |
|---|---|
| `K.canvas(size)` | 空白正方形画布（缺省 256） |
| `K.speckle(c, colors, n, min, max)` | 在画布上下文上均匀撒噪点（草地 / 沙滩颗粒） |
| `K.seed(str)` | 字符串 → 数值种子（配 `house.hash` 用） |
| `K.rand(seed)` | → `() => 0..1` 的确定性随机序列 |
| `K.retile(cv, tile, n)` | 把 tile 画布平铺 n×n 到 `cv` |
| `K.fullPlane(tile, n)` | tile → 铺满 2048² 大图（n 自动夹在 1~40） |
| `K.flat(ctx, cv, name?)` | 扁平背景组装：`group + ctx.plane(整图)` |
| `K.repeatOpt(def)` | 「颗粒密度」参数条目（`key` 固定 `repeat`） |
| `K.offsetOpts(range?)` | 引擎保留的 `offsetX / offsetZ` 两条偏移参数（默认 ±30，展开进 `options`） |

参考用法：`assets/plugins/background/plugin.js`（内置草地/沙滩/马路）、`custom/plugins/garden/plugin.js`。

