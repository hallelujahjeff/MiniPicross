# 立体绘图方块 · Picross 3D

用 [three.js](https://threejs.org/) 实现的 3D 数字绘图（Picross 3D / 立体ピクロス）玩法原型。
从一整块长方体里，按各面的提示数字凿掉多余方块，把隐藏的造型挖出来。

## 快速开始

```bash
npm install
npm run dev        # 打开 http://localhost:5173/
```

## 玩法

打开后是**选关界面**——一面软木板墙，上面用 washi 胶带斜贴着一张张剪贴画卡片。
按顺序凿出每个造型，收藏墙就慢慢被填满。

- 卡片未完成时**只显示问号 + 星级**（不剧透造型是什么）
- 卡片锁住 = 上一关还没通；通关后下一关自动解锁
- 完成时该卡片长出**最终模型贴图 + 名称**，并播放一次入场闪烁
- 点卡片进入关卡。在关卡里只有**操作说明 + 当前进度**——看不见造型叫什么、关卡叫什么；都要靠玩家自己凿出来
- 通关后顶部出现模型名 + 底部出现冷知识，**点"回到选关界面"**回收藏墙

## 操作

| 操作 | 行为 |
| --- | --- |
| **左键**点方块 | 凿除。非造型方块 → 碎裂；造型方块 → 失误（闪红并自动标记，方块不消失） |
| **Ctrl + 左键** | 标记 / 取消标记（已标记的方块凿不掉，防手滑） |
| 拖底部滑块 | 进入截面模式查看内部。X / Z 各两个滑块，可夹成单层薄片；同一时刻只能切一个轴 |
| **右键拖拽 / 滚轮** | 转视角 / 缩放（左键完全留给玩法） |
| `Esc` | 恢复完整显示 |

URL 参数：`?level=duck`（调试直达某关）、`?audit=1`（控制台打印全部关卡的可解性审计）、`?debug=1`。

## 可解性保证

所有关卡都满足**唯一解 且 全程无需猜测**——"无需猜测"被严格定义为
*只用逐线约束传播就能把每一格定下来*。判定、难度模型与提示裁剪算法见
[`docs/puzzle-generation.md`](docs/puzzle-generation.md)。

10 个内置关卡里，除教学关与性能测试关外，难度落在 3.18 ~ 4.08（适中 ~ 有挑战），
推理链深度（波次）3 ~ 7。

```bash
npm run audit:levels     # 审计全部关卡的可解性与难度
npm run report:shapes    # 造型体检：分段分布（方框提示来源）与镜像对称性
npm run prune:levels     # 重算可隐藏的提示行（改过造型必须重跑）
npm run test:generator   # 随机造型生成器冒烟测试
npm run test:repair      # 最小改动修复算法冒烟测试
```

## 部署到 GitHub Pages

纯静态项目，通过 GitHub Actions 自动部署：

1. 在仓库 **Settings → Pages** 里，把 Source 设为 **GitHub Actions**。
2. 推送到 `main`（或点 Actions 里的 *Run workflow* 手动触发）。

构建产物会自动发布到 `https://<用户名>.github.io/MiniPicross/`。
子路径前缀由工作流里的 `BASE_PATH=/MiniPicross/` 注入（见
`.github/workflows/deploy-pages.yml`）；本地 `npm run dev` / `npm run build`
不受影响，默认仍是 `/`。

## 目录

```
src/
  core/     网格坐标、方块状态、体素射线、随机数
  puzzle/   提示模型、求解/验证器、难度评估、生成器、截面范围
  level/    关卡模板解析与校验
  render/   实例化方块、表面数字贴花、碎裂特效、截面手柄、通关镜头、缩略图
  input/    相机控制与交互
  audio/    WebAudio 实时合成音效（零资源）
  ui/       GameHud（关卡内 HUD）、LevelSelect（选关界面）、进度持久化
tools/      离线关卡审计工具、造型体检工具、浏览器端到端验收脚本
docs/       设计与验收文档
```

## 文档

- [`docs/puzzle-generation.md`](docs/puzzle-generation.md) — 谜面规则、可解性验证、难度模型、提示裁剪
- [`docs/level-template.md`](docs/level-template.md) — 关卡 JSON 格式与新增关卡流程
- `docs/acceptance-step*.md` — 各阶段验收清单与实测数据
