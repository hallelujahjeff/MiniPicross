import { AXIS_X, AXIS_Y, AXIS_Z, lineOf } from "../core/GridCoords.js";

/**
 * 提示数字模型（纯数据，不依赖 three）
 *
 * 规则完全对齐任天堂原作《立体绘图方块 / Picross 3D》：
 *  - 沿 X / Y / Z 三个轴，每一条"线"（另两轴坐标固定）都可能有一个提示。
 *  - 提示的**数字** = 这条线上属于最终造型的方块总数（恒定，不随凿除变化）。
 *  - 提示的**记号**由这些方块在线上的**分段数**决定：
 *      1 段        → 裸数字        （MARK_PLAIN）
 *      恰好 2 段   → 数字加圆圈 ◯  （MARK_CIRCLE）
 *      ≥ 3 段      → 数字加方框 ▢  （MARK_SQUARE）
 *
 * ## 关于"0"与"空白"的区分（重要）
 * 本项目**显式显示 0**（"这条线整条都要凿掉"），而不是像原作那样用"没有数字"表示 0。
 * 这样做是为了给"**整行隐藏提示**"腾出语义空间：
 *
 *      看到数字（含 0） → 这条线的信息是已知的
 *      看到空白         → 这条线的提示被**故意隐藏**了，得靠另两个轴推出来
 *
 * 隐藏提示既能让画面干净、也能提升难度，但必须保证谜面仍然"无需猜测即可解"。
 * 因此每条线多了一个 `visible` 标记，由 `PuzzleSolver.pruneHints` 用
 * "贪心隐藏 + 每次隐藏后重新验证可解性"的方式算出，结论固化进关卡 JSON。
 *
 * 线的编号约定与 GridCoords.lineOf 完全一致：
 *      axis = X → (u, v) = (y, z)
 *      axis = Y → (u, v) = (x, z)
 *      axis = Z → (u, v) = (x, y)
 * 线在同轴内的 key = u + v * uCount，保证 key ∈ [0, lineCount)。
 */

export const MARK_PLAIN = 0;
export const MARK_CIRCLE = 1;
export const MARK_SQUARE = 2;

/** 记号的中文名（日志/HUD 用） */
export const MARK_NAMES = ["裸数字", "圆圈", "方框"];

/** 三个轴的遍历顺序（供需要"全部轴"的调用方复用） */
export const AXES = [AXIS_X, AXIS_Y, AXIS_Z];

/**
 * 某个轴上"线"的维度信息
 * @param {import("../core/GridCoords.js").Grid} grid
 * @returns {{uCount:number, vCount:number, length:number}}
 */
export function lineDims(grid, axis) {
  switch (axis) {
    case AXIS_X:
      return { uCount: grid.H, vCount: grid.D, length: grid.W };
    case AXIS_Y:
      return { uCount: grid.W, vCount: grid.D, length: grid.H };
    case AXIS_Z:
      return { uCount: grid.W, vCount: grid.H, length: grid.D };
    default:
      throw new Error(`lineDims: 非法 axis=${axis}`);
  }
}

/** 某个轴上的线总数 */
export function lineCount(grid, axis) {
  const { uCount, vCount } = lineDims(grid, axis);
  return uCount * vCount;
}

/** (u, v) → 同轴内的线 key */
export function lineKey(grid, axis, u, v) {
  return u + v * lineDims(grid, axis).uCount;
}

/**
 * 整数坐标 → 穿过该格子的三条线的 key
 * 热路径（提示贴花收集、求解器传播）都靠这个把"格子"映射到"线"。
 */
export function lineKeyOfCell(grid, axis, x, y, z) {
  switch (axis) {
    case AXIS_X:
      return y + z * grid.H;
    case AXIS_Y:
      return x + z * grid.W;
    case AXIS_Z:
      return x + y * grid.W;
    default:
      throw new Error(`lineKeyOfCell: 非法 axis=${axis}`);
  }
}

/** 分段数 → 记号 */
export function markOfGroups(groups) {
  if (groups <= 1) return MARK_PLAIN;
  if (groups === 2) return MARK_CIRCLE;
  return MARK_SQUARE;
}

/**
 * 一整套提示（三个轴 × 每轴所有线）
 *
 * 用平行 TypedArray 存储而非对象数组：
 *  - 16³ 谜面共 3 × 256 = 768 条线，三个 Uint8Array 不到 1KB
 *  - 求解器要在内层循环里反复读取，无对象解引用开销
 */
export class HintSet {
  /** @param {import("../core/GridCoords.js").Grid} grid */
  constructor(grid) {
    this.grid = grid;
    /** @type {Uint8Array[]} 每条线的方块总数（0 表示"整条都要凿掉"，仍然会显示） */
    this.counts = [];
    /** @type {Uint8Array[]} 每条线的分段数 */
    this.groups = [];
    /** @type {Uint8Array[]} 每条线的记号（见 MARK_*） */
    this.marks = [];
    /**
     * @type {Uint8Array[]} 每条线的提示是否可见（1 = 显示并作为约束，0 = 整行隐藏）
     * 隐藏的线**不参与求解**——它对玩家不可见，就不该被算作已知条件。
     */
    this.visible = [];
    for (const axis of AXES) {
      const n = lineCount(grid, axis);
      this.counts[axis] = new Uint8Array(n);
      this.groups[axis] = new Uint8Array(n);
      this.marks[axis] = new Uint8Array(n);
      this.visible[axis] = new Uint8Array(n).fill(1);
    }
  }

  /** 按 (u, v) 取提示 */
  at(axis, u, v) {
    const key = lineKey(this.grid, axis, u, v);
    return {
      axis,
      key,
      count: this.counts[axis][key],
      groups: this.groups[axis][key],
      mark: this.marks[axis][key],
      visible: this.visible[axis][key] === 1,
    };
  }

  /** 取穿过某个格子的那条线的提示 */
  atCell(axis, x, y, z) {
    const key = lineKeyOfCell(this.grid, axis, x, y, z);
    return {
      axis,
      key,
      count: this.counts[axis][key],
      groups: this.groups[axis][key],
      mark: this.marks[axis][key],
      visible: this.visible[axis][key] === 1,
    };
  }

  /** 全部提示恢复可见 */
  showAll() {
    for (const axis of AXES) this.visible[axis].fill(1);
    return this;
  }

  /** 隐藏的线总数 */
  hiddenCount() {
    let n = 0;
    for (const axis of AXES) {
      const v = this.visible[axis];
      for (let i = 0; i < v.length; i++) if (v[i] === 0) n++;
    }
    return n;
  }

  /**
   * 导出隐藏线清单（写回关卡 JSON 用）
   * @returns {{x:number[], y:number[], z:number[]}}
   */
  exportHidden() {
    const out = { x: [], y: [], z: [] };
    const names = ["x", "y", "z"];
    for (const axis of AXES) {
      const v = this.visible[axis];
      for (let i = 0; i < v.length; i++) if (v[i] === 0) out[names[axis]].push(i);
    }
    return out;
  }

  /**
   * 导入隐藏线清单
   * @param {{x?:number[], y?:number[], z?:number[]}} hidden
   * @param {(message:string) => void} [onBadKey] 非法 key 的回调（解析器用来抛错）
   */
  importHidden(hidden, onBadKey) {
    this.showAll();
    if (!hidden || typeof hidden !== "object") return this;
    const names = ["x", "y", "z"];
    for (const axis of AXES) {
      const list = hidden[names[axis]];
      if (list === undefined) continue;
      if (!Array.isArray(list)) {
        onBadKey?.(`hiddenHints.${names[axis]} 必须是数字数组`);
        continue;
      }
      const v = this.visible[axis];
      for (const key of list) {
        if (!Number.isInteger(key) || key < 0 || key >= v.length) {
          onBadKey?.(
            `hiddenHints.${names[axis]} 里的 ${key} 不是合法线号（应为 0..${v.length - 1} 的整数）`,
          );
          continue;
        }
        v[key] = 0;
      }
    }
    return this;
  }

  /** 提示构成统计（难度评估与 HUD 用） */
  summary() {
    let plain = 0;
    let circle = 0;
    let square = 0;
    let zero = 0;
    let hidden = 0;
    let total = 0;
    for (const axis of AXES) {
      const counts = this.counts[axis];
      const marks = this.marks[axis];
      const visible = this.visible[axis];
      for (let i = 0; i < counts.length; i++) {
        total++;
        if (visible[i] === 0) {
          hidden++;
          continue;
        }
        if (counts[i] === 0) {
          zero++;
          continue;
        }
        if (marks[i] === MARK_PLAIN) plain++;
        else if (marks[i] === MARK_CIRCLE) circle++;
        else square++;
      }
    }
    const numbered = plain + circle + square;
    return {
      total,
      /** 被整行隐藏的线数 */
      hidden,
      /** 显示为 0 的线数 */
      zero,
      /** 可见且带非零数字的线数 */
      numbered,
      /** 可见提示总数（含 0） */
      shown: numbered + zero,
      plain,
      circle,
      square,
      /** 带记号（圆圈/方框）的提示在"有数字的提示"中的占比 */
      markedRatio: numbered === 0 ? 0 : (circle + square) / numbered,
      /** 隐藏线占全部线的比例 */
      hiddenRatio: total === 0 ? 0 : hidden / total,
    };
  }
}

/**
 * 由造型解推导全部提示
 *
 * 提示是解的**函数**：给定造型，提示唯一确定，没有任何随机空间。
 * 这也是"谜面能不能随机生成"这个问题的答案——能随机的只有造型本身。
 *
 * @param {import("../core/GridCoords.js").Grid} grid
 * @param {Uint8Array} solution 长度 = grid.count，1 = 属于最终造型
 * @returns {HintSet}
 */
export function computeHints(grid, solution) {
  if (!solution || solution.length !== grid.count) {
    throw new Error(
      `computeHints: solution 长度 ${solution?.length} 与网格格数 ${grid.count} 不一致`,
    );
  }

  const hints = new HintSet(grid);

  for (const axis of AXES) {
    const { uCount, vCount } = lineDims(grid, axis);
    const counts = hints.counts[axis];
    const groups = hints.groups[axis];
    const marks = hints.marks[axis];

    for (let v = 0; v < vCount; v++) {
      for (let u = 0; u < uCount; u++) {
        const line = lineOf(grid, axis, u, v);
        let count = 0;
        let groupCount = 0;
        let prev = 0;
        for (let i = 0; i < line.length; i++) {
          const solid = solution[line.start + i * line.step];
          if (solid) {
            count++;
            if (!prev) groupCount++;
          }
          prev = solid;
        }
        const key = u + v * uCount;
        counts[key] = count;
        groups[key] = groupCount;
        marks[key] = count === 0 ? MARK_PLAIN : markOfGroups(groupCount);
      }
    }
  }

  return hints;
}
