/**
 * 方块运行时状态（位标记，存放于 Uint8Array）
 *
 * 集中定义避免魔法数字散落各处。
 * 一个方块的生命周期：
 *   INTACT（初始实心）
 *     ├─ 玩家标记 → 追加 PAINTED 位（表示"我认为它属于最终造型，别敲"）
 *     ├─ 玩家凿除 → 追加 REMOVED 位（视觉上从实例化网格中摘除）
 *     └─ 所在整行完成 → 追加 CONFIRMED 位，显示最终造型配色并**锁定**
 *
 * CONFIRMED 一定同时带着 PAINTED（锁定的方块必然是被认定保留的），
 * 因此 isPainted() 只查 PAINTED 位就够了。
 */

/** 完好、未被处理 */
export const INTACT = 0;
/** 已被涂色标记（保护） */
export const PAINTED = 1 << 0;
/** 已被凿除 */
export const REMOVED = 1 << 1;
/** 已确认：所在整行推完了，显示最终配色，不能再取消标记 */
export const CONFIRMED = 1 << 2;

/** 是否已被凿除 */
export function isRemoved(state) {
  return (state & REMOVED) !== 0;
}

/** 是否被涂色标记（含已确认） */
export function isPainted(state) {
  return (state & PAINTED) !== 0;
}

/** 是否已确认并上色 */
export function isConfirmed(state) {
  return (state & CONFIRMED) !== 0;
}

/** 是否仍留在场上（未凿除） */
export function isPresent(state) {
  return (state & REMOVED) === 0;
}

/** 置位 */
export function setFlag(state, flag) {
  return state | flag;
}

/** 清位 */
export function clearFlag(state, flag) {
  return state & ~flag;
}

/** 翻转某一位 */
export function toggleFlag(state, flag) {
  return state ^ flag;
}
