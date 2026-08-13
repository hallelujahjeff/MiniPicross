import { CELL } from "./GridCoords.js";

/**
 * 体素射线步进拾取（Amanatides & Woo 的 3D-DDA，纯数学，不依赖 three）
 *
 * ## 为什么不用 three 的 InstancedMesh.raycast
 * three 对实例化网格的拾取是"逐实例遍历 + 逐三角求交"：
 * 1000 个方块 × 108 个三角 = 每次拾取十万级三角测试。
 * 鼠标移动时每帧都要拾取（悬停高亮），这个开销会直接吃掉帧率。
 *
 * 而方块本来就是**规整体素网格**，可以沿射线一格一格走过去，
 * 复杂度是"穿过的格子数"（几十步），并且结果精确。
 * 顺带还免费得到"从哪个面进入"，可用于后续扩展（例如沿面拖拽多选）。
 *
 * 坐标系：内部换算到 u 空间，格子 i 占据 [i, i+1)，整个网格是 [0, N]。
 *   u = world / CELL + N / 2
 */

/** 面编号与 HintFaces 的 FACE_* 保持一致 */
const FACE_BY_AXIS_SIGN = [
  [0, 1], // X: -X, +X
  [2, 3], // Y: -Y, +Y
  [4, 5], // Z: -Z, +Z
];

const EPS = 1e-9;

/**
 * @param {import("./GridCoords.js").Grid} grid
 * @param {{x:number,y:number,z:number}} origin 世界空间射线起点
 * @param {{x:number,y:number,z:number}} direction 世界空间射线方向（无需归一化）
 * @param {(block:number) => boolean} isVisible 该格子当前是否可见（可拾取）
 * @param {{block:number,x:number,y:number,z:number,t:number,face:number}} [out]
 * @returns {typeof out|null} 命中的第一个可见格子；没命中返回 null
 */
export function raycastVoxels(grid, origin, direction, isVisible, out = {}) {
  const sizes = [grid.W, grid.H, grid.D];

  // 世界 → u 空间
  const p = [
    origin.x / CELL + grid.W / 2,
    origin.y / CELL + grid.H / 2,
    origin.z / CELL + grid.D / 2,
  ];
  const d = [direction.x, direction.y, direction.z];

  // 先把射线裁剪到网格 AABB，得到进入时刻与进入面
  let tMin = 0;
  let tMax = Infinity;
  let enterAxis = -1;
  let enterSign = 1;

  for (let a = 0; a < 3; a++) {
    const n = sizes[a];
    if (Math.abs(d[a]) < EPS) {
      if (p[a] < 0 || p[a] > n) return null;
      continue;
    }
    const inv = 1 / d[a];
    let t1 = (0 - p[a]) * inv;
    let t2 = (n - p[a]) * inv;
    let sign = -1; // 从该轴负侧进入
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
      sign = 1;
    }
    if (t1 > tMin) {
      tMin = t1;
      enterAxis = a;
      enterSign = sign;
    }
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }

  // 略微往体内推一点，避免正好落在边界上时取到相邻格
  const t0 = tMin + 1e-4;
  const cur = [
    clampInt(Math.floor(p[0] + d[0] * t0), 0, grid.W - 1),
    clampInt(Math.floor(p[1] + d[1] * t0), 0, grid.H - 1),
    clampInt(Math.floor(p[2] + d[2] * t0), 0, grid.D - 1),
  ];

  const step = [0, 0, 0];
  const tDelta = [Infinity, Infinity, Infinity];
  const tNext = [Infinity, Infinity, Infinity];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < EPS) continue;
    step[a] = d[a] > 0 ? 1 : -1;
    tDelta[a] = Math.abs(1 / d[a]);
    const boundary = step[a] > 0 ? cur[a] + 1 : cur[a];
    tNext[a] = (boundary - p[a]) / d[a];
  }

  const strides = [1, grid.strideY, grid.strideZ];
  let hitAxis = enterAxis;
  let hitSign = enterSign;
  // 最多穿过的格子数：三轴之和 + 余量
  let guard = grid.W + grid.H + grid.D + 3;

  while (guard-- > 0) {
    const block = cur[0] * strides[0] + cur[1] * strides[1] + cur[2] * strides[2];
    if (isVisible(block)) {
      out.block = block;
      out.x = cur[0];
      out.y = cur[1];
      out.z = cur[2];
      out.t = Math.max(tMin, 0);
      // hitSign 表示"从该轴的哪一侧进入"，-1 = 负侧 → 命中的是负向面
      out.face = hitAxis < 0 ? 5 : FACE_BY_AXIS_SIGN[hitAxis][hitSign < 0 ? 0 : 1];
      return out;
    }

    // 走到下一格：取三个轴里最先跨越边界的那个
    let axis = 0;
    if (tNext[1] < tNext[0]) axis = 1;
    if (tNext[2] < tNext[axis]) axis = 2;
    if (!Number.isFinite(tNext[axis])) return null;

    cur[axis] += step[axis];
    if (cur[axis] < 0 || cur[axis] >= sizes[axis]) return null;
    tNext[axis] += tDelta[axis];
    hitAxis = axis;
    hitSign = -step[axis]; // 从步进方向的反面进入
  }

  return null;
}

function clampInt(v, min, max) {
  return v < min ? min : v > max ? max : v;
}
