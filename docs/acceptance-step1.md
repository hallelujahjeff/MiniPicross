# 步骤 1 验收清单（批量方块渲染 + 关卡模板导入）

本清单供 Review 使用，每条都可判定。范围**仅限步骤 1**：整数坐标系、关卡模板格式与导入流程、
批量方块渲染管线、乳白亚光圆润视觉、自制模板跑通。提示数字/凿除交互/失误计时/胜负判定
**不属于本步骤**，若被实现即为越界。

## 一、整数坐标系（`src/core/GridCoords.js`）

| # | 判定项 | 期望 |
| --- | --- | --- |
| 1.1 | 坐标为整数三元组，尺寸由 `createGrid([W,H,D])` 描述 | `x∈[0,W) y∈[0,H) z∈[0,D)`，非正整数尺寸抛错 |
| 1.2 | 线性索引与坐标互为逆运算 | `coordsOf(indexOf(x,y,z)) === (x,y,z)`，全网格遍历一致 |
| 1.3 | 索引布局为 X 变化最快 | `index = x + y*W + z*W*H`，`strideY=W`、`strideZ=W*H` |
| 1.4 | 世界坐标居中映射 | 几何中心恒为原点，故 `OrbitControls.target` 可锁 (0,0,0) |
| 1.5 | 三轴取线工具已就位（供后续算提示） | `lineOf/forEachLine` 的 `start/step/length` 与轴向匹配 |
| 1.6 | 该模块不依赖 three | 只 import 无（纯函数） |

## 二、关卡模板格式与解析（`src/level/`）

| # | 判定项 | 期望 |
| --- | --- | --- |
| 2.1 | 关卡是独立数据文件 | `src/level/levels/*.json`，见 `docs/level-template.md` |
| 2.2 | 支持两种编码 | `layers` 分层字符画（`layers[y][z][x]`，y 自下而上）与 `coords` 坐标列表 |
| 2.3 | 严格校验，不静默容错 | 尺寸非法/层数行数字符数不匹配/非法字符/坐标越界/坐标重复/解为空/解占满 → 抛错 |
| 2.4 | 错误信息可定位 | 含关卡 id 与具体位置（`layers[y][z]` 第几个字符 或 `coords[i]` 的值） |
| 2.5 | 解析产物结构稳定 | `{id,name,grid,solution:Uint8Array,solidCount,solutionCount,meta}` |
| 2.6 | 单关损坏不影响其他关 | `LevelLoader` 逐关 try/catch，错误关在 HUD 下拉中禁用并标注 |
| 2.7 | 新增关卡零代码改动 | `import.meta.glob('./levels/*.json')` 自动收集，支持 HMR |
| 2.8 | 状态用 TypedArray | `PuzzleModel.states` 为 `Uint8Array`，状态位集中定义在 `core/BlockState.js` |

## 三、渲染管线（`src/render/`）

| # | 判定项 | 期望 | 实测 |
| --- | --- | --- | --- |
| 3.1 | 全部方块 1 个 draw call | 单个 `InstancedMesh`，共享一份几何体+材质 | ✅ 谜题 1 call（另 1 call 为接影地面，`renderer.info.render.calls = 2`） |
| 3.2 | 1000 方块不掉帧 | ≥55 FPS | ✅ 10×10×10 满实心、持续旋转 2 秒采样 **60 FPS** |
| 3.3 | 三角面开销可控 | 108 三角/方块（`segments=1`） | ✅ 1000 方块 = **108,000** 三角 |
| 3.4 | 单块增删为 O(1) | 尾部交换 + `count--`，不重建 buffer | ✅ 凿除 100 块后 `visibleCount` 1000→900，反查槽位 0 得到未被凿除的方块 |
| 3.5 | 增量同步 | 每帧只处理 `dirty` 集合，无改动时不置 `needsUpdate` | 见 `PuzzleRenderer.syncFromModel()` |
| 3.6 | 拾取可反查坐标 | `getBlockIndexByInstanceId` / `getBlockCoordsByInstanceId` | 已提供，供后续凿除交互 |
| 3.7 | 包围球手动设置 | 避免动态实例的剔除误判 | `mesh.boundingSphere` 显式赋值 + `frustumCulled = true` |
| 3.8 | 反复切关无资源泄漏 | 几何体/材质常驻，`InstancedMesh` 单独销毁 | ✅ 连续加载 11 次后 `geometries 2→2, textures 2→2, programs 3→3` |

## 四、视觉（乳白亚光圆润）

| # | 判定项 | 期望 |
| --- | --- | --- |
| 4.1 | 乳白象牙主色 | `MeshStandardMaterial color 0xF3EDE1` |
| 4.2 | 亚光、无金属感 | `roughness 0.82`、`metalness 0` |
| 4.3 | 边缘圆润 | `RoundedBoxGeometry(1,1,1,1,0.085)` |
| 4.4 | 柔和棚拍光 | `RoomEnvironment` + `PMREMGenerator` 烘 IBL（生成器用完即 dispose，envMap 缓存复用） |
| 4.5 | 方块层次分明可数 | 主方向光投影 + 圆角形成 hairline 缝隙，见截图 |
| 4.6 | 接地阴影而非可见地板 | `ShadowMaterial` 平面，随关卡高度自动贴到造型底面 |
| 4.7 | 深中性灰背景 | `0x22252A`，无渐变无网格（`?debug=1` 才显示辅助线） |

## 五、流程跑通（自制模板）

| 关卡 | 尺寸 | 实心 | 解 | 三角面 | Draw Call | 截图 |
| --- | --- | --- | --- | --- | --- | --- |
| `tutorial-cube` 教学：小方块 | 3×3×3 | 27 | 8 | 2,916 | 1 | `screenshots/01-tutorial-cube.png` / `01b-...-solution.png` |
| `heart` 心形 | 7×6×3 | 126 | 59 | 13,608 | 1 | `screenshots/02-heart.png` / `sol-heart.png` |
| `duck` 小鸭子 | 8×8×4 | 256 | 118 | 27,648 | 1 | `screenshots/sol-duck.png` |
| `mug` 马克杯 | 6×6×4 | 144 | 88 | 15,552 | 1 | `screenshots/sol-mug.png` |
| `stress-10` 阶梯塔 | 10×10×10 | 1000 | 440 | 108,000 | 1 | `screenshots/05-stress-10-solid.png` / `sol-stress-10.png` |

验收操作方式：`npm run dev` → 右上角 HUD 下拉或数字键 1-9 切换关卡；勾选"显示造型解（R）"
把非解方块一次性凿除，用于核对模板是否被正确解析（同时也验证了 O(1) 实例压缩通道）。

自动化复测：dev 环境下 `window.__picross` 暴露了 App 实例（`import.meta.env.DEV` 时才挂载），
可在浏览器控制台直接驱动断言，无需额外脚手架。常用复测片段：

```js
const app = window.__picross;
// 切关不泄漏、draw call 恒为 1
for (const id of ["tutorial-cube","heart","duck","mug","stress-10"]) {
  await app.loadLevel(id);
  console.log(id, app.puzzleRenderer.getRenderStats());
}
// 槽位压缩后双向映射自洽
const pr = app.puzzleRenderer, pm = app.puzzle;
pm.solution.forEach((v, i) => v === 0 && pm.removeBlock(i));
pr.syncFromModel();
console.log(pr.slotToBlock.slice(0, pr.visibleCount)
  .every((b, s) => b >= 0 && pr.blockToSlot[b] === s));
```

注意：`BufferAttribute.needsUpdate` 只有 setter，读取恒为 `undefined`；
要断言"是否标脏"必须比较 `instanceMatrix.version` / `instanceColor.version` 是否递增。

## 六、健壮性与工程质量

| # | 判定项 | 期望 |
| --- | --- | --- |
| 6.1 | 控制台无报错 | 仅 `favicon.ico` 404（无 favicon 资源，不影响运行） |
| 6.2 | 容器缺失兜底 | `main.js` 找不到 `#app`/`#hud` 时自动创建 |
| 6.3 | 尺寸自适应基于容器 | `ResizeObserver` + window resize 双保险，0 尺寸兜底避免 NaN aspect |
| 6.4 | 启动失败可见 | 页面显示 `.fatal-overlay` 错误浮层，而非静默白屏 |
| 6.5 | 启动自检 | `validateAllLevels()` 一次性校验全部模板，失败列表 `console.error` 汇总 |
| 6.6 | 日志克制 | 成功信息仅在 `?debug=1` 下打印一行统计，不刷屏 |
| 6.7 | HMR 不泄漏上下文 | `import.meta.hot.dispose` 调用 `app.dispose()` |
| 6.8 | 模块边界清晰 | `core → level → puzzle → render → App`；`core/level/puzzle` 均不依赖 three |
| 6.9 | 无遗留脚手架 | `src/objects/` 目录（含 `Cube.js`）已整体删除；`GridHelper/AxesHelper` 收到 `?debug=1` 开关后默认关闭 |
| 6.10 | 未越界实现后续步骤 | 无提示数字计算、无凿除输入绑定（左键仍留空）、无失误/计时/胜负 UI |

## 七、Review 返工记录

`code-explorer` 审查结论为**通过**（无严重缺陷）。以下 8 项在结论出具后已全部修复并复测：

| 问题 | 修复 | 复测结果 |
| --- | --- | --- |
| `listLevels()` 快照早于 `validateAllLevels()`，坏模板在 HUD 里不会被标灰禁选 | `App.init` 中把自检提到取清单之前 | 6.5/2.6 生效 |
| 槽位尾部交换改写了实例色但只标脏了 `instanceMatrix` | `removeBlockVisual` 交换分支内同时标脏 `instanceColor` | 颜色随槽位正确搬运，`instanceColor.version` 2→3 |
| 并发切关时 `startDisappear` 覆盖旧 `onDone`，旧 `loadLevel` Promise 永不 settle | 覆盖前先结清旧回调 | 并发双请求 `both-settled`（150ms），最终关卡取后发起者 |
| 关卡解析失败后旧造型停在 `scale≈0`，形似黑屏 | `catch` 分支复位 `group.scale` | 载入不存在关卡后 `groupScale === 1` |
| `dispose()` 漏了 `controls.dispose()` 与 `contextmenu` 解绑 | 处理器存为字段并显式解绑 | — |
| `disposeAssets()` / `disposeEnvMap()` 全项目零调用 | 在 `App.dispose()` 末尾调用（仅整体卸载路径，切关不触发） | — |
| `getBlockIndexByInstanceId` 不拦 `NaN`；`restoreBlockVisual` 不校验 block 范围 | 统一用 `Number.isInteger` 做入参校验 | `-1 / visibleCount / NaN / null` 均返回 `-1` |
| 非法字符报错文案漏列小写 `x` 别名 | 文案补齐 | — |

返工后完整复测（11 次连续切关 + 并发切关 + 全量凿除 + 压力关帧率）：
draw call 恒为 1；`mug` 凿除 56 块后 144→88，双向映射 mismatch 0、`mesh.count` 同步；
`stress-10` 1000 实例 / 108,000 三角 / **60 FPS**；控制台 0 错误 0 警告。
