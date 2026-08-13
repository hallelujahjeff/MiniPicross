import { createGrid, indexOf, lineOf } from "../core/GridCoords.js";
import { Rng, randomSeed } from "../core/Rng.js";
import { AXES, computeHints, lineDims } from "./HintModel.js";
import { analyzePuzzle, solveByPropagation, UNKNOWN } from "./PuzzleSolver.js";

/**
 * 谜面生成器（纯数据，不依赖 three）
 *
 * ## 调研结论：什么可以随机，什么不能
 * 提示数字是造型的**函数**（见 HintModel.computeHints），给定造型，提示唯一确定。
 * 所以"给同一个关卡换一套不同的谜面"在规则上不存在——能随机的只有**造型本身**。
 * 参考的开源实现（nathsou/Picross3D）也只提供求解器、手工编辑器和
 * "OBJ 模型 → 体素 → 谜面"的转换，没有随机生成器。
 *
 * 因此本项目走两条路：
 *  1. **内置美术关卡**：造型人为设定（鸭子/杯子/心形…），提示自动推导，
 *     再用求解器验证可解性，不合格的用 repairSolution 做最小改动修复。
 *  2. **随机关卡**：本模块随机生成造型，"生成即验证"，只产出
 *     「唯一解 + 全程无需猜测 + 难度落在目标区间」的谜面。
 *
 * ## 为什么不能纯随机撒点
 * 纯随机噪声造型的每条线都被切成很多段，提示满屏方框（≥3 段），
 * 既丑又几乎必然出现需要猜的局面。所以造型生成分三步：
 *   随机生长（团块）→ 形态平滑（去毛刺、填凹坑）→ 只保留最大连通块
 * 得到一个"像个东西"的实心团，其每条线大多是 1~2 段，天然好推理。
 */

/** 默认难度接受区间（PuzzleSolver.rateDifficulty 的 score，1.00~6.00） */
export const DEFAULT_DIFFICULTY_RANGE = [2.5, 4.0];
/** 默认理想难度：对齐内置"小鸭子"（2.61）略偏上，即"有挑战但不烧脑" */
export const DEFAULT_TARGET_SCORE = 3.05;

/**
 * 取一个格子的 6 邻域（写入 out，返回个数）
 * 内联坐标解码，避免在生成器的内层循环里反复建对象。
 */
function neighborsOf(grid, cell, out) {
  const z = (cell / grid.strideZ) | 0;
  const rest = cell - z * grid.strideZ;
  const y = (rest / grid.strideY) | 0;
  const x = rest - y * grid.strideY;
  let n = 0;
  if (x > 0) out[n++] = cell - 1;
  if (x < grid.W - 1) out[n++] = cell + 1;
  if (y > 0) out[n++] = cell - grid.strideY;
  if (y < grid.H - 1) out[n++] = cell + grid.strideY;
  if (z > 0) out[n++] = cell - grid.strideZ;
  if (z < grid.D - 1) out[n++] = cell + grid.strideZ;
  return n;
}

/** 6 邻域里实心的个数 */
function solidNeighborCount(grid, solid, cell, buf) {
  const n = neighborsOf(grid, cell, buf);
  let c = 0;
  for (let i = 0; i < n; i++) if (solid[buf[i]]) c++;
  return c;
}

/**
 * 团块生长：从中心附近的一个种子出发，沿前沿随机扩张到目标格数
 *
 * 前沿采样用"三选一取邻居最多者"，倾向于把凹处填平，得到紧实的团块
 * 而不是树枝状的分形——后者会让每条线被切成很多段，提示全是方框。
 */
function growBlob(grid, rng, target) {
  const solid = new Uint8Array(grid.count);
  const buf = new Int32Array(6);

  const seed = indexOf(
    grid,
    Math.floor(grid.W / 2),
    Math.floor(grid.H / 2),
    Math.floor(grid.D / 2),
  );
  solid[seed] = 1;
  let filled = 1;

  /** 前沿：与实心相邻的空格 */
  const frontier = [];
  const inFrontier = new Uint8Array(grid.count);
  const addFrontier = (cell) => {
    const n = neighborsOf(grid, cell, buf);
    for (let i = 0; i < n; i++) {
      const nb = buf[i];
      if (!solid[nb] && !inFrontier[nb]) {
        inFrontier[nb] = 1;
        frontier.push(nb);
      }
    }
  };
  addFrontier(seed);

  const nbBuf = new Int32Array(6);
  while (filled < target && frontier.length > 0) {
    // 三选一：取邻居实心数最多的候选，形成紧实团块
    let bestIdx = -1;
    let bestScore = -1;
    for (let t = 0; t < 3 && frontier.length > 0; t++) {
      const idx = rng.int(frontier.length);
      const score = solidNeighborCount(grid, solid, frontier[idx], nbBuf);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    }
    if (bestIdx < 0) break;

    const cell = frontier[bestIdx];
    frontier[bestIdx] = frontier[frontier.length - 1];
    frontier.pop();
    inFrontier[cell] = 0;

    if (solid[cell]) continue;
    solid[cell] = 1;
    filled++;
    addFrontier(cell);
  }

  return solid;
}

/**
 * 形态学平滑：去掉孤立毛刺、填掉被包住的凹坑
 * 直接目的是压低每条线的分段数（分段越少，提示越好读、推理越顺）。
 */
function smooth(grid, solid, passes = 2) {
  const buf = new Int32Array(6);
  let cur = solid;
  for (let p = 0; p < passes; p++) {
    const next = Uint8Array.from(cur);
    for (let cell = 0; cell < grid.count; cell++) {
      const n = solidNeighborCount(grid, cur, cell, buf);
      if (cur[cell]) {
        if (n <= 1) next[cell] = 0; // 只挂着一个邻居 → 毛刺
      } else if (n >= 5) {
        next[cell] = 1; // 六面被围了五面 → 凹坑，填上
      }
    }
    cur = next;
  }
  return cur;
}

/** 沿 X 轴镜像对称（造型更像"物件"，也让提示更规整） */
function mirrorX(grid, solid) {
  const out = Uint8Array.from(solid);
  for (let z = 0; z < grid.D; z++) {
    for (let y = 0; y < grid.H; y++) {
      for (let x = 0; x < grid.W; x++) {
        if (solid[indexOf(grid, x, y, z)]) {
          out[indexOf(grid, grid.W - 1 - x, y, z)] = 1;
        }
      }
    }
  }
  return out;
}

/** 只保留体积最大的 6 连通块，保证造型是"一个东西"而不是散落几坨 */
function keepLargestComponent(grid, solid) {
  const label = new Int32Array(grid.count).fill(-1);
  const buf = new Int32Array(6);
  const stack = [];
  let best = -1;
  let bestSize = 0;
  let current = 0;

  for (let start = 0; start < grid.count; start++) {
    if (!solid[start] || label[start] >= 0) continue;
    let size = 0;
    stack.length = 0;
    stack.push(start);
    label[start] = current;
    while (stack.length > 0) {
      const cell = stack.pop();
      size++;
      const n = neighborsOf(grid, cell, buf);
      for (let i = 0; i < n; i++) {
        const nb = buf[i];
        if (solid[nb] && label[nb] < 0) {
          label[nb] = current;
          stack.push(nb);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = current;
    }
    current++;
  }

  if (best < 0) return solid;
  const out = new Uint8Array(grid.count);
  for (let cell = 0; cell < grid.count; cell++) {
    if (solid[cell] && label[cell] === best) out[cell] = 1;
  }
  return out;
}

/**
 * 打孔：在"整段连续且够长"的线上掏掉中间 1~2 格
 *
 * 平滑后的团块几乎每条线都是一整段，提示全是裸数字 → 谜面偏送分。
 * 打孔专门制造"恰好 2 段"（圆圈提示）以及内部空腔，
 * 既提升难度，也是原作造型（杯柄、鸭嘴下的空隙）的主要趣味来源。
 * 只在连续段上打孔，是为了让新增的分段数可控，不至于一下变成满屏方框。
 */
function carveHoles(grid, solid, rng, wanted) {
  const out = Uint8Array.from(solid);
  let punched = 0;
  for (let t = 0; t < wanted * 8 && punched < wanted; t++) {
    const axis = AXES[rng.int(3)];
    const { uCount, vCount } = lineDims(grid, axis);
    const line = lineOf(grid, axis, rng.int(uCount), rng.int(vCount));

    let first = -1;
    let last = -1;
    let count = 0;
    for (let i = 0; i < line.length; i++) {
      if (out[line.start + i * line.step]) {
        if (first < 0) first = i;
        last = i;
        count++;
      }
    }
    if (first < 0 || count < 4 || count !== last - first + 1) continue;

    const holeLen = rng.range(1, Math.min(2, count - 2));
    const holeStart = rng.range(first + 1, last - holeLen);
    for (let i = 0; i < holeLen; i++) {
      out[line.start + (holeStart + i) * line.step] = 0;
    }
    punched++;
  }
  return out;
}

/** 随机子长方体：一定可解的兜底造型（所有 0 提示线清空后剩下的就是它自己） */
export function randomSubBox(grid, rng) {
  const solid = new Uint8Array(grid.count);
  const span = (n) => {
    const len = rng.range(Math.max(1, n - 2), Math.max(1, n - 1));
    const lo = rng.range(0, n - len);
    return [lo, lo + len - 1];
  };
  const [x0, x1] = span(grid.W);
  const [y0, y1] = span(grid.H);
  const [z0, z1] = span(grid.D);
  for (let z = z0; z <= z1; z++) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) solid[indexOf(grid, x, y, z)] = 1;
    }
  }
  return solid;
}

/** 造型里的实心格数 */
function countSolid(solution) {
  let n = 0;
  for (let i = 0; i < solution.length; i++) if (solution[i]) n++;
  return n;
}

/**
 * 只跑传播、只取"还剩多少格推不出来"，用于修复时的快速打分
 * @returns {number} 未定格数；矛盾返回 Infinity
 */
function residualUnknown(grid, solution) {
  const hints = computeHints(grid, solution);
  const res = solveByPropagation(grid, hints);
  return res.contradiction ? Infinity : res.unknown;
}

/**
 * 最小改动修复：把"需要猜"的造型改成"纯推理可解"
 *
 * 思路：传播卡住时，剩下的未定格子就是歧义所在。翻转其中一格会改写它所在
 * 三条线的提示，往往就能把歧义打开。每一轮在未定格里随机采样若干候选，
 * 逐个试翻转、取"未定格数下降最多"的那个真正落盘（贪心爬山）。
 *
 * 这样做的好处是**改动量可控**：内置美术关卡通常只需改动 0~3 格，
 * 造型轮廓基本不变。
 *
 * @param {Object} options
 * @param {import("../core/GridCoords.js").Grid} options.grid
 * @param {Uint8Array} options.solution 会被复制，不修改入参
 * @param {Rng} [options.rng]
 * @param {number} [options.maxFlips] 最多翻转多少格
 * @param {number} [options.sampleSize] 每轮采样多少候选
 * @param {number} [options.timeBudgetMs]
 * @returns {{ok:boolean, solution:Uint8Array, flips:number[], analysis:import("./PuzzleSolver.js").PuzzleAnalysis}}
 */
export function repairSolution({
  grid,
  solution,
  rng = new Rng(1),
  maxFlips = 24,
  sampleSize = 10,
  timeBudgetMs = 1500,
}) {
  const sol = Uint8Array.from(solution);
  const flips = [];
  const deadline = now() + timeBudgetMs;

  let analysis = analyzePuzzle(grid, sol, { countSolutionsOnStall: false });
  let stagnant = 0;

  while (!analysis.ok && flips.length < maxFlips && now() < deadline) {
    const states = analysis.propagation.states;
    const candidates = [];
    for (let i = 0; i < states.length; i++) if (states[i] === UNKNOWN) candidates.push(i);
    if (candidates.length === 0) break; // 矛盾类问题，翻转救不回来

    rng.shuffle(candidates);
    const tries = candidates.slice(0, Math.min(sampleSize, candidates.length));

    const baseline = analysis.propagation.unknown;
    let bestCell = -1;
    let bestScore = Infinity;
    for (const cell of tries) {
      sol[cell] ^= 1;
      const solid = countSolid(sol);
      // 造型不能空、也不能占满（否则关卡无意义，解析器也会拒绝）
      const score = solid === 0 || solid === grid.count ? Infinity : residualUnknown(grid, sol);
      sol[cell] ^= 1;
      if (score < bestScore) {
        bestScore = score;
        bestCell = cell;
        if (score === 0) break; // 一步到位
      }
    }

    if (bestCell < 0 || bestScore === Infinity) break;

    sol[bestCell] ^= 1;
    flips.push(bestCell);
    analysis = analyzePuzzle(grid, sol, { countSolutionsOnStall: false });

    if (analysis.propagation.unknown >= baseline) {
      // 允许一次平台期（有时要连翻两格才见效），连续无进展就放弃
      if (++stagnant >= 3) break;
    } else {
      stagnant = 0;
    }
  }

  if (analysis.ok) {
    // 出结论时补一次完整分析（含多解计数字段），供报告使用
    analysis = analyzePuzzle(grid, sol);
  }

  return { ok: analysis.ok, solution: sol, flips, analysis };
}

/**
 * 生成一个"可解 + 难度适中"的随机谜面
 *
 * 流程：随机造型 →（提示自动推导）→ 求解器验证 → 不可解则最小改动修复 →
 * 难度评分。单次尝试只要 1~3ms，因此不取"第一个合格的"，而是跑满预算
 * 从所有合格候选里挑**难度最接近目标**的一个，难度分布才稳定可控。
 *
 * @param {Object} [options]
 * @param {[number,number,number]} [options.size] 网格尺寸，默认在 5..7 之间随机
 * @param {number|string} [options.seed] 种子；缺省随机取，返回值里会带上实际用的种子
 * @param {number} [options.fillRatio] 目标实心占比，默认 0.42~0.55 随机
 * @param {"none"|"x"} [options.symmetry] 是否 X 轴镜像，默认按概率决定
 * @param {[number,number]} [options.difficultyRange] 难度 score 接受区间
 * @param {number} [options.targetScore] 理想难度分
 * @param {number} [options.maxRestarts] 最多尝试几个造型
 * @param {number} [options.timeBudgetMs] 总时间预算（超时就返回目前最好的合格谜面）
 * @returns {{grid:object, solution:Uint8Array, hints:object, analysis:object,
 *            seed:number, size:number[], attempts:number, candidates:number,
 *            repaired:number, fallback:boolean}}
 */
export function generatePuzzle(options = {}) {
  const seed = options.seed ?? randomSeed();
  const rng = new Rng(seed);

  const size = options.size ?? [rng.range(5, 7), rng.range(5, 7), rng.range(4, 6)];
  const grid = createGrid(size);

  const [dMin, dMax] = options.difficultyRange ?? DEFAULT_DIFFICULTY_RANGE;
  const target = options.targetScore ?? DEFAULT_TARGET_SCORE;
  const maxRestarts = options.maxRestarts ?? 28;
  const deadline = now() + (options.timeBudgetMs ?? 2500);

  /** 落在接受区间内、且离目标最近的候选 */
  let inBand = null;
  /** 任何合格（可解）候选中离区间最近的，用作兜底 */
  let nearest = null;
  let attempts = 0;
  let candidates = 0;

  for (let restart = 0; restart < maxRestarts; restart++) {
    if (restart > 0 && now() >= deadline) break;
    attempts++;

    const fillRatio = options.fillRatio ?? 0.4 + rng.next() * 0.16;
    const symmetry = options.symmetry ?? (rng.chance(0.5) ? "x" : "none");

    let solid = growBlob(grid, rng, Math.max(2, Math.round(grid.count * fillRatio)));
    if (symmetry === "x") solid = mirrorX(grid, solid);
    solid = smooth(grid, solid, rng.chance(0.5) ? 1 : 2);
    solid = keepLargestComponent(grid, solid);
    solid = carveHoles(grid, solid, rng, rng.range(2, 7));
    solid = keepLargestComponent(grid, solid);

    const filled = countSolid(solid);
    // 太空或占满都不成关卡；也拒绝"只剩几格"的退化造型
    if (filled < Math.max(3, grid.count * 0.12) || filled >= grid.count) continue;

    const repaired = repairSolution({
      grid,
      solution: solid,
      rng,
      maxFlips: 20,
      sampleSize: 8,
      timeBudgetMs: Math.max(120, deadline - now()),
    });
    if (!repaired.ok) continue;
    candidates++;

    const score = repaired.analysis.difficulty.score;
    const entry = {
      grid,
      solution: repaired.solution,
      hints: repaired.analysis.hints,
      analysis: repaired.analysis,
      seed,
      size: [grid.W, grid.H, grid.D],
      attempts,
      candidates,
      repaired: repaired.flips.length,
      fallback: false,
    };

    if (score >= dMin && score <= dMax) {
      const gap = Math.abs(score - target);
      if (!inBand || gap < inBand.gap) inBand = { entry, gap };
      if (gap <= 0.2) break; // 足够贴目标，不必再找
    } else {
      const distance = score < dMin ? dMin - score : score - dMax;
      if (!nearest || distance < nearest.distance) nearest = { entry, distance };
    }
  }

  const chosen = inBand?.entry ?? nearest?.entry;
  if (chosen) {
    chosen.attempts = attempts;
    chosen.candidates = candidates;
    return chosen;
  }

  // 全部尝试都没成：退回随机子长方体，它在规则上一定可解
  const solid = randomSubBox(grid, rng);
  const analysis = analyzePuzzle(grid, solid);
  return {
    grid,
    solution: solid,
    hints: analysis.hints,
    analysis,
    seed,
    size: [grid.W, grid.H, grid.D],
    attempts,
    candidates,
    repaired: 0,
    fallback: true,
  };
}

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
