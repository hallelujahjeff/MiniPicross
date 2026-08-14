# 关卡模板格式（formatVersion 1）

一个关卡就是 `src/level/levels/` 下的一个 `.json` 文件。加载器通过 Vite 的
`import.meta.glob` 静态收集该目录下的所有 JSON，**新增关卡只需丢一个文件进去**，
无需改任何代码。

## 1. 整数坐标系

- 网格尺寸 `size = [W, H, D]`，对应 X / Y / Z 三轴的格子数。
- 合法坐标为整数：`x ∈ [0, W)`、`y ∈ [0, H)`、`z ∈ [0, D)`。
- 线性索引 `index = x + y * W + z * W * H`（X 变化最快）。
- **Y 轴向上**，`y = 0` 是最底层。
- 世界坐标为居中映射：`worldX = (x - (W-1)/2) * CELL`，因此造型的几何中心
  永远落在世界原点，相机只需锁定原点。

## 2. 字段说明

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `formatVersion` | number | 否 | 缺省视为 `1`；不等于 1 直接报错 |
| `id` | string | 否 | 关卡唯一标识；缺省时用文件名（不含扩展名） |
| `name` | string | 否 | 显示名；缺省用 `id` |
| `size` | `[W,H,D]` | **是** | 正整数，单轴上限 16 |
| `encoding` | `"layers" \| "coords"` | 否 | 缺省 `"layers"` |
| `layers` | string[][] | encoding=layers 时必填 | 分层字符画，见下 |
| `coords` | `[x,y,z][]` | encoding=coords 时必填 | 显式坐标列表 |
| `meta` | object | 否 | 自由附加信息，默认填充 `author`/`difficulty` |

## 3. `layers` 编码（推荐，手写直观）

结构是 `layers[y][z][x]`：

- 外层数组共 `H` 项，`layers[0]` 是**最底层**，自下而上。
- 每层是 `D` 个字符串（`z` 从 0 到 D-1）。
- 每个字符串长 `W` 个字符（`x` 从 0 到 W-1）。

字符语义：

- 实心（属于最终造型，必须保留）：`#`、`X`、`x`、`1`、`*`
- 空（需要被凿除）：`.`、空格、`_`、`-`、`0`

示例（3×3×3，解是一个 2×2×2 的小方块，贴在 x/z 的 0..1、y 的 0..1）：

```json
{
  "formatVersion": 1,
  "id": "tutorial-cube",
  "name": "教学：小方块",
  "size": [3, 3, 3],
  "encoding": "layers",
  "layers": [
    ["##.", "##.", "..."],
    ["##.", "##.", "..."],
    ["...", "...", "..."]
  ],
  "meta": { "author": "builtin", "difficulty": 1 }
}
```

## 4. `coords` 编码（适合稀疏造型/工具导出）

```json
{
  "id": "demo",
  "size": [4, 4, 4],
  "encoding": "coords",
  "coords": [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0]
  ]
}
```

## 5. 校验规则（全部会抛出带关卡 id 与出错位置的错误）

1. 顶层必须是 JSON 对象；`formatVersion` 必须为 1。
2. `size` 必须是三个正整数，单轴 ≤ 16，总格子数 ≤ 4096。
3. `encoding` 只能是 `layers` / `coords`。
4. `layers` 层数必须等于 `H`；每层行数必须等于 `D`；每行字符数必须等于 `W`。
5. `layers` 中出现未知字符 → 报错并指出 `layers[y][z]` 的第几个字符。
6. `coords` 中的项必须是三元整数数组、不得越界、不得重复。
7. 解不能为空，也不能占满整个长方体（否则关卡无意义）。

## 6. 解析产物（运行时唯一消费的结构）

```js
/**
 * @typedef {Object} LevelData
 * @property {string} id
 * @property {string} name
 * @property {{W,H,D,count,strideY,strideZ}} grid
 * @property {Uint8Array} solution   // 长度 = grid.count，1 = 属于最终造型
 * @property {HintSet} hints         // 自动推导的提示 + visible 隐藏掩码
 * @property {number[]} palette      // 最终配色（0xrrggbb 整数）
 * @property {Uint8Array} colorIndex // 每格在 palette 中的下标（仅解方块有意义）
 * @property {string} trivia         // 通关演出展示的冷知识
 * @property {number} solidCount     // 初始实心方块数（= grid.count）
 * @property {number} solutionCount  // 解方块数
 * @property {Object} meta
 */
```

## 7. 提示数字与可解性（重要）

**提示数字不写在模板里**，也不允许手写。提示是造型的函数，由
`src/puzzle/HintModel.js` 的 `computeHints(grid, solution)` 在解析时自动推导
（数字 = 该线的方块总数；1 段裸数字、恰好 2 段加圆圈、≥3 段加方框；**0 也会显示**）。

模板里唯一与提示有关的字段是 `hiddenHints`：哪些线的提示被**整行隐藏**。
它由 `npm run prune:levels` 离线算出并写回，因为"哪条提示是冗余的"必须
藏掉它再跑一遍求解器才能确认，一关要跑上百次传播。裁剪受三条约束保护
（每个解方块 ≥2 条可见线、方框提示永不隐藏、难度上限 4.6），
详见 [`puzzle-generation.md`](./puzzle-generation.md) §2.2。

```jsonc
"hiddenHints": {          // 每个轴一组线号，语义见 puzzle-generation.md §2
  "x": [0, 1, 12, 13],
  "y": [0, 3, 5],
  "z": [1, 2, 4]
}
```

游戏里"空白的面"因此有唯一含义：**这条线的提示被故意藏起来了**。

但**能算出提示 ≠ 谜面可解**。新增或修改造型后请跑：

```bash
npm run audit:levels        # 输出每关的可解性结论与难度
npm run prune:levels        # 重算 hiddenHints（改过造型就必须重跑）
npm run audit:levels:fix    # 对不合格关卡做最小改动修复并写回
```

- 合格标准：**唯一解，且只靠逐线推理就能完成，全程无需猜测**（判定与难度模型见
  [`puzzle-generation.md`](./puzzle-generation.md)）。
- ⚠️ **改了 `layers` 却没重跑 `prune:levels`**，旧的 `hiddenHints` 会失配，
  可能藏掉不该藏的提示。两道防线会立刻发现：`audit:levels` 标 `✗`；
  游戏加载该关时 `console.warn` 并把 HUD 上的结论标红。
- 浏览器里加 `?audit=1` 可以把全部内置关卡的校验结果 `console.table` 出来。

## 8. 最终配色与冷知识

造型完成后要展示颜色，并在通关演出时显示一段冷知识：

```jsonc
"palette": ["#ffd447", "#ff8c26", "#2b2b31"],   // 最多 9 色
"colors": [                                      // 可省略，与 layers 同形
  ["........", "........", "........", "........"],
  ["........", "......22", "......22", "........"]
],
"trivia": "小黄鸭最早是实心橡胶做的，根本浮不起来…"
```

- `colors` 的字符：`'1'`..`'9'` 索引 `palette`；`'.'`、`' '`、`'0'` 都等价于 `'1'`。
  所以"整层都是主色"的图层直接写一片点，只有换色的格子写数字。
- **省略 `colors`** 时按高度均分调色板：单色 → 一片纯色；
  多色 → 自下而上的分层渐变（`stress-10` 就靠这个拿到 5 色渐变塔）。
- 省略 `palette` 时用默认暖砂色。
- 配色要**避开两个颜色**：未处理方块的 `#ded8cb`、标记色 `#f0a94b`。
  偏白的配色请用足够亮的白（如 `#fbf6ea`），否则和未处理方块分不出来。

## 9. 新增关卡步骤

1. 在 `src/level/levels/` 新建 `my-level.json`。
2. 填 `size`，用 `layers` 逐层画出造型（从底层开始）。
3. 跑 `npm run report:shapes` 做**造型体检**，确认两件事：
   - **方框数 > 0** —— 方框提示（≥3 段）是造型的固有性质，裁剪阶段变不出来。
     可靠手法是让一条线穿过三个分离的柱体（不等高的蜡烛 / 桥墩 / 仙人掌手臂）。
   - **对称列是 `--`** —— 镜像对称造型的推理量实质减半，玩家推出一半就能照抄另一半。
4. 加 `palette`（+ 需要时的 `colors`）与 `trivia`。
5. 跑 `npm run audit:levels` 确认这一关是 `✓`；不是就加 `--fix`。
6. 跑 `npm run prune:levels` 生成 `hiddenHints`，再跑一次 `audit:levels` 复核难度。
7. 保存 → Vite HMR 自动生效，在右上角 HUD 的关卡下拉里选择即可。
8. 若格式有误，控制台会打印 `[关卡 my-level] ...` 的具体原因，且**不影响其他关卡**加载。

`meta.order` 决定它在下拉列表与数字键 1–9 里的位置，请按难度递增排（性能测试关用 99）。

> ⚠️ 用编辑器/脚本改 JSON 时注意**不要写入 UTF-8 BOM**。PowerShell 的
> `Set-Content -Encoding UTF8` 会加 BOM，`JSON.parse` 会直接报
> `Unexpected token '\uFEFF'`。要么用 `[System.Text.UTF8Encoding]::new($false)`，
> 要么就让 `prune:levels` 去写回（它用 Node 的 `writeFileSync`，天然无 BOM）。

## 10. 预留扩展位

以下字段将在后续加入，追加到同级即可，不破坏现有解析：

- `timeLimit`：限时（秒）。
- `initialStates`：预置的涂色/已凿除状态（教学关引导用）。
- `meta.audit`：审计/裁剪工具写入的结论（只读，不参与逻辑）。
