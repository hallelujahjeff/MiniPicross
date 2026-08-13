/**
 * 关卡模板格式规范（解析器与文档的单一事实来源）
 *
 * 模板是一个纯 JSON 数据文件，描述"一个关卡长什么样"：
 *  - size：初始实心长方体的尺寸 [W, H, D]
 *  - encoding + layers/coords：哪些格子属于最终造型（解）
 *  - hiddenHints：哪些线的提示被整行隐藏（由 tools/level-audit.mjs --prune 生成）
 *  - palette + colors：造型完成后展示的最终配色
 *  - trivia：通关演出时展示在屏幕下方的冷知识
 *  - meta：作者、难度等附加信息（不参与逻辑，可自由扩展）
 *
 * 新增字段只需在此追加，不会破坏已有模板的解析。
 */

/** 当前支持的格式版本 */
export const FORMAT_VERSION = 1;

/** 单轴尺寸上限（防止手写模板笔误造成百万级格子） */
export const MAX_AXIS = 16;
/** 总格子数上限 */
export const MAX_CELLS = MAX_AXIS * MAX_AXIS * MAX_AXIS;

/** 支持的编码方式 */
export const ENCODING_LAYERS = "layers";
export const ENCODING_COORDS = "coords";
export const ENCODINGS = [ENCODING_LAYERS, ENCODING_COORDS];

/** layers 字符画约定 */
export const CHAR_SOLID = "#";
export const CHAR_EMPTY = ".";
/** 允许的空白别名（书写时更自由） */
export const EMPTY_ALIASES = new Set([CHAR_EMPTY, " ", "_", "-", "0"]);
/** 允许的实心别名 */
export const SOLID_ALIASES = new Set([CHAR_SOLID, "X", "x", "1", "*"]);

/** 调色板上限（colors 用单个字符表示索引，1..9） */
export const MAX_PALETTE = 9;
/** 没写 palette 时的兜底配色：与未完成状态的乳白区分开的暖砂色 */
export const DEFAULT_PALETTE = [0xe8d9b8];

/**
 * 判定单个字符语义
 * @returns {1|0|null} 1=实心 0=空 null=非法字符
 */
export function charToSolid(ch) {
  if (SOLID_ALIASES.has(ch)) return 1;
  if (EMPTY_ALIASES.has(ch)) return 0;
  return null;
}

/**
 * colors 字符画约定：`'1'`..`'9'` → palette[0..8]，`'.'` 与 `'0'` 等价于 `'1'`
 *
 * 之所以让 `.` 等于第一个颜色，是为了让"整层都是主色"的图层可以直接写成一片点，
 * 只有需要换色的格子才写数字——手写模板时省下大量噪音。
 * @returns {number|null} 0-based 调色板索引；null = 非法字符
 */
export function charToColorIndex(ch, paletteSize) {
  if (ch === CHAR_EMPTY || ch === " " || ch === "0" || ch === "1") return 0;
  const code = ch.charCodeAt(0) - 48; // '0'
  if (code < 2 || code > MAX_PALETTE) return null;
  return code - 1 <= paletteSize - 1 ? code - 1 : null;
}

/** #rrggbb / rrggbb / 0xrrggbb → 整数；非法返回 null */
export function parseColor(value) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffff) {
    return value;
  }
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/^#/, "").replace(/^0x/i, "");
  if (!/^[0-9a-f]{6}$/i.test(text)) return null;
  return Number.parseInt(text, 16);
}

/** meta 默认值填充 */
export function normalizeMeta(meta) {
  return {
    author: "builtin",
    difficulty: 1,
    ...(meta && typeof meta === "object" ? meta : {}),
  };
}
