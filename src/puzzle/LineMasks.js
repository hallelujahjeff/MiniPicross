import { MARK_PLAIN, MARK_CIRCLE, MARK_SQUARE } from "./HintModel.js";

/**
 * 单条线的合法填充模式枚举（求解器的原子操作）
 *
 * 一条长度 L 的线，其"哪些格子保留"可以用一个 L 位的整数位掩码表示
 * （bit i = 1 表示线上第 i 格属于最终造型）。
 * 给定提示 (count, mark)，合法掩码集合是**固定**的，与谜面无关，
 * 因此可以按 (L, count, mark) 缓存复用：
 *
 *   - 一次枚举 O(2^L)，L ≤ 16 → 最多 65536 次整数运算，只做一次
 *   - 之后每次线求解只是对候选掩码做几次位运算，极快
 *
 * 位掩码方案让"求交集"变成两条累加：
 *   allOnes  &= mask      // 所有候选都为 1 的位 → 必须保留
 *   allZeros &= ~mask     // 所有候选都为 0 的位 → 必须凿除
 */

/** 单轴长度上限，与 LevelSchema.MAX_AXIS 保持一致 */
const MAX_LENGTH = 16;

/** @type {Map<number, Int32Array>} key = L*1000 + count*10 + mark */
const cache = new Map();

/** 32 位整数的置位数（SWAR） */
export function popcount(x) {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >> 24;
}

/** 掩码中连续 1 段的数量（低位是线的起点） */
export function groupCountOfMask(mask) {
  // 每个"上升沿"就是一段的开头：mask & ~(mask << 1)
  return popcount(mask & ~(mask << 1));
}

/** 记号是否与分段数相容 */
export function markMatches(mark, groups) {
  if (mark === MARK_PLAIN) return groups === 1;
  if (mark === MARK_CIRCLE) return groups === 2;
  if (mark === MARK_SQUARE) return groups >= 3;
  return false;
}

/**
 * 取得 (length, count, mark) 对应的全部合法掩码
 *
 * @param {number} length 线长
 * @param {number} count  提示数字（0 = 无提示，整条线都要凿除）
 * @param {number} mark   记号（MARK_*）
 * @returns {Int32Array} 合法掩码列表；长度为 0 表示该提示自相矛盾
 */
export function getLineMasks(length, count, mark) {
  if (!Number.isInteger(length) || length <= 0 || length > MAX_LENGTH) {
    throw new Error(`getLineMasks: 非法线长 ${length}（合法范围 1..${MAX_LENGTH}）`);
  }
  if (count === 0) return ZERO_ONLY;
  if (count > length) return EMPTY;

  const key = length * 1000 + count * 10 + mark;
  const hit = cache.get(key);
  if (hit) return hit;

  const total = 1 << length;
  const out = [];
  for (let mask = 0; mask < total; mask++) {
    if (popcount(mask) !== count) continue;
    if (!markMatches(mark, groupCountOfMask(mask))) continue;
    out.push(mask);
  }
  const arr = Int32Array.from(out);
  cache.set(key, arr);
  return arr;
}

const ZERO_ONLY = Int32Array.of(0);
const EMPTY = new Int32Array(0);

/** 缓存里当前有多少个 (L,count,mark) 组合（自检/统计用） */
export function maskCacheSize() {
  return cache.size;
}

/** 清空缓存（长时间运行的批量生成里控制内存用） */
export function clearMaskCache() {
  cache.clear();
}
