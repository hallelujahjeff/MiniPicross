import { lineOf, coordsOf } from "../core/GridCoords.js";
import { Rng } from "../core/Rng.js";
import {
  AXES,
  MARK_PLAIN,
  MARK_CIRCLE,
  MARK_SQUARE,
  computeHints,
  lineCount,
  lineDims,
  lineKeyOfCell,
} from "./HintModel.js";
import { getLineMasks } from "./LineMasks.js";

/**
 * 谜面求解器 / 可解性验证器（纯数据，不依赖 three）
 *
 * ## 为什么需要它
 * 提示数字是造型的函数，随便画一个造型都能算出提示；但**能算出提示 ≠ 谜面可解**。
 * 一个坏谜面会出现两种情况：
 *   1. 多解——提示无法唯一确定造型，玩家只能猜；
 *   2. 唯一解但需要试错——必须假设某格、往下推、矛盾了再回退（俗称"猜"）。
 * 本模块把"不需要猜"定义为：**只用逐线约束传播就能把每一格都定下来**。
 *
 * ## 逐线约束传播（line propagation）
 * 每条线的提示 (count, mark) 决定了一个合法位掩码集合（见 LineMasks）。
 * 结合线上已知格子，筛掉不相容的候选，然后取交集：
 *   - 所有候选都是 1 的位 → 该格必然保留
 *   - 所有候选都是 0 的位 → 该格必然凿除
 * 任何一格被定下来，就把穿过它的另两条线重新入队，直到不动点。
 *
 * 这些推断全是**强制**的（不含假设），所以：
 *   传播能把全部格子定下来 ⇒ 解唯一 且 全程无需猜测。
 * 反之若传播卡住，再用回溯计数区分"多解"与"唯一解但要试错"，用于报告与修复。
 */

/** 格子状态：未定 */
export const UNKNOWN = 0;
/** 格子状态：确定保留（属于最终造型） */
export const KEEP = 1;
/** 格子状态：确定凿除 */
export const GONE = 2;

/** @type {WeakMap<object, LineTable>} 按 grid 缓存线表 */
const lineTableCache = new WeakMap();

/**
 * 线表：把"三个轴 × 每轴所有线"摊平成一维，并预存每个格子所属的三条线
 *
 * 传播的热路径是"某格定下来 → 唤醒它的另两条线"，因此 cellLines 预计算
 * 是最关键的一处优化（否则每次都要 coordsOf + lineKeyOfCell）。
 */
class LineTable {
  /** @param {import("../core/GridCoords.js").Grid} grid */
  constructor(grid) {
    this.grid = grid;
    this.axisOffset = new Int32Array(3);

    let offset = 0;
    for (const axis of AXES) {
      this.axisOffset[axis] = offset;
      offset += lineCount(grid, axis);
    }
    this.totalLines = offset;

    this.starts = new Int32Array(this.totalLines);
    this.steps = new Int32Array(this.totalLines);
    this.lengths = new Int32Array(this.totalLines);
    this.axisOf = new Uint8Array(this.totalLines);
    this.keyOf = new Int32Array(this.totalLines);

    for (const axis of AXES) {
      const { uCount, vCount } = lineDims(grid, axis);
      for (let v = 0; v < vCount; v++) {
        for (let u = 0; u < uCount; u++) {
          const key = u + v * uCount;
          const id = this.axisOffset[axis] + key;
          const line = lineOf(grid, axis, u, v);
          this.starts[id] = line.start;
          this.steps[id] = line.step;
          this.lengths[id] = line.length;
          this.axisOf[id] = axis;
          this.keyOf[id] = key;
        }
      }
    }

    // 每个格子的三条线 id：cellLines[cell * 3 + axis]
    this.cellLines = new Int32Array(grid.count * 3);
    const c = { x: 0, y: 0, z: 0 };
    for (let cell = 0; cell < grid.count; cell++) {
      coordsOf(grid, cell, c);
      for (const axis of AXES) {
        this.cellLines[cell * 3 + axis] =
          this.axisOffset[axis] + lineKeyOfCell(grid, axis, c.x, c.y, c.z);
      }
    }
  }
}

/** 取得（并缓存）某个网格的线表 */
export function getLineTable(grid) {
  let table = lineTableCache.get(grid);
  if (!table) {
    table = new LineTable(grid);
    lineTableCache.set(grid, table);
  }
  return table;
}

/**
 * @typedef {Object} PropagationResult
 * @property {Uint8Array} states     每格的 UNKNOWN / KEEP / GONE
 * @property {boolean} contradiction 是否推出矛盾（提示与已知状态不相容）
 * @property {number} unknown        仍未定的格子数（0 = 完全解出）
 * @property {number} waves          传播波次（推理链深度，难度的主要来源）
 * @property {number} lineSolves     线求解次数
 * @property {number} deductions     推断出的格子数
 * @property {number} maxCandidates  产生推断时单条线的最大候选数
 * @property {number} hardDeductions 候选数 > HARD_CANDIDATES 的推断次数
 * @property {number} firstWaveCells 第一波（只看单条线、不依赖任何推断）就定下的格子数
 */

/** 候选数超过这个值的推断，人类需要真正做分支枚举，计为"硬推断" */
export const HARD_CANDIDATES = 6;

/**
 * 逐线约束传播到不动点
 *
 * @param {import("../core/GridCoords.js").Grid} grid
 * @param {import("./HintModel.js").HintSet} hints
 * @param {{initial?: Uint8Array}} [options] initial 可传入玩家当前进度，用于"求助/校验"
 * @returns {PropagationResult}
 */
export function solveByPropagation(grid, hints, options = {}) {
  const table = getLineTable(grid);
  const states = options.initial
    ? Uint8Array.from(options.initial)
    : new Uint8Array(grid.count);

  let unknown = 0;
  for (let i = 0; i < states.length; i++) if (states[i] === UNKNOWN) unknown++;

  // 环形队列：inQueue 去重后队内元素不会超过线总数
  const cap = table.totalLines + 1;
  const ring = new Int32Array(cap);
  const inQueue = new Uint8Array(table.totalLines);
  let head = 0;
  let tail = 0;
  let size = 0;

  const push = (id) => {
    if (inQueue[id]) return;
    // 被整行隐藏的提示对玩家不可见，就不能当作已知条件——直接不入队
    if (hints.visible[table.axisOf[id]][table.keyOf[id]] === 0) return;
    inQueue[id] = 1;
    ring[tail] = id;
    tail = tail + 1 === cap ? 0 : tail + 1;
    size++;
  };

  for (let id = 0; id < table.totalLines; id++) push(id);

  let waves = 0;
  let waveRemaining = size;
  let lineSolves = 0;
  let deductions = 0;
  let maxCandidates = 0;
  let hardDeductions = 0;
  let firstWaveCells = 0;
  let contradiction = false;

  while (size > 0) {
    const id = ring[head];
    head = head + 1 === cap ? 0 : head + 1;
    size--;
    inQueue[id] = 0;

    lineSolves++;

    const axis = table.axisOf[id];
    const key = table.keyOf[id];
    const count = hints.counts[axis][key];
    const mark = hints.marks[axis][key];
    const start = table.starts[id];
    const step = table.steps[id];
    const len = table.lengths[id];

    // 收集线上已知位
    let keepMask = 0;
    let goneMask = 0;
    for (let i = 0; i < len; i++) {
      const s = states[start + i * step];
      if (s === KEEP) keepMask |= 1 << i;
      else if (s === GONE) goneMask |= 1 << i;
    }

    const masks = getLineMasks(len, count, mark);
    let allOnes = -1;
    let allZeros = -1;
    let candidates = 0;
    for (let m = 0; m < masks.length; m++) {
      const mask = masks[m];
      // 候选要求某格保留，但该格已确定凿除 → 不相容
      if ((mask & goneMask) !== 0) continue;
      // 候选要求某格凿除，但该格已确定保留 → 不相容
      if ((keepMask & ~mask) !== 0) continue;
      allOnes &= mask;
      allZeros &= ~mask;
      candidates++;
    }

    if (candidates === 0) {
      contradiction = true;
      break;
    }

    const full = len >= 32 ? -1 : (1 << len) - 1;
    const forceKeep = allOnes & full & ~keepMask;
    const forceGone = allZeros & full & ~goneMask;
    const newBits = forceKeep | forceGone;

    if (newBits !== 0) {
      if (candidates > maxCandidates) maxCandidates = candidates;
      if (candidates > HARD_CANDIDATES) hardDeductions++;

      for (let i = 0; i < len; i++) {
        const bit = 1 << i;
        if ((newBits & bit) === 0) continue;
        const cell = start + i * step;
        states[cell] = (forceKeep & bit) !== 0 ? KEEP : GONE;
        unknown--;
        deductions++;
        if (waves === 0) firstWaveCells++;
        // 唤醒穿过该格的另两条线
        const base = cell * 3;
        for (const other of AXES) {
          const otherId = table.cellLines[base + other];
          if (otherId !== id) push(otherId);
        }
      }
    }

    waveRemaining--;
    if (waveRemaining <= 0) {
      waves++;
      waveRemaining = size;
    }
  }

  return {
    states,
    contradiction,
    unknown,
    waves,
    lineSolves,
    deductions,
    maxCandidates,
    hardDeductions,
    firstWaveCells,
  };
}

/**
 * 回溯计数：谜面到底有几个解（仅用于诊断"多解"还是"唯一但要试错"）
 *
 * 每一层先跑一次传播压缩搜索空间，再对最靠前的未定格子分支。
 * 有节点预算，超预算返回 truncated = true（宁可报告"不确定"也不卡死浏览器）。
 *
 * @returns {{count:number, truncated:boolean, nodes:number}}
 */
export function countSolutions(grid, hints, limit = 2, nodeBudget = 1500) {
  let nodes = 0;
  let truncated = false;

  const search = (initial) => {
    if (nodes++ > nodeBudget) {
      truncated = true;
      return 0;
    }
    const res = solveByPropagation(grid, hints, { initial });
    if (res.contradiction) return 0;
    if (res.unknown === 0) return 1;

    let branchCell = -1;
    for (let i = 0; i < res.states.length; i++) {
      if (res.states[i] === UNKNOWN) {
        branchCell = i;
        break;
      }
    }
    if (branchCell < 0) return 1;

    let found = 0;
    for (const value of [KEEP, GONE]) {
      const next = Uint8Array.from(res.states);
      next[branchCell] = value;
      found += search(next);
      if (found >= limit || truncated) break;
    }
    return found;
  };

  const count = search(undefined);
  return { count, truncated, nodes };
}

/**
 * @typedef {Object} PuzzleAnalysis
 * @property {boolean} ok            谜面是否合格（唯一解且全程无需猜测）
 * @property {string} verdict        结论标识：solvable / needsGuess / multipleSolutions / contradiction
 * @property {string} message        中文结论说明
 * @property {import("./HintModel.js").HintSet} hints
 * @property {PropagationResult} propagation
 * @property {{score:number, level:number, label:string, metrics:object}} difficulty
 * @property {{count:number, truncated:boolean}|null} solutions 仅在传播卡住时才计算
 */

/**
 * 完整分析一个谜面：算提示 → 验证可解性 → 评估难度
 *
 * @param {import("../core/GridCoords.js").Grid} grid
 * @param {Uint8Array} solution
 * @param {{hints?: import("./HintModel.js").HintSet, countSolutionsOnStall?: boolean}} [options]
 * @returns {PuzzleAnalysis}
 */
export function analyzePuzzle(grid, solution, options = {}) {
  const hints = options.hints ?? computeHints(grid, solution);
  const propagation = solveByPropagation(grid, hints);

  // 回溯计数是唯一可能变慢的一步，默认只在中小谜面上做；
  // 大谜面即使不区分"多解 / 唯一但要试错"，结论（不合格）也不会变。
  const wantCount = options.countSolutionsOnStall ?? grid.count <= 600;

  let verdict;
  let message;
  let solutions = null;

  if (propagation.contradiction) {
    // 提示由解推导而来，理论上不可能矛盾；出现即说明提示/求解器实现有 bug
    verdict = "contradiction";
    message = "提示与自身矛盾（提示推导或求解器存在缺陷）";
  } else if (propagation.unknown === 0) {
    // 传播只做强制推断，全部定下来即等价于"唯一解 + 无需猜测"
    verdict = "solvable";
    message = "唯一解，且全程只靠逐线推理即可完成，无需猜测";
    // 兜底自检：解出来的结果必须与给定造型一致
    for (let i = 0; i < solution.length; i++) {
      const want = solution[i] === 1 ? KEEP : GONE;
      if (propagation.states[i] !== want) {
        verdict = "contradiction";
        message = `求解结果与造型不一致（格 ${i}），提示推导或求解器存在缺陷`;
        break;
      }
    }
  } else if (!wantCount) {
    verdict = "needsGuess";
    message = `推理卡住，仍有 ${propagation.unknown} 格无法只靠推理确定，需要猜测`;
  } else {
    const counted = countSolutions(grid, hints, 2);
    solutions = { count: counted.count, truncated: counted.truncated };
    if (counted.count >= 2) {
      verdict = "multipleSolutions";
      message = "谜面多解（至少 2 个造型满足同一组提示），必然要猜";
    } else {
      verdict = "needsGuess";
      message = `解唯一但推理会卡在 ${propagation.unknown} 格上，只能靠试错，不合格`;
    }
  }

  const difficulty = rateDifficulty(grid, solution, hints, propagation);

  return {
    ok: verdict === "solvable",
    verdict,
    message,
    hints,
    propagation,
    difficulty,
    solutions,
  };
}

/**
 * 提示裁剪：尽量隐藏整行提示，但保持"无需猜测即可解"且难度不超上限
 *
 * ## 为什么要隐藏
 *  1. **画面干净**：每条线都印数字时，六个面密密麻麻，造型本身被淹没。
 *  2. **提升难度**：少一条已知条件，玩家就得从另两个轴绕过来推。
 *
 * ## 为什么可以安全地隐藏
 * 三个轴的提示对小网格是**高度过约束**的（N³ 个格子对应 3N² 条线），
 * 很多线的信息是冗余的——把它藏掉，剩下的提示依然能唯一确定造型。
 * 判断"能不能藏"没有捷径，只能藏了之后重新跑一遍传播：
 * 只要仍然能把每一格都定下来，就说明这条线是冗余的。
 *
 * ## 三条约束保证"藏得对"，而不只是"藏得多"
 *
 * ### 1. 每个解方块至少保留 minVisiblePerCell 条可见线（推理链的关键）
 * 纯按"可解性"贪心隐藏会藏出一种很糟的局面：某个区域三个轴的提示全被藏光，
 * 玩家在那里**完成一整行也得不到任何新线索**——他推完横向，抬头发现纵向没有数字，
 * 推理链就断在这里。约束每格至少有 2 条可见线之后，
 * "推完一个轴 ⇒ 必然给另一个轴喂进信息"这件事在结构上被保证了。
 *
 * 下限只对**解方块**生效，这一点很重要：非解方块最终会被凿掉，
 * 它那条线的数字会自动迁移到后面的方块表面上（见 HintFaces），
 * 所以它并不构成"读不到数字"的死角。若把下限一视同仁地加到全部格子上，
 * 可隐藏量会被砍掉一半，难度反而掉下来（实测 duck 3.65 → 3.19）。
 * 空格另有一条更松的下限 minVisiblePerEmpty，避免整片空白区域完全无信息。
 *
 * ### 2. 方框提示（≥3 段）永不隐藏
 * 方框是**最稀有也最有信息量**的提示，一个造型里往往只有个位数条。
 * 随机裁剪很容易正好把它们藏掉，结果玩家整局看不到一个方框，
 * 谜面读起来就只剩"数格子"。默认把它们全部保护起来。
 *
 * ### 3. 候选顺序按记号分组：先试裸数字，圆圈留到最后
 * 裸数字（1 段）信息量最低、也最多，优先藏它们既能清干净画面，
 * 又能把带记号的提示留在场上撑起阅读趣味。
 * 组内用 seed 确定性打乱：隐藏分布看起来自然（不成条带），
 * 同时同一关每次算出来完全一样，可复现、可 diff。
 *
 * 难度上限 `maxScore` 是"有挑战但不太难"的直接闸门：每次成功隐藏后重新评分，
 * 一旦超过就撤回这一步。`maxHiddenRatio` 是安全兜底。
 *
 * 成本：每个候选一次传播。128 条线的关卡约 100ms 量级，
 * 因此这是**离线**步骤（tools/level-audit.mjs --prune），结果写进关卡 JSON，
 * 运行时只做一次 O(1) 的导入。
 *
 * @param {import("../core/GridCoords.js").Grid} grid
 * @param {Uint8Array} solution
 * @param {import("./HintModel.js").HintSet} hints 会被**就地修改** visible 掩码
 * @param {{seed?:number|string, maxScore?:number, maxHiddenRatio?:number,
 *          minVisiblePerCell?:number, minVisiblePerEmpty?:number, protectSquare?:boolean,
 *          keepVisible?:(axis:number,key:number)=>boolean}} [options]
 * @returns {{ok:boolean, hidden:number, tried:number, reverted:number,
 *            blockedByCell:number, protectedMarks:number,
 *            reason:string, difficulty:object, summary:object}}
 */
export function pruneHints(grid, solution, hints, options = {}) {
  const {
    seed = 1,
    maxScore = 4.0,
    maxHiddenRatio = 0.55,
    minVisiblePerCell = 2,
    minVisiblePerEmpty = 1,
    protectSquare = true,
    keepVisible,
  } = options;

  const table = getLineTable(grid);

  const baseline = solveByPropagation(grid, hints);
  if (baseline.contradiction || baseline.unknown !== 0) {
    return {
      ok: false,
      hidden: hints.hiddenCount(),
      tried: 0,
      reverted: 0,
      blockedByCell: 0,
      protectedMarks: 0,
      reason: "裁剪前的谜面本身就需要猜测，未做任何隐藏",
      difficulty: rateDifficulty(grid, solution, hints, baseline),
      summary: hints.summary(),
    };
  }

  // 每个格子当前有几条可见线（初值按传入的 visible 掩码算，支持增量裁剪）
  const visiblePerCell = new Uint8Array(grid.count);
  for (let cell = 0; cell < grid.count; cell++) {
    let n = 0;
    for (const axis of AXES) {
      const id = table.cellLines[cell * 3 + axis];
      if (hints.visible[table.axisOf[id]][table.keyOf[id]] === 1) n++;
    }
    visiblePerCell[cell] = n;
  }

  /** 藏掉这条线会不会让线上某个格子跌破下限 */
  const violatesCellFloor = (id) => {
    const start = table.starts[id];
    const step = table.steps[id];
    const len = table.lengths[id];
    for (let i = 0; i < len; i++) {
      const cell = start + i * step;
      const floor = solution[cell] === 1 ? minVisiblePerCell : minVisiblePerEmpty;
      if (visiblePerCell[cell] - 1 < floor) return true;
    }
    return false;
  };

  // 候选顺序：裸数字优先（信息量最低），圆圈最后；组内确定性打乱
  const rng = new Rng(seed);
  const byMark = [[], [], []];
  for (let id = 0; id < table.totalLines; id++) {
    byMark[hints.marks[table.axisOf[id]][table.keyOf[id]]].push(id);
  }
  for (const group of byMark) rng.shuffle(group);
  const ids = [
    ...byMark[MARK_PLAIN],
    ...byMark[MARK_CIRCLE],
    ...(protectSquare ? [] : byMark[MARK_SQUARE]),
  ];

  const limit = Math.floor(table.totalLines * maxHiddenRatio);
  let hidden = hints.hiddenCount();
  let tried = 0;
  let reverted = 0;
  let blockedByCell = 0;
  let lastGood = baseline;
  let cappedByScore = false;

  for (const id of ids) {
    if (hidden >= limit) break;
    const axis = table.axisOf[id];
    const key = table.keyOf[id];
    if (hints.visible[axis][key] === 0) continue;
    if (keepVisible && keepVisible(axis, key)) continue;
    if (violatesCellFloor(id)) {
      blockedByCell++;
      continue;
    }

    tried++;
    hints.visible[axis][key] = 0;

    const res = solveByPropagation(grid, hints);
    if (res.contradiction || res.unknown !== 0) {
      // 藏掉这条线之后就得猜了 → 它承载着不可替代的信息，撤回
      hints.visible[axis][key] = 1;
      reverted++;
      continue;
    }

    if (rateDifficulty(grid, solution, hints, res).score > maxScore) {
      // 仍然可解，但已经超出"适中"的范围 → 撤回，继续试别的线
      hints.visible[axis][key] = 1;
      reverted++;
      cappedByScore = true;
      continue;
    }

    // 确认隐藏：更新每格的可见线计数
    const start = table.starts[id];
    const step = table.steps[id];
    for (let i = 0; i < table.lengths[id]; i++) visiblePerCell[start + i * step]--;
    hidden++;
    lastGood = res;
  }

  const difficulty = rateDifficulty(grid, solution, hints, lastGood);
  const summary = hints.summary();
  const protectedMarks = protectSquare ? byMark[MARK_SQUARE].length : 0;
  const reason =
    hidden >= limit
      ? `达到隐藏比例上限 ${Math.round(maxHiddenRatio * 100)}%`
      : cappedByScore
        ? `受难度上限 ${maxScore.toFixed(2)} 约束`
        : blockedByCell > 0
          ? `受"每个解方块至少 ${minVisiblePerCell} 条可见线"约束`
          : "已隐藏全部冗余提示";

  return {
    ok: true,
    hidden,
    tried,
    reverted,
    blockedByCell,
    protectedMarks,
    reason,
    difficulty,
    summary,
  };
}

/** 难度等级名（1..5） */
export const DIFFICULTY_LABELS = ["", "入门", "轻松", "适中", "有挑战", "硬核"];

/**
 * 难度评估
 *
 * 用四个可观测量线性加权，各项都做了归一化并夹在 [0,1]：
 *  - waves         推理链深度：需要"先推出 A 才能推出 B"的层数，最能代表烧脑程度
 *  - maxCandidates 单条线在产生推断时的最大候选数：代表一步内要枚举多少情况
 *  - hardDeductions 硬推断次数（候选数 > 6）占总格数的比例
 *  - markedRatio   圆圈/方框提示占比：分段提示天然比裸数字难读
 * 另外用 firstWaveRatio（一眼就能填的格子占比）作为"送分程度"的反向项。
 */
export function rateDifficulty(grid, solution, hints, propagation) {
  const cells = grid.count;
  let solid = 0;
  for (let i = 0; i < solution.length; i++) if (solution[i]) solid++;

  const summary = hints.summary();
  const firstWaveRatio = cells === 0 ? 0 : propagation.firstWaveCells / cells;

  const depth = clamp01((propagation.waves - 1) / 4);
  const branch = clamp01(Math.log2(propagation.maxCandidates + 1) / 6);
  const hard = clamp01(propagation.hardDeductions / Math.max(1, cells * 0.2));
  const marked = clamp01(summary.markedRatio / 0.35);
  const notFree = clamp01((1 - firstWaveRatio) / 0.85);

  const raw = depth * 1.7 + branch * 1.1 + hard * 0.9 + marked * 0.8 + notFree * 0.5;
  const score = Math.round((1 + raw) * 100) / 100; // 1.00 ~ 6.00
  const level = Math.min(5, Math.max(1, Math.round(score)));

  return {
    score,
    level,
    label: DIFFICULTY_LABELS[level],
    metrics: {
      cells,
      solid,
      fillRatio: cells === 0 ? 0 : Math.round((solid / cells) * 1000) / 1000,
      waves: propagation.waves,
      deductions: propagation.deductions,
      maxCandidates: propagation.maxCandidates,
      hardDeductions: propagation.hardDeductions,
      firstWaveRatio: Math.round(firstWaveRatio * 1000) / 1000,
      unknown: propagation.unknown,
      /** 被整行隐藏的提示占比（隐藏越多越难，已通过 waves / firstWaveRatio 间接体现） */
      hiddenRatio: Math.round(summary.hiddenRatio * 1000) / 1000,
      hints: summary,
    },
  };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
