import { createGrid, indexOf, inBounds, coordsOf } from "../core/GridCoords.js";
import { computeHints } from "../puzzle/HintModel.js";
import {
  FORMAT_VERSION,
  MAX_AXIS,
  MAX_CELLS,
  MAX_PALETTE,
  DEFAULT_PALETTE,
  ENCODINGS,
  ENCODING_LAYERS,
  ENCODING_COORDS,
  charToSolid,
  charToColorIndex,
  parseColor,
  normalizeMeta,
} from "./LevelSchema.js";

/**
 * 关卡模板解析 + 严格校验（纯数据，不依赖 three，可单独测试）
 *
 * 设计原则：**绝不静默容错**。任何格式问题都抛出带关卡 id 与
 * 具体出错位置（层号/行号/列号，或坐标值）的错误，避免后续调试黑洞。
 *
 * 解析产物里的 `hints` 由造型自动推导（提示是造型的函数，见 HintModel），
 * 因此模板里**不需要也不允许**手写提示数字——手写只会引入不一致的风险。
 * 模板里唯一与提示有关的字段是 `hiddenHints`（哪些线整行隐藏），
 * 它由 `tools/level-audit.mjs --prune` 离线算出并写回，因为"哪些提示是冗余的"
 * 需要反复跑求解器验证，不适合每次加载时重算。
 */

/**
 * @typedef {Object} LevelData
 * @property {string} id
 * @property {string} name
 * @property {import("../core/GridCoords.js").Grid} grid
 * @property {Uint8Array} solution   长度 = grid.count，1 表示属于最终造型
 * @property {import("../puzzle/HintModel.js").HintSet} hints 由 solution 推导的提示
 * @property {number[]} palette      最终造型的配色（0xrrggbb 整数）
 * @property {Uint8Array} colorIndex 每格在 palette 中的下标（仅解方块有意义）
 * @property {string} trivia         通关演出展示的冷知识（可为空串）
 * @property {number} solidCount     初始实心方块数（步骤1 = grid.count）
 * @property {number} solutionCount  解方块数
 * @property {Object} meta
 */

class LevelParseError extends Error {
  constructor(id, message) {
    super(`[关卡 ${id ?? "<未命名>"}] ${message}`);
    this.name = "LevelParseError";
    this.levelId = id;
  }
}

/**
 * 解析并校验一份关卡模板
 * @param {object} raw 从 JSON 读到的原始对象
 * @param {string} [fallbackId] 缺少 id 时的兜底（通常用文件名）
 * @returns {LevelData}
 */
export function parseLevel(raw, fallbackId) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LevelParseError(fallbackId, "模板内容必须是一个 JSON 对象");
  }

  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : fallbackId;
  if (!id) {
    throw new LevelParseError(undefined, "缺少 id 字段，且无法从文件名推断");
  }

  const version = raw.formatVersion ?? FORMAT_VERSION;
  if (version !== FORMAT_VERSION) {
    throw new LevelParseError(
      id,
      `formatVersion=${version} 不受支持，当前解析器仅支持 ${FORMAT_VERSION}`,
    );
  }

  const grid = parseSize(id, raw.size);

  const encoding = raw.encoding ?? ENCODING_LAYERS;
  if (!ENCODINGS.includes(encoding)) {
    throw new LevelParseError(
      id,
      `encoding="${encoding}" 不受支持，可选值：${ENCODINGS.join(" / ")}`,
    );
  }

  const solution = new Uint8Array(grid.count);
  if (encoding === ENCODING_LAYERS) {
    fillFromLayers(id, grid, raw.layers, solution);
  } else if (encoding === ENCODING_COORDS) {
    fillFromCoords(id, grid, raw.coords, solution);
  }

  let solutionCount = 0;
  for (let i = 0; i < solution.length; i++) if (solution[i]) solutionCount++;

  if (solutionCount === 0) {
    throw new LevelParseError(id, "解为空：没有任何方块属于最终造型，关卡无意义");
  }
  if (solutionCount === grid.count) {
    throw new LevelParseError(
      id,
      "解占满了整个长方体：没有任何方块需要凿除，关卡无意义",
    );
  }

  const hints = computeHints(grid, solution);
  if (raw.hiddenHints !== undefined) {
    hints.importHidden(raw.hiddenHints, (message) => {
      throw new LevelParseError(id, message);
    });
  }

  const palette = parsePalette(id, raw.palette);
  const colorIndex = parseColors(id, grid, raw.colors, palette.length);

  if (raw.trivia !== undefined && typeof raw.trivia !== "string") {
    throw new LevelParseError(id, `trivia 必须是字符串，收到 ${typeof raw.trivia}`);
  }

  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    grid,
    solution,
    hints,
    palette,
    colorIndex,
    trivia: typeof raw.trivia === "string" ? raw.trivia.trim() : "",
    solidCount: grid.count,
    solutionCount,
    meta: normalizeMeta(raw.meta),
  };
}

/** 校验 palette：1..MAX_PALETTE 个颜色 */
function parsePalette(id, palette) {
  if (palette === undefined) return [...DEFAULT_PALETTE];
  if (!Array.isArray(palette) || palette.length === 0) {
    throw new LevelParseError(id, "palette 必须是非空数组，元素形如 \"#rrggbb\"");
  }
  if (palette.length > MAX_PALETTE) {
    throw new LevelParseError(
      id,
      `palette 有 ${palette.length} 个颜色，超过上限 ${MAX_PALETTE}（colors 用单个字符 1..9 索引）`,
    );
  }
  return palette.map((v, i) => {
    const color = parseColor(v);
    if (color === null) {
      throw new LevelParseError(
        id,
        `palette[${i}] = ${JSON.stringify(v)} 不是合法颜色（应形如 "#ffd447"）`,
      );
    }
    return color;
  });
}

/**
 * colors 编码：与 layers 同形（colors[y][z][x]），字符是调色板索引
 *
 * 省略 colors 时按**高度均分调色板**兜底：单色关卡直接一片纯色，
 * 多色关卡自然形成自下而上的分层渐变。这让"只想换个颜色"的关卡零成本。
 */
function parseColors(id, grid, colors, paletteSize) {
  const out = new Uint8Array(grid.count);

  if (colors === undefined) {
    if (paletteSize <= 1) return out;
    const c = { x: 0, y: 0, z: 0 };
    for (let cell = 0; cell < grid.count; cell++) {
      coordsOf(grid, cell, c);
      const band = Math.floor((c.y / grid.H) * paletteSize);
      out[cell] = Math.min(paletteSize - 1, Math.max(0, band));
    }
    return out;
  }

  if (!Array.isArray(colors) || colors.length !== grid.H) {
    throw new LevelParseError(
      id,
      `colors 必须与 layers 同形：${grid.H} 层（收到 ${Array.isArray(colors) ? colors.length : typeof colors}）`,
    );
  }
  for (let y = 0; y < grid.H; y++) {
    const layer = colors[y];
    if (!Array.isArray(layer) || layer.length !== grid.D) {
      throw new LevelParseError(
        id,
        `colors[${y}] 必须是 ${grid.D} 行字符串（收到 ${Array.isArray(layer) ? layer.length : typeof layer}）`,
      );
    }
    for (let z = 0; z < grid.D; z++) {
      const row = layer[z];
      if (typeof row !== "string" || row.length !== grid.W) {
        throw new LevelParseError(
          id,
          `colors[${y}][${z}] 必须是长度 ${grid.W} 的字符串，收到 ${JSON.stringify(row)}`,
        );
      }
      for (let x = 0; x < grid.W; x++) {
        const index = charToColorIndex(row[x], paletteSize);
        if (index === null) {
          throw new LevelParseError(
            id,
            `colors[${y}][${z}] 第 ${x} 个字符 "${row[x]}" 非法：` +
              `只能是 . / 空格 / 0 / 1..${paletteSize}（palette 只有 ${paletteSize} 个颜色）`,
          );
        }
        out[indexOf(grid, x, y, z)] = index;
      }
    }
  }
  return out;
}

/** 校验并构造网格 */
function parseSize(id, size) {
  if (!Array.isArray(size) || size.length !== 3) {
    throw new LevelParseError(
      id,
      `size 必须是形如 [W, H, D] 的三元数组，收到 ${JSON.stringify(size)}`,
    );
  }
  const axisNames = ["W(X)", "H(Y)", "D(Z)"];
  size.forEach((v, i) => {
    if (!Number.isInteger(v) || v <= 0) {
      throw new LevelParseError(id, `size 的 ${axisNames[i]} 必须是正整数，收到 ${v}`);
    }
    if (v > MAX_AXIS) {
      throw new LevelParseError(
        id,
        `size 的 ${axisNames[i]} = ${v} 超过单轴上限 ${MAX_AXIS}`,
      );
    }
  });
  const total = size[0] * size[1] * size[2];
  if (total > MAX_CELLS) {
    throw new LevelParseError(id, `总格子数 ${total} 超过上限 ${MAX_CELLS}`);
  }
  return createGrid(size);
}

/**
 * layers 编码：layers[y][z][x]
 *  - y 自下而上（layers[0] 是最底层）
 *  - 每层 D 行字符串，每行 W 个字符
 */
function fillFromLayers(id, grid, layers, out) {
  if (!Array.isArray(layers)) {
    throw new LevelParseError(id, 'encoding="layers" 时必须提供 layers 数组');
  }
  if (layers.length !== grid.H) {
    throw new LevelParseError(
      id,
      `layers 层数 ${layers.length} 与 size 的 H=${grid.H} 不一致（layers[y]，y 自下而上）`,
    );
  }

  for (let y = 0; y < grid.H; y++) {
    const layer = layers[y];
    if (!Array.isArray(layer)) {
      throw new LevelParseError(id, `layers[${y}] 必须是字符串数组（共 D=${grid.D} 行）`);
    }
    if (layer.length !== grid.D) {
      throw new LevelParseError(
        id,
        `layers[${y}] 行数 ${layer.length} 与 size 的 D=${grid.D} 不一致`,
      );
    }
    for (let z = 0; z < grid.D; z++) {
      const row = layer[z];
      if (typeof row !== "string") {
        throw new LevelParseError(
          id,
          `layers[${y}][${z}] 必须是字符串，收到 ${typeof row}`,
        );
      }
      if (row.length !== grid.W) {
        throw new LevelParseError(
          id,
          `layers[${y}][${z}] 长度 ${row.length} 与 size 的 W=${grid.W} 不一致："${row}"`,
        );
      }
      for (let x = 0; x < grid.W; x++) {
        const solid = charToSolid(row[x]);
        if (solid === null) {
          throw new LevelParseError(
            id,
            `layers[${y}][${z}] 第 ${x} 个字符 "${row[x]}" 非法（实心用 # / x / X / 1 / *，空用 . / 空格 / _ / - / 0）`,
          );
        }
        if (solid) out[indexOf(grid, x, y, z)] = 1;
      }
    }
  }
}

/** coords 编码：显式坐标列表 [[x,y,z], ...] */
function fillFromCoords(id, grid, coords, out) {
  if (!Array.isArray(coords)) {
    throw new LevelParseError(id, 'encoding="coords" 时必须提供 coords 数组');
  }
  if (coords.length === 0) {
    throw new LevelParseError(id, "coords 为空数组，关卡没有解");
  }

  for (let i = 0; i < coords.length; i++) {
    const c = coords[i];
    if (!Array.isArray(c) || c.length !== 3) {
      throw new LevelParseError(
        id,
        `coords[${i}] 必须是 [x, y, z] 三元数组，收到 ${JSON.stringify(c)}`,
      );
    }
    const [x, y, z] = c;
    if (!inBounds(grid, x, y, z)) {
      throw new LevelParseError(
        id,
        `coords[${i}] = [${x}, ${y}, ${z}] 越界或非整数（合法范围 x<${grid.W}, y<${grid.H}, z<${grid.D}）`,
      );
    }
    const idx = indexOf(grid, x, y, z);
    if (out[idx] === 1) {
      throw new LevelParseError(id, `coords[${i}] = [${x}, ${y}, ${z}] 重复出现`);
    }
    out[idx] = 1;
  }
}

export { LevelParseError };
