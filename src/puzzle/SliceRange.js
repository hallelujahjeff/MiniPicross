import { AXIS_X, AXIS_Y, AXIS_Z } from "../core/GridCoords.js";

/**
 * 截面（剖切）范围（纯数据，不依赖 three）
 *
 * 原作的核心操作之一：用一个平面把长方体切开，隐藏平面一侧的方块，
 * 从而看见内部构造并对内部方块做敲除/标记。
 *
 * 这里把"剖切"抽象成**每个轴上的可见闭区间** `[lo, hi]`：
 *  - X 轴收缩 → 等价于用 ZY 平面（法线沿 X）切分
 *  - Z 轴收缩 → 等价于用 XY 平面（法线沿 Z）切分
 * 两端各有一个手柄，因此既能"只隐藏一侧"，也能像原作那样把范围收成
 * **单层薄片**——这是查看内部最有效的姿势。
 *
 * 之所以做成区间而不是单个平面：单平面只能从一侧剥，看不到被夹在中间的层；
 * 区间是单平面的超集，交互上仍然是"拖一个条"，没有额外心智负担。
 *
 * ## 同一时刻只允许一个轴被剖切
 * 两个轴同时收窄会得到一根"柱子"，剩下的方块太少、空间关系反而更难读，
 * 而且两组拖动条互相干扰。因此一旦某个轴离开完整范围，
 * 另一个轴就被**锁定**（`setBound` 直接拒绝，界面上也把它的拖动条藏起来）。
 * 想切另一个轴，先把当前轴恢复完整即可。
 *
 * 注意：剖切是**纯视觉过滤**，被隐藏的方块并没有被凿除，
 * 它们只是暂时不参与渲染与拾取。提示数字会按"当前可见的方块"重算，
 * 所以切开后新暴露的截面上会立刻长出对应的数字。
 */

/** 可交互的剖切轴（对应界面上 X / Z 两根拖动条） */
export const SLICE_AXES = [AXIS_X, AXIS_Z];

/** 轴名（HUD 展示用） */
export const AXIS_NAMES = ["X", "Y", "Z"];

export class SliceRange {
  /** @param {import("../core/GridCoords.js").Grid} grid */
  constructor(grid) {
    this.grid = grid;
    /** 每个轴的格子数，索引与 AXIS_* 对齐 */
    this.extent = [grid.W, grid.H, grid.D];
    /** @type {number[][]} 每个轴的可见闭区间 [lo, hi] */
    this.bounds = [
      [0, grid.W - 1],
      [0, grid.H - 1],
      [0, grid.D - 1],
    ];
    /** 每次范围变化自增，供渲染层做"要不要重建"的廉价比较 */
    this.version = 0;
  }

  /** 恢复到完整可见 */
  reset() {
    let changed = false;
    for (const axis of [AXIS_X, AXIS_Y, AXIS_Z]) {
      if (this.bounds[axis][0] !== 0 || this.bounds[axis][1] !== this.extent[axis] - 1) {
        changed = true;
      }
      this.bounds[axis][0] = 0;
      this.bounds[axis][1] = this.extent[axis] - 1;
    }
    if (changed) this.version++;
    return changed;
  }

  /** 是否处于截面模式（任一轴被收窄） */
  get active() {
    for (const axis of [AXIS_X, AXIS_Y, AXIS_Z]) {
      if (this.bounds[axis][0] !== 0) return true;
      if (this.bounds[axis][1] !== this.extent[axis] - 1) return true;
    }
    return false;
  }

  /**
   * 当前正在被剖切的轴（-1 = 没有）
   *
   * 由于同一时刻只允许一个轴被剖切，这个值就唯一地描述了"现在在切哪个面"。
   */
  get activeAxis() {
    for (const axis of [AXIS_X, AXIS_Y, AXIS_Z]) {
      if (this.isAxisSliced(axis)) return axis;
    }
    return -1;
  }

  /** 某个轴现在能不能拖（没有别的轴正在被剖切） */
  canSlice(axis) {
    const active = this.activeAxis;
    return active < 0 || active === axis;
  }

  /**
   * 设置某轴某端的边界
   * @param {number} axis AXIS_X / AXIS_Y / AXIS_Z
   * @param {0|1} side 0 = 低端（lo），1 = 高端（hi）
   * @param {number} value 目标格坐标（会被夹取到合法范围）
   * @returns {boolean} 是否真的发生变化
   */
  setBound(axis, side, value) {
    // 另一个轴正在被剖切时，本轴锁定
    if (!this.canSlice(axis)) return false;

    const b = this.bounds[axis];
    const max = this.extent[axis] - 1;
    let v = Math.round(value);
    if (!Number.isFinite(v)) return false;
    // 两端不允许越过对方：始终保留至少一层可见
    v = side === 0 ? clamp(v, 0, b[1]) : clamp(v, b[0], max);
    if (b[side] === v) return false;
    b[side] = v;
    this.version++;
    return true;
  }

  /** 取某轴某端的当前边界 */
  getBound(axis, side) {
    return this.bounds[axis][side];
  }

  /** 某轴当前可见的层数 */
  thickness(axis) {
    return this.bounds[axis][1] - this.bounds[axis][0] + 1;
  }

  /** 某轴是否被收窄 */
  isAxisSliced(axis) {
    return this.bounds[axis][0] !== 0 || this.bounds[axis][1] !== this.extent[axis] - 1;
  }

  /** 整数坐标是否落在可见范围内 */
  contains(x, y, z) {
    const bx = this.bounds[AXIS_X];
    const by = this.bounds[AXIS_Y];
    const bz = this.bounds[AXIS_Z];
    return (
      x >= bx[0] && x <= bx[1] && y >= by[0] && y <= by[1] && z >= bz[0] && z <= bz[1]
    );
  }

  /** 线性索引是否落在可见范围内（内联坐标解码，热路径用） */
  containsIndex(index) {
    const grid = this.grid;
    const z = (index / grid.strideZ) | 0;
    const rest = index - z * grid.strideZ;
    const y = (rest / grid.strideY) | 0;
    const x = rest - y * grid.strideY;
    return this.contains(x, y, z);
  }

  /** HUD 文案用的摘要，例如 "X 2–5 · Z 0–3" */
  describe() {
    const parts = [];
    for (const axis of [AXIS_X, AXIS_Y, AXIS_Z]) {
      if (!this.isAxisSliced(axis)) continue;
      const b = this.bounds[axis];
      parts.push(`${AXIS_NAMES[axis]} ${b[0]}–${b[1]}`);
    }
    return parts.length === 0 ? "完整显示" : parts.join(" · ");
  }
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}
