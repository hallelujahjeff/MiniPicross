/**
 * 可复现的伪随机数发生器（mulberry32）
 *
 * 谜面生成必须可复现：同一个 seed 一定生成同一个谜面。
 * 这样"随机关卡"可以用一串 seed 分享/复盘，出问题也能稳定重现。
 * 不使用 Math.random()，因为它无法指定种子。
 */

/** 字符串 → 32 位种子（FNV-1a 变体），用于把 "duck#3" 这类可读种子转成数字 */
export function hashSeed(input) {
  const str = String(input);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // 末尾再打散一次，避免短字符串种子的低位相关性
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

/** 生成一个可读性尚可的新种子（用于"随机来一关"） */
export function randomSeed() {
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
}

export class Rng {
  /** @param {number|string} seed */
  constructor(seed = 1) {
    this.seed = typeof seed === "number" && Number.isFinite(seed) ? seed >>> 0 : hashSeed(seed);
    this._s = this.seed || 1;
  }

  /** [0, 1) */
  next() {
    let t = (this._s += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [0, maxExclusive) 的整数 */
  int(maxExclusive) {
    return Math.floor(this.next() * maxExclusive);
  }

  /** [min, max] 的整数（闭区间） */
  range(min, max) {
    if (max <= min) return min;
    return min + this.int(max - min + 1);
  }

  /** 以概率 p 返回 true */
  chance(p) {
    return this.next() < p;
  }

  /** 从数组里取一个元素 */
  pick(arr) {
    return arr.length === 0 ? undefined : arr[this.int(arr.length)];
  }

  /** 原地 Fisher–Yates 洗牌 */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }
}
