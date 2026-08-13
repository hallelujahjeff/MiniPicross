/**
 * 整数体素坐标系（唯一事实来源，不依赖 three）
 *
 * 约定：
 *  - 网格尺寸 size = [W, H, D]，分别对应 X / Y / Z 轴的格子数
 *  - 合法整数坐标：x ∈ [0, W)，y ∈ [0, H)，z ∈ [0, D)
 *  - 线性索引：index = x + y * W + z * W * H
 *      X 变化最快 → 沿任意单轴取"线"都是固定步长跳跃（后续算提示数字为 O(length)）
 *  - 世界坐标做居中映射：整个长方体的几何中心恒定落在世界原点
 *      这样 OrbitControls.target 可以永久锁在 (0,0,0)
 */

/** 单个方块占据的世界空间边长 */
export const CELL = 1;

/** 轴枚举（与 forEachLine / lineOf 的 axis 参数对应） */
export const AXIS_X = 0;
export const AXIS_Y = 1;
export const AXIS_Z = 2;

/**
 * @typedef {Object} Grid
 * @property {number} W X 轴格子数
 * @property {number} H Y 轴格子数
 * @property {number} D Z 轴格子数
 * @property {number} count 总格子数 = W * H * D
 * @property {number} strideY 索引中沿 Y 前进一格的步长
 * @property {number} strideZ 索引中沿 Z 前进一格的步长
 */

/**
 * 创建网格描述对象（不可变）
 * @param {[number, number, number]} size
 * @returns {Grid}
 */
export function createGrid(size) {
  if (!Array.isArray(size) || size.length !== 3) {
    throw new Error(`createGrid: size 必须是长度为 3 的数组，收到 ${JSON.stringify(size)}`);
  }
  const [W, H, D] = size;
  for (const [name, v] of [
    ["W", W],
    ["H", H],
    ["D", D],
  ]) {
    if (!Number.isInteger(v) || v <= 0) {
      throw new Error(`createGrid: 尺寸 ${name} 必须是正整数，收到 ${v}`);
    }
  }
  return Object.freeze({
    W,
    H,
    D,
    count: W * H * D,
    strideY: W,
    strideZ: W * H,
  });
}

/**
 * 整数坐标 → 线性索引（不做边界检查，热路径调用前请自行保证合法）
 * @param {Grid} grid
 */
export function indexOf(grid, x, y, z) {
  return x + y * grid.strideY + z * grid.strideZ;
}

/**
 * 线性索引 → 整数坐标
 * @param {Grid} grid
 * @param {number} index
 * @param {{x:number,y:number,z:number}} [out] 复用对象，避免热路径产生垃圾
 */
export function coordsOf(grid, index, out = { x: 0, y: 0, z: 0 }) {
  const z = Math.floor(index / grid.strideZ);
  const rest = index - z * grid.strideZ;
  const y = Math.floor(rest / grid.strideY);
  out.x = rest - y * grid.strideY;
  out.y = y;
  out.z = z;
  return out;
}

/**
 * 坐标是否在网格内
 * @param {Grid} grid
 */
export function inBounds(grid, x, y, z) {
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    Number.isInteger(z) &&
    x >= 0 &&
    x < grid.W &&
    y >= 0 &&
    y < grid.H &&
    z >= 0 &&
    z < grid.D
  );
}

/**
 * 整数格坐标 → 世界坐标（居中映射，几何中心在原点）
 * @param {Grid} grid
 * @param {{x:number,y:number,z:number}} [out]
 */
export function gridToWorld(grid, x, y, z, out = { x: 0, y: 0, z: 0 }) {
  out.x = (x - (grid.W - 1) / 2) * CELL;
  out.y = (y - (grid.H - 1) / 2) * CELL;
  out.z = (z - (grid.D - 1) / 2) * CELL;
  return out;
}

/**
 * 世界坐标 → 最近的整数格坐标（拾取/落点判定用；不保证在界内，需配合 inBounds）
 * @param {Grid} grid
 * @param {{x:number,y:number,z:number}} [out]
 */
export function worldToGrid(grid, wx, wy, wz, out = { x: 0, y: 0, z: 0 }) {
  out.x = Math.round(wx / CELL + (grid.W - 1) / 2);
  out.y = Math.round(wy / CELL + (grid.H - 1) / 2);
  out.z = Math.round(wz / CELL + (grid.D - 1) / 2);
  return out;
}

/** 网格在世界空间的尺寸（用于相机取景） */
export function worldSize(grid) {
  return { x: grid.W * CELL, y: grid.H * CELL, z: grid.D * CELL };
}

/**
 * @typedef {Object} LineDescriptor
 * @property {number} axis 0=X 1=Y 2=Z
 * @property {number} start 该线第一个格子的线性索引
 * @property {number} step  沿该轴前进一格的索引步长
 * @property {number} length 该线的格子数
 * @property {number} u 垂直于 axis 的第一个坐标（见 forEachLine 说明）
 * @property {number} v 垂直于 axis 的第二个坐标
 */

/**
 * 取得沿指定轴、由另两轴坐标 (u, v) 确定的一条线
 *  - axis = X：(u, v) = (y, z)
 *  - axis = Y：(u, v) = (x, z)
 *  - axis = Z：(u, v) = (x, y)
 * @param {Grid} grid
 * @returns {LineDescriptor}
 */
export function lineOf(grid, axis, u, v) {
  switch (axis) {
    case AXIS_X:
      return {
        axis,
        u,
        v,
        start: u * grid.strideY + v * grid.strideZ,
        step: 1,
        length: grid.W,
      };
    case AXIS_Y:
      return {
        axis,
        u,
        v,
        start: u + v * grid.strideZ,
        step: grid.strideY,
        length: grid.H,
      };
    case AXIS_Z:
      return {
        axis,
        u,
        v,
        start: u + v * grid.strideY,
        step: grid.strideZ,
        length: grid.D,
      };
    default:
      throw new Error(`lineOf: 非法 axis=${axis}，仅支持 0(X) / 1(Y) / 2(Z)`);
  }
}

/**
 * 遍历沿指定轴的所有线（后续计算提示数字的基础设施）
 * @param {Grid} grid
 * @param {number} axis
 * @param {(line: LineDescriptor) => void} cb
 */
export function forEachLine(grid, axis, cb) {
  const [uCount, vCount] =
    axis === AXIS_X
      ? [grid.H, grid.D]
      : axis === AXIS_Y
        ? [grid.W, grid.D]
        : axis === AXIS_Z
          ? [grid.W, grid.H]
          : (() => {
              throw new Error(`forEachLine: 非法 axis=${axis}`);
            })();

  for (let v = 0; v < vCount; v++) {
    for (let u = 0; u < uCount; u++) {
      cb(lineOf(grid, axis, u, v));
    }
  }
}
