import { generatePuzzle, DEFAULT_DIFFICULTY_RANGE } from "../puzzle/PuzzleGenerator.js";
import { normalizeMeta } from "./LevelSchema.js";

/**
 * 随机关卡：把生成器的输出包装成与 LevelParser 完全一致的 LevelData
 *
 * ⚠️ 游戏本体已**不再提供随机关卡模式**（玩法只走内置的美术关卡）。
 * 保留这个模块是因为它是 `tools/level-audit.mjs --gen` 的门面：
 * 冒烟测试需要一个"和正式关卡同构"的产物来验证生成器输出可以直接被玩。
 * 如果确认不再需要生成器，本文件与 PuzzleGenerator 可以一并移除。
 */

/** 随机关卡在 HUD 下拉里的占位 id */
export const RANDOM_LEVEL_ID = "__random__";

/**
 * @param {Object} [options] 透传给 PuzzleGenerator.generatePuzzle
 * @returns {import("./LevelParser.js").LevelData & {generation: object}}
 */
export function createRandomLevel(options = {}) {
  const puzzle = generatePuzzle(options);
  const { grid, solution, hints, analysis, seed } = puzzle;

  let solutionCount = 0;
  for (let i = 0; i < solution.length; i++) if (solution[i]) solutionCount++;

  return {
    id: `${RANDOM_LEVEL_ID}${seed}`,
    name: `随机谜面 #${seed}`,
    grid,
    solution,
    hints,
    // 随机造型没有美术意图，配色退化成单色（LevelData 结构保持一致）
    palette: [0xe8d9b8],
    colorIndex: new Uint8Array(grid.count),
    trivia: "",
    solidCount: grid.count,
    solutionCount,
    meta: normalizeMeta({
      author: "generator",
      difficulty: analysis.difficulty.level,
      generated: true,
      seed,
      audit: {
        verdict: analysis.verdict,
        score: analysis.difficulty.score,
        label: analysis.difficulty.label,
      },
    }),
    /** 生成过程信息（尝试次数、修复格数、难度指标），供 HUD 与日志展示 */
    generation: {
      seed,
      size: puzzle.size,
      attempts: puzzle.attempts,
      candidates: puzzle.candidates,
      repaired: puzzle.repaired,
      fallback: puzzle.fallback,
      difficultyRange: options.difficultyRange ?? DEFAULT_DIFFICULTY_RANGE,
      analysis,
    },
  };
}
