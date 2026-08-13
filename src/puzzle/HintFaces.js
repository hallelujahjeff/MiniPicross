import { lineOf } from "../core/GridCoords.js";
import { AXES, lineDims } from "./HintModel.js";

/**
 * 提示贴花的位置计算（纯数据，不依赖 three）
 *
 * ## 原作的数字长在哪
 * 提示不是浮在空中的标签，而是**印在方块表面上的数字**：
 * 每条线的数字出现在这条线上"最外侧那个还看得见的方块"的朝外一面。
 * 因此从任意角度看长方体，六个面上都铺满数字；
 * 一旦最外层被凿掉，同一个数字就"移"到后面那块的表面上——
 * 这正是玩家推理时最重要的视觉反馈。
 *
 * ## 计算方式
 * 一条沿 axis 的线上，找出第一个可见方块 a 与最后一个可见方块 b：
 *   - a 的**负向面**贴上该线的提示（它前面已经没有东西挡着了）
 *   - b 的**正向面**贴上该线的提示
 * 若 a === b（线上只剩一块），两个面都贴。
 *
 * ## 0 与空白
 * 数字 **0 会照常贴出来**（语义是"这条线整条都要凿掉"）；
 * 只有被 `hints.visible` 标为隐藏的线才什么都不贴。
 * 于是"空白面"在游戏里有唯一含义：**这条线的提示被故意藏起来了**。
 * 这一条很关键——否则玩家凿开一块后看到后面那块是空白面，
 * 会以为是渲染漏了，而不是"这条线是 0 / 被隐藏"。
 *
 * "可见"由调用方给出（`blockToSlot[block] >= 0`），所以同一套逻辑同时覆盖
 * 「已凿除」与「被截面隐藏」两种不可见——截面切开后新暴露的面会自动长出数字。
 *
 * 每条线最多产出 2 个贴花，所以贴花总数有紧的上界：
 *   2 × (线总数) = 2 × (H·D + W·D + W·H)
 * 10³ 谜面只有 600 个，全部塞进一个 InstancedMesh 即可（1 个 draw call）。
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

/** 贴花数量上界 */
export function hintFaceCapacity(grid) {
  const lines = grid.H * grid.D + grid.W * grid.D + grid.W * grid.H;
  return 2 * lines;
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
    this.length = 0;
    /** 因容量不足被丢弃的贴花数（正常应恒为 0，非 0 说明容量公式算错了） */
    this.overflow = 0;
  }

  reset() {
    this.length = 0;
    this.overflow = 0;
  }

  push(block, face, value, mark) {
    if (this.length >= this.capacity) {
      this.overflow++;
      return false;
    }
    const i = this.length++;
    this.blocks[i] = block;
    this.faces[i] = face;
    this.values[i] = value;
    this.marks[i] = mark;
    return true;
  }
}

/**
 * 收集当前应该显示的全部提示贴花
 *
 * @param {import("../core/GridCoords.js").Grid} grid
 * @param {import("./HintModel.js").HintSet} hints
 * @param {Int32Array} blockToSlot 方块 → 渲染槽位；< 0 表示当前不可见
 * @param {HintFaceList} out 复用的输出缓冲
 * @returns {HintFaceList} 就是 out
 */
export function collectHintFaces(grid, hints, blockToSlot, out) {
  out.reset();

  for (const axis of AXES) {
    const { uCount, vCount } = lineDims(grid, axis);
    const counts = hints.counts[axis];
    const marks = hints.marks[axis];
    const visible = hints.visible[axis];
    const [negFace, posFace] = AXIS_FACES[axis];

    for (let v = 0; v < vCount; v++) {
      for (let u = 0; u < uCount; u++) {
        const key = u + v * uCount;
        if (visible[key] === 0) continue; // 整行隐藏：什么都不贴

        const line = lineOf(grid, axis, u, v);
        let first = -1;
        let last = -1;
        for (let i = 0; i < line.length; i++) {
          const block = line.start + i * line.step;
          if (blockToSlot[block] >= 0) {
            if (first < 0) first = block;
            last = block;
          }
        }
        if (first < 0) continue; // 整条线都看不见了

        const value = counts[key];
        const mark = marks[key];
        out.push(first, negFace, value, mark);
        out.push(last, posFace, value, mark);
      }
    }
  }

  return out;
}
