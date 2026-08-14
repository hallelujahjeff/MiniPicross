import { lineOf } from "../core/GridCoords.js";
import { AXES, lineDims } from "./HintModel.js";

/**
 * 提示贴花的位置计算（纯数据，不依赖 three）
 *
 * ## 原作的数字长在哪
 * 提示不是浮在空中的标签，而是**印在方块表面上的数字**。
 *
 * ## 计算方式：每个"暴露面"都贴数字
 * 一条沿 axis 的线，遍历线上每一个**可见**方块，看它沿该轴的两个方向
 * 是否"暴露"（边界外 / 相邻格已凿除 / 相邻格被截面隐藏）：
 *   - 负方向暴露 → 在负向面贴一个该线的提示
 *   - 正方向暴露 → 在正向面贴一个该线的提示
 *
 * 这样数字自然只出现在"看得见的面"上：一条连续方块只有两端有数字；
 * 凿掉中间一块后，空位两侧新暴露的面会立刻长出数字（这正是玩家推理时
 * 最重要的视觉反馈）。比"只贴最外侧两块"更贴合原作——原作里一旦某个
 * 方向有数字，这条线上所有露出来的对应面都会标上它。
 *
 * ## 三档显示状态（由谜题进度决定）
 *  1. **正常**：这条线还有解方块没涂，数字照常显示。
 *  2. **压淡**：这条线的解方块全部涂完、但仍剩非解方块没敲。
 *     此时那些非解方块的数字被压淡，提醒玩家"这几个已经确定要敲掉了"。
 *     压淡是按 (方块, 面) 维度的——一个方块可能 X 方向压淡、Y 方向正常。
 *  3. **隐藏**：这条线整体完成（该敲的都敲了、该涂的都涂了），数字已无用，
 *     整条收起，画面更干净。
 *
 * ## 0 与空白
 * 数字 **0 会照常贴出来**（语义是"这条线整条都要凿掉"）；
 * 只有被 `hints.visible` 标为隐藏的线才什么都不贴。
 * 于是"空白面"在游戏里有唯一含义：**这条线的提示被故意藏起来了**。
 *
 * "可见"由调用方给出（`blockToSlot[block] >= 0`），所以同一套逻辑同时覆盖
 * 「已凿除」与「被截面隐藏」两种不可见——截面切开后新暴露的面会自动长出数字。
 *
 * ## 容量
 * 每个格子属于 3 条线、每条线最多贡献 2 个方向面，故贴花数有紧上界：
 *   6 × grid.count
 * 10³ 谜面即 6000 个，全部塞进一个 InstancedMesh（1 个 draw call）。
 */

export const FACE_NX = 0;
export const FACE_PX = 1;
export const FACE_NY = 2;
export const FACE_PY = 3;
export const FACE_NZ = 4;
export const FACE_PZ = 5;

/** 六个面的外法线，索引与 FACE_* 对齐 */
export const FACE_NORMALS = [
  [-1, 0, 0],
  [1, 0, 0],
  [0, -1, 0],
  [0, 1, 0],
  [0, 0, -1],
  [0, 0, 1],
];

/** axis → [负向面, 正向面] */
const AXIS_FACES = [
  [FACE_NX, FACE_PX],
  [FACE_NY, FACE_PY],
  [FACE_NZ, FACE_PZ],
];

/** 贴花数量上界：每个格子最多 6 个（3 条线 × 2 个方向面） */
export function hintFaceCapacity(grid) {
  return grid.count * 6;
}

/**
 * 贴花列表（平行 TypedArray，可反复复用同一份缓冲，零分配）
 */
export class HintFaceList {
  constructor(capacity) {
    this.capacity = capacity;
    /** 贴花所属方块的线性索引 */
    this.blocks = new Int32Array(capacity);
    /** 贴在哪个面（FACE_*） */
    this.faces = new Uint8Array(capacity);
    /** 数字 */
    this.values = new Uint8Array(capacity);
    /** 记号（MARK_*） */
    this.marks = new Uint8Array(capacity);
    /** 是否压淡（0 = 正常，1 = 压淡） */
    this.dims = new Uint8Array(capacity);
    this.length = 0;
    /** 因容量不足被丢弃的贴花数（正常应恒为 0，非 0 说明容量公式算错了） */
    this.overflow = 0;
  }

  reset() {
    this.length = 0;
    this.overflow = 0;
  }

  push(block, face, value, mark, dim = 0) {
    if (this.length >= this.capacity) {
      this.overflow++;
      return false;
    }
    const i = this.length++;
    this.blocks[i] = block;
    this.faces[i] = face;
    this.values[i] = value;
    this.marks[i] = mark;
    this.dims[i] = dim;
    return true;
  }
}

/**
 * 收集当前应该显示的全部提示贴花
 *
 * @param {import("../core/GridCoords.js").Grid} grid
 * @param {import("./HintModel.js").HintSet} hints
 * @param {import("./PuzzleModel.js").PuzzleModel} model 提供进度状态（用于隐藏/压淡判定）
 * @param {Int32Array} blockToSlot 方块 → 渲染槽位；< 0 表示当前不可见
 * @param {HintFaceList} out 复用的输出缓冲
 * @returns {HintFaceList} 就是 out
 */
export function collectHintFaces(grid, hints, model, blockToSlot, out) {
  out.reset();

  for (const axis of AXES) {
    const { uCount, vCount } = lineDims(grid, axis);
    const counts = hints.counts[axis];
    const marks = hints.marks[axis];
    const visible = hints.visible[axis];
    const [negFace, posFace] = AXIS_FACES[axis];

    const lineDone = model.lineDone[axis];
    const lineSolid = model.lineSolid[axis];
    const lineNeedPaint = model.lineNeedPaint[axis];
    const lineNeedRemove = model.lineNeedRemove[axis];
    const solution = model.solution;

    for (let v = 0; v < vCount; v++) {
      for (let u = 0; u < uCount; u++) {
        const key = u + v * uCount;
        if (visible[key] === 0) continue; // 整行隐藏：什么都不贴
        if (lineDone[key]) continue; // 整行完成：数字已无用，收起

        const value = counts[key];
        const mark = marks[key];
        // 压淡：这条线有解方块、且全部涂完、但还剩下非解方块没敲
        const dimLine =
          lineSolid[key] > 0 && lineNeedPaint[key] === 0 && lineNeedRemove[key] > 0;

        const line = lineOf(grid, axis, u, v);
        for (let i = 0; i < line.length; i++) {
          const block = line.start + i * line.step;
          if (blockToSlot[block] < 0) continue; // 已凿除 / 被截面隐藏

          // 压淡只针对"该敲掉却还没敲"的非解方块
          const dim = dimLine && solution[block] === 0 ? 1 : 0;

          // 负方向暴露（边界外 / 相邻格不可见）→ 负向面贴
          if (i === 0 || blockToSlot[line.start + (i - 1) * line.step] < 0) {
            out.push(block, negFace, value, mark, dim);
          }
          // 正方向暴露 → 正向面贴
          if (i === line.length - 1 || blockToSlot[line.start + (i + 1) * line.step] < 0) {
            out.push(block, posFace, value, mark, dim);
          }
        }
      }
    }
  }

  return out;
}
