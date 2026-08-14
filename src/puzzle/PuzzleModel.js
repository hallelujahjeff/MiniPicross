import { CELL, lineOf, coordsOf } from "../core/GridCoords.js";
import * as BlockState from "../core/BlockState.js";
import { AXES, computeHints, lineCount, lineDims, lineKeyOfCell } from "./HintModel.js";

/**
 * 运行时谜题状态容器（纯数据，不依赖 three，可单独测试）
 *
 * 关键设计：状态用 **TypedArray** 而非对象数组
 *  - 1000 个方块只占一个 1KB 的 Uint8Array，无 GC 压力、遍历局部性好
 *  - 判胜负 / 统计都是纯数组扫描
 *
 * 变更通过 dirty 集合对外广播，渲染层每帧只处理有变化的方块。
 *
 * ## 玩法规则（对齐原作）
 *  - 左键敲除：非解方块 → 碎裂消失；解方块 → **失误**，方块不会消失，
 *    而是自动被标记（涂色）。这条规则很重要：它保证谜面**永远不会因为
 *    误操作而变得无解**，失误只体现在计数上。
 *  - 已标记（涂色）的方块受保护，敲不掉，必须先取消标记。
 *    这正是"标记"的意义——把推理结论固化下来，避免手滑。
 *
 * ## 整行完成 → 确认上色
 * 一条线被"做完"的定义是：这条线上该凿的都凿了、该留的都涂了，且线上确实有方块。
 * 此时这条线上的方块进入 **CONFIRMED**：换成造型的最终配色并**锁定**
 * （不能再取消标记、也不能敲掉）。这既是即时正反馈，也天然防手滑。
 *
 * 确认会**连锁**：一个方块被确认（等于被涂上）可能让穿过它的另外两条线也刚好凑满，
 * 于是那两条线也完成。这里用显式工作队列处理连锁，避免深递归。
 *
 * 为了 O(1) 判断"某条线是否完成"，构造时就把每条线的
 * 「还差几个要凿」「还差几个要涂」算好，之后只做加减。
 */
export class PuzzleModel {
  /**
   * @param {import("../level/LevelParser.js").LevelData} level
   */
  constructor(level) {
    this.level = level;
    this.grid = level.grid;
    /** 1 = 属于最终造型 */
    this.solution = level.solution;
    /** 提示数字（由造型推导；LevelData 里已算好则直接复用） */
    this.hints = level.hints ?? computeHints(this.grid, this.solution);
    /** 每个方块的状态位（见 BlockState） */
    this.states = new Uint8Array(this.grid.count);

    /** @type {Set<number>} 自上次 consumeDirty 之后发生变化的方块索引 */
    this.dirty = new Set();

    // 统计
    this.presentCount = this.grid.count; // 仍在场上的方块数
    this.paintedCount = 0;
    this.confirmedCount = 0;
    this.mistakes = 0;
    /** 需要凿除的非解方块总数 */
    this.totalToRemove = this.grid.count - level.solutionCount;
    /** 还需凿除的非解方块数（归零即通关） */
    this.remainingToRemove = this.totalToRemove;

    this._initLineTracking();

    /**
     * @type {{axis:number, key:number, cells:number[]}[]}
     * 刚刚完成的线，等调用方 drainCompletedLines() 取走去播特效
     */
    this.completedLines = [];
    /** 已完成的线总数（HUD 用） */
    this.completedLineCount = 0;
    /** @type {number[]} 复用的连锁工作队列 */
    this._pending = [];

    /**
     * 提示重算版本号
     *
     * 提示贴花的显示状态不仅取决于"哪些方块可见"（→ PuzzleRenderer.visibilityVersion），
     * 还取决于"这条线涂到哪一步了"（压淡 / 整行完成隐藏）。涂色不改变可见性，
     * 却会改变 lineNeedPaint / lineDone，因此需要一个独立版本号在涂色时自增，
     * 让 App 在纯涂色后也重算一次贴花。
     */
    this.hintRevision = 0;
  }

  /** 建立每条线的「还差几个要凿 / 还差几个要涂」计数器 */
  _initLineTracking() {
    /** @type {Uint16Array[]} 该线上还没凿掉的非解方块数 */
    this.lineNeedRemove = [];
    /** @type {Uint16Array[]} 该线上还没涂上的解方块数 */
    this.lineNeedPaint = [];
    /** @type {Uint16Array[]} 该线上的解方块总数（0 表示这条线没有造型，不需要庆祝） */
    this.lineSolid = [];
    /** @type {Uint8Array[]} 该线是否已完成 */
    this.lineDone = [];
    this.totalLinesWithSolid = 0;

    for (const axis of AXES) {
      const n = lineCount(this.grid, axis);
      this.lineNeedRemove[axis] = new Uint16Array(n);
      this.lineNeedPaint[axis] = new Uint16Array(n);
      this.lineSolid[axis] = new Uint16Array(n);
      this.lineDone[axis] = new Uint8Array(n);
    }

    // 每个格子的三条线 key，避免运行时反复做坐标解码
    this.cellLineKeys = new Int32Array(this.grid.count * 3);
    const c = { x: 0, y: 0, z: 0 };
    for (let cell = 0; cell < this.grid.count; cell++) {
      coordsOf(this.grid, cell, c);
      const solid = this.solution[cell] === 1;
      for (const axis of AXES) {
        const key = lineKeyOfCell(this.grid, axis, c.x, c.y, c.z);
        this.cellLineKeys[cell * 3 + axis] = key;
        if (solid) {
          this.lineSolid[axis][key]++;
          this.lineNeedPaint[axis][key]++;
        } else {
          this.lineNeedRemove[axis][key]++;
        }
      }
    }

    for (const axis of AXES) {
      const solidArr = this.lineSolid[axis];
      for (let i = 0; i < solidArr.length; i++) {
        if (solidArr[i] > 0) this.totalLinesWithSolid++;
      }
    }
  }

  /** 方块总数（初始实心数） */
  get totalCount() {
    return this.grid.count;
  }

  /** 通关进度 0..1 */
  get progress() {
    if (this.totalToRemove === 0) return 1;
    return (this.totalToRemove - this.remainingToRemove) / this.totalToRemove;
  }

  getState(index) {
    return this.states[index];
  }

  isSolution(index) {
    return this.solution[index] === 1;
  }

  isRemoved(index) {
    return BlockState.isRemoved(this.states[index]);
  }

  isPainted(index) {
    return BlockState.isPainted(this.states[index]);
  }

  isConfirmed(index) {
    return BlockState.isConfirmed(this.states[index]);
  }

  /** 该方块最终应显示的配色（0xrrggbb） */
  colorOf(index) {
    const palette = this.level.palette;
    const idx = this.level.colorIndex ? this.level.colorIndex[index] : 0;
    return palette[Math.min(palette.length - 1, idx)] ?? palette[0];
  }

  /** 索引是否合法 */
  isValidIndex(index) {
    return Number.isInteger(index) && index >= 0 && index < this.grid.count;
  }

  /**
   * 玩家敲击一个方块（左键）
   *
   * @param {number} index
   * @returns {{result:"broken"|"mistake"|"blocked"|"noop", solved:boolean}}
   *   broken  = 正确凿除
   *   mistake = 敲到了造型上的方块（记一次失误，并自动标记该方块）
   *   blocked = 方块已被标记/确认保护，需先取消标记
   *   noop    = 索引非法或方块已经不在场上
   */
  chisel(index) {
    if (!this.isValidIndex(index)) return { result: "noop", solved: this.isSolved() };
    const state = this.states[index];
    if (BlockState.isRemoved(state)) return { result: "noop", solved: this.isSolved() };

    if (BlockState.isPainted(state)) {
      return { result: "blocked", solved: this.isSolved() };
    }

    if (this.solution[index] === 1) {
      // 失误：方块保留，并自动标记——此后它就受保护，不会被反复敲错
      this.mistakes++;
      this._applyPaint(index, true);
      this._runPending();
      return { result: "mistake", solved: this.isSolved() };
    }

    this.states[index] = state | BlockState.REMOVED;
    this.presentCount--;
    this.remainingToRemove--;
    this.dirty.add(index);

    // 这一格凿掉了 → 它所在三条线各少一个"待凿"
    const base = index * 3;
    for (const axis of AXES) {
      const key = this.cellLineKeys[base + axis];
      this.lineNeedRemove[axis][key]--;
      this._checkLine(axis, key);
    }
    this._runPending();

    return { result: "broken", solved: this.isSolved() };
  }

  /**
   * 切换标记（Ctrl + 左键）
   *
   * 涂色只能涂在**正确**的方块上：涂到"应该敲掉"的方块和敲错一样，
   * 记一次失误并拒绝上色（方块保持原状），由调用方播放闪红 + 失误音效。
   * @returns {{result:"painted"|"unpainted"|"mistake"|"locked"|"noop"}}
   */
  togglePaint(index) {
    if (!this.isValidIndex(index)) return { result: "noop" };
    const state = this.states[index];
    if (BlockState.isRemoved(state)) return { result: "noop" };
    // 已确认的方块是"这一行推完了"的既成结论，不允许再回退
    if (BlockState.isConfirmed(state)) return { result: "locked" };

    // 涂到非解方块上 = 错误：只记失误，不上色
    if (!BlockState.isPainted(state) && this.solution[index] === 0) {
      this.mistakes++;
      return { result: "mistake" };
    }

    const painted = !BlockState.isPainted(state);
    this._applyPaint(index, painted);
    this._runPending();
    return { result: painted ? "painted" : "unpainted" };
  }

  /**
   * 无条件凿除（不计失误、无视标记保护）
   *
   * 只给"显示造型解"这类开发/验收工具用，不走玩法通道。
   * @returns {boolean} 是否发生变化
   */
  forceRemove(index) {
    if (!this.isValidIndex(index)) return false;
    const state = this.states[index];
    if (BlockState.isRemoved(state)) return false;

    this.states[index] = (state | BlockState.REMOVED) & ~BlockState.CONFIRMED;
    this.presentCount--;
    if (BlockState.isPainted(state)) this.paintedCount--;
    if (BlockState.isConfirmed(state)) this.confirmedCount--;
    if (this.solution[index] !== 1) {
      this.remainingToRemove--;
      const base = index * 3;
      for (const axis of AXES) {
        const key = this.cellLineKeys[base + axis];
        this.lineNeedRemove[axis][key]--;
      }
    }
    this.dirty.add(index);
    return true;
  }

  /**
   * 确认整条线：把线上的解方块换成最终配色并锁定
   * @returns {number[]} 本次新确认的方块（按线上顺序，便于做扫过式动画）
   */
  confirmLine(axis, key) {
    const cells = [];
    const dims = this._lineUv(axis, key);
    const line = lineOf(this.grid, axis, dims.u, dims.v);
    for (let i = 0; i < line.length; i++) {
      const cell = line.start + i * line.step;
      if (this.solution[cell] !== 1) continue;
      if (this._confirmCell(cell)) cells.push(cell);
    }
    this._runPending();
    return cells;
  }

  /**
   * 一次性确认全部解方块（通关演出用）
   * @returns {number[]} 新确认的方块，按 y 自下而上排序，便于做"从下往上填色"的波
   */
  confirmAll() {
    const cells = [];
    for (let cell = 0; cell < this.grid.count; cell++) {
      if (this.solution[cell] !== 1) continue;
      if (this._confirmCell(cell)) cells.push(cell);
    }
    this._runPending();
    const c = { x: 0, y: 0, z: 0 };
    return cells.sort((a, b) => {
      coordsOf(this.grid, a, c);
      const ya = c.y;
      coordsOf(this.grid, b, c);
      return ya - c.y;
    });
  }

  /** 取走"刚刚完成的线"清单（调用方负责播特效） */
  drainCompletedLines() {
    if (this.completedLines.length === 0) return [];
    const list = this.completedLines;
    this.completedLines = [];
    return list;
  }

  /** 是否已通关：所有非解方块都被凿除 */
  isSolved() {
    return this.remainingToRemove === 0;
  }

  /**
   * 消费并清空 dirty 集合
   * @param {(index:number) => void} cb
   * @returns {number} 处理的方块数
   */
  consumeDirty(cb) {
    if (this.dirty.size === 0) return 0;
    const n = this.dirty.size;
    for (const index of this.dirty) cb(index);
    this.dirty.clear();
    return n;
  }

  /** 供 HUD / 日志使用的快照 */
  getStats() {
    return {
      levelId: this.level.id,
      size: [this.grid.W, this.grid.H, this.grid.D],
      total: this.grid.count,
      present: this.presentCount,
      solution: this.level.solutionCount,
      painted: this.paintedCount,
      confirmed: this.confirmedCount,
      completedLines: this.completedLineCount,
      totalLines: this.totalLinesWithSolid,
      mistakes: this.mistakes,
      remainingToRemove: this.remainingToRemove,
      totalToRemove: this.totalToRemove,
      progress: this.progress,
      solved: this.isSolved(),
    };
  }

  /** 世界空间下的包围盒尺寸（相机取景用；不依赖 three） */
  getWorldSize() {
    return {
      x: this.grid.W * CELL,
      y: this.grid.H * CELL,
      z: this.grid.D * CELL,
    };
  }

  /** 设置/取消标记，并维护线上的"还差几个要涂" */
  _applyPaint(index, painted) {
    const state = this.states[index];
    if (BlockState.isPainted(state) === painted) return false;

    this.states[index] = painted
      ? state | BlockState.PAINTED
      : state & ~BlockState.PAINTED;
    this.paintedCount += painted ? 1 : -1;
    this.dirty.add(index);
    // 涂色/取消涂色会改变 lineNeedPaint、可能连锁触发 lineDone，
    // 但不改变可见性，所以这里单独推进提示版本，让贴花及时压淡/隐藏
    this.hintRevision++;

    // 只有解方块才计入"还差几个要涂"（涂错的非解方块不影响整行完成判定，
    // 因为那一格还没凿掉，lineNeedRemove 仍然 > 0）
    if (this.solution[index] === 1) {
      const base = index * 3;
      for (const axis of AXES) {
        const key = this.cellLineKeys[base + axis];
        this.lineNeedPaint[axis][key] += painted ? -1 : 1;
        if (painted) this._checkLine(axis, key);
      }
    }
    return true;
  }

  /** 把一格标记为已确认（含自动补上 PAINTED） */
  _confirmCell(cell) {
    const state = this.states[cell];
    if (BlockState.isRemoved(state) || BlockState.isConfirmed(state)) return false;
    if (this.solution[cell] !== 1) return false;

    if (!BlockState.isPainted(state)) {
      // 复用同一套记账，顺带把它所在三条线的"还差几个要涂"减一（可能连锁完成）
      this._applyPaint(cell, true);
    }
    this.states[cell] |= BlockState.CONFIRMED;
    this.confirmedCount++;
    this.dirty.add(cell);
    return true;
  }

  /** 判定某条线是否刚好完成；完成则入队等待处理 */
  _checkLine(axis, key) {
    if (this.lineDone[axis][key]) return;
    if (this.lineSolid[axis][key] === 0) return; // 整条都要凿掉，没有"完成上色"可言
    if (this.lineNeedRemove[axis][key] !== 0) return;
    if (this.lineNeedPaint[axis][key] !== 0) return;

    this.lineDone[axis][key] = 1;
    this.completedLineCount++;
    this._pending.push(axis, key);
  }

  /**
   * 处理完成队列：给每条完成的线确认上色，并把连锁完成的线一起处理
   * 用显式队列而不是递归，连锁再长也不会爆栈。
   */
  _runPending() {
    if (this._pending.length === 0) return;
    // 取出当前批次，处理过程中新产生的完成会追加到 _pending 末尾
    let i = 0;
    while (i < this._pending.length) {
      const axis = this._pending[i++];
      const key = this._pending[i++];

      const cells = [];
      const { u, v } = this._lineUv(axis, key);
      const line = lineOf(this.grid, axis, u, v);
      for (let k = 0; k < line.length; k++) {
        const cell = line.start + k * line.step;
        if (this.solution[cell] !== 1) continue;
        if (this._confirmCell(cell)) cells.push(cell);
        else if (BlockState.isConfirmed(this.states[cell])) cells.push(cell);
      }
      this.completedLines.push({ axis, key, cells });
    }
    this._pending.length = 0;
  }

  /** 线 key → (u, v) */
  _lineUv(axis, key) {
    const { uCount } = lineDims(this.grid, axis);
    return { u: key % uCount, v: Math.floor(key / uCount) };
  }
}
