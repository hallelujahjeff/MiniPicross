#!/usr/bin/env node
/**
 * 关卡谜面审计工具（Node 端离线运行，不参与前端打包）
 *
 *   node tools/level-audit.mjs             # 审计全部内置关卡，输出可解性与难度报告
 *   node tools/level-audit.mjs --fix       # 对不合格关卡做最小改动修复并写回 JSON
 *   node tools/level-audit.mjs --prune     # 计算"可以整行隐藏的提示"并写回 JSON
 *   node tools/level-audit.mjs --gen 20    # 冒烟测试随机谜面生成器（生成 20 个）
 *   node tools/level-audit.mjs --repair 20 # 冒烟测试修复算法（拿纯噪声造型当输入）
 *
 * 之所以做成离线工具而不是运行时校验：
 *  - 内置美术关卡的造型是"资产"，修复/裁剪结果应当固化进 JSON 并可 diff 审查，
 *    而不是每次启动在浏览器里重算一遍（既慢又不可复现）。
 *  - 尤其是 --prune：判断"某条提示是否冗余"必须藏掉它再跑一遍求解器，
 *    一关有上百条线，代价是上百次传播，绝不适合放在加载路径上。
 *  - 前端只保留轻量的启动自检（App 里按 ?audit=1 打开），职责分明。
 *
 * 依赖的都是 src/ 下不含 three 的纯数据模块，所以 Node 可以直接跑。
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseLevel } from "../src/level/LevelParser.js";
import { analyzePuzzle, pruneHints } from "../src/puzzle/PuzzleSolver.js";
import { computeHints } from "../src/puzzle/HintModel.js";
import { repairSolution, generatePuzzle } from "../src/puzzle/PuzzleGenerator.js";
import { Rng } from "../src/core/Rng.js";
import { createGrid, indexOf } from "../src/core/GridCoords.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LEVEL_DIR = resolve(HERE, "../src/level/levels");

const args = process.argv.slice(2);
const doFix = args.includes("--fix");
const doPrune = args.includes("--prune");
const genIndex = args.indexOf("--gen");
const genCount = genIndex >= 0 ? Number(args[genIndex + 1] ?? 10) : 0;
const repairIndex = args.indexOf("--repair");
const repairCount = repairIndex >= 0 ? Number(args[repairIndex + 1] ?? 10) : 0;

/**
 * 裁剪的难度上限：超过就停手
 *
 * 这个值直接决定"最难的关能有多难"。之前定 3.9 偏保守——实测下来
 * 玩家反馈推理深度不够，所以放到 4.6（`DIFFICULTY_LABELS` 里 5 = 硬核，
 * 4.6 落在"有挑战"偏上），让 duck 这类大关能吃到更深的推理链。
 */
const PRUNE_MAX_SCORE = 4.6;
/** 裁剪的隐藏比例上限：兜底，避免画面被藏得太空 */
const PRUNE_MAX_RATIO = 0.5;
/**
 * 每个**解方块**至少要保留几条可见线（3 条里）
 *
 * 这是"推理链能不能接上"的结构性保证：只要每个会留下来的方块都有 ≥2 条可见线，
 * 玩家推完一个轴，必然给另一个轴喂进新信息——不会出现
 * "涂完一整行，抬头发现纵向一个数字都没有"的断链。
 * 只约束解方块是因为非解方块会被凿掉，它那条线的数字会自动迁移到后面的方块上。
 */
const PRUNE_MIN_VISIBLE_PER_CELL = 2;
/** 空格（会被凿掉）的可见线下限：更松，只是避免整片区域完全无信息 */
const PRUNE_MIN_VISIBLE_PER_EMPTY = 1;

if (genCount > 0) {
  smokeTestGenerator(genCount);
} else if (repairCount > 0) {
  smokeTestRepair(repairCount);
} else if (doPrune) {
  pruneLevels();
} else {
  auditLevels(doFix);
}

/**
 * 计算每关"可以整行隐藏的提示"并写回 JSON
 *
 * 隐藏顺序用关卡 id 作种子确定性打乱，所以同一关反复跑结果完全一致（可 diff）。
 * 每次隐藏后都会重新验证"无需猜测即可解"，并受难度上限约束。
 */
function pruneLevels() {
  const files = readdirSync(LEVEL_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  console.log(`裁剪 ${files.length} 个关卡的提示（目录 ${LEVEL_DIR}）\n`);

  for (const file of files) {
    const path = join(LEVEL_DIR, file);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const id = file.replace(/\.json$/, "");

    let level;
    try {
      // 先把已有的 hiddenHints 清掉，从"全部显示"重新算一遍，保证结果只取决于造型
      level = parseLevel({ ...raw, hiddenHints: undefined }, id);
    } catch (err) {
      console.log(`✗ ${id.padEnd(15)} 解析失败：${err.message}`);
      continue;
    }

    const hints = computeHints(level.grid, level.solution);
    const t0 = performance.now();
    const result = pruneHints(level.grid, level.solution, hints, {
      seed: `prune:${id}`,
      maxScore: PRUNE_MAX_SCORE,
      maxHiddenRatio: PRUNE_MAX_RATIO,
      minVisiblePerCell: PRUNE_MIN_VISIBLE_PER_CELL,
      minVisiblePerEmpty: PRUNE_MIN_VISIBLE_PER_EMPTY,
      protectSquare: true,
    });
    const ms = performance.now() - t0;

    if (!result.ok) {
      console.log(`✗ ${id.padEnd(15)} ${result.reason}`);
      continue;
    }

    const s = result.summary;
    console.log(
      `✓ ${id.padEnd(15)} 隐藏 ${String(result.hidden).padStart(3)}/${String(s.total).padEnd(3)} ` +
        `(${String(Math.round(s.hiddenRatio * 100)).padStart(2)}%)  ` +
        `可见 裸${String(s.plain).padStart(3)} 圆${String(s.circle).padStart(2)} ` +
        `方${String(s.square).padStart(2)} 零${String(s.zero).padStart(3)}  ` +
        `难度 ${result.difficulty.score.toFixed(2)}(${result.difficulty.label})  ` +
        `波次 ${result.difficulty.metrics.waves}  ${result.reason}  ${ms.toFixed(0)}ms`,
    );

    raw.hiddenHints = hints.exportHidden();
    raw.meta = { ...(raw.meta ?? {}) };
    raw.meta.difficulty = result.difficulty.level;
    raw.meta.audit = {
      verdict: "solvable",
      score: result.difficulty.score,
      hiddenHints: result.hidden,
      shownHints: s.shown,
    };
    writeFileSync(path, formatLevelJson(raw), "utf8");
  }

  console.log(
    `\n难度上限 ${PRUNE_MAX_SCORE.toFixed(2)}、隐藏比例上限 ${Math.round(PRUNE_MAX_RATIO * 100)}%、` +
      `每个解方块至少 ${PRUNE_MIN_VISIBLE_PER_CELL} 条可见线（空格 ${PRUNE_MIN_VISIBLE_PER_EMPTY}）、` +
      `方框提示不隐藏；结果已写入各关卡的 hiddenHints 字段`,
  );
}

/** 审计（并可选修复）全部内置关卡 */
function auditLevels(fix) {
  const files = readdirSync(LEVEL_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  let bad = 0;
  console.log(`审计 ${files.length} 个关卡模板（目录 ${LEVEL_DIR}）\n`);

  for (const file of files) {
    const path = join(LEVEL_DIR, file);
    const raw = JSON.parse(readFileSync(path, "utf8"));

    let level;
    try {
      level = parseLevel(raw, file.replace(/\.json$/, ""));
    } catch (err) {
      console.log(`✗ ${file}  解析失败：${err.message}`);
      bad++;
      continue;
    }

    const t0 = performance.now();
    const analysis = analyzePuzzle(level.grid, level.solution, { hints: level.hints });
    const ms = (performance.now() - t0).toFixed(1);
    const d = analysis.difficulty;
    const h = d.metrics.hints;

    const head =
      `${analysis.ok ? "✓" : "✗"} ${level.id.padEnd(15)} ` +
      `${`${level.grid.W}×${level.grid.H}×${level.grid.D}`.padEnd(9)} ` +
      `解 ${String(level.solutionCount).padStart(4)}/${String(level.grid.count).padEnd(5)}`;
    const tail =
      `难度 ${d.score.toFixed(2)}(${d.label})  ` +
      `波次 ${d.metrics.waves}  最大候选 ${d.metrics.maxCandidates}  ` +
      `提示 裸${h.plain}/圆${h.circle}/方${h.square}/零${h.zero}/藏${h.hidden}  ${ms}ms`;

    console.log(`${head}  ${tail}`);
    if (!analysis.ok) {
      bad++;
      console.log(`    → ${analysis.message}`);

      if (fix) {
        const rep = repairSolution({
          grid: level.grid,
          solution: level.solution,
          rng: new Rng(`fix:${level.id}`),
          maxFlips: 40,
          sampleSize: 16,
          timeBudgetMs: 20000,
        });
        if (!rep.ok) {
          console.log(`    ✗ 修复失败（已翻转 ${rep.flips.length} 格仍不可解）`);
          continue;
        }
        raw.layers = solutionToLayers(level.grid, rep.solution);
        raw.encoding = "layers";
        raw.meta = { ...(raw.meta ?? {}) };
        raw.meta.difficulty = rep.analysis.difficulty.level;
        raw.meta.audit = {
          verdict: rep.analysis.verdict,
          score: rep.analysis.difficulty.score,
          repairedCells: rep.flips.length,
        };
        writeFileSync(path, formatLevelJson(raw), "utf8");
        console.log(
          `    ✓ 已修复：翻转 ${rep.flips.length} 格 → 难度 ` +
            `${rep.analysis.difficulty.score.toFixed(2)}(${rep.analysis.difficulty.label})，已写回 ${file}`,
        );
        bad--;
      }
    }
  }

  console.log(`\n合计 ${files.length} 个，不合格 ${bad} 个`);
  if (bad > 0 && !fix) console.log("提示：加 --fix 可做最小改动自动修复");
  process.exitCode = bad > 0 ? 1 : 0;
}

/** 冒烟测试随机生成器：统计成功率、耗时与难度分布 */
function smokeTestGenerator(count) {
  console.log(`随机谜面生成冒烟测试 ×${count}\n`);
  const buckets = new Map();
  let fallback = 0;
  let repaired = 0;
  let totalMs = 0;
  let worstMs = 0;

  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    const p = generatePuzzle({ seed: 1000 + i });
    const ms = performance.now() - t0;
    totalMs += ms;
    worstMs = Math.max(worstMs, ms);

    if (p.fallback) fallback++;
    repaired += p.repaired;
    const label = `${p.analysis.difficulty.level} ${p.analysis.difficulty.label}`;
    buckets.set(label, (buckets.get(label) ?? 0) + 1);

    if (!p.analysis.ok) {
      console.log(`✗ seed=${p.seed} 生成出不合格谜面：${p.analysis.message}`);
      process.exitCode = 1;
    }

    if (i < 5) {
      console.log(
        `  seed=${p.seed} ${p.size.join("×")} 解 ${p.analysis.difficulty.metrics.solid} ` +
          `难度 ${p.analysis.difficulty.score.toFixed(2)}(${p.analysis.difficulty.label}) ` +
          `尝试 ${p.attempts} 修复 ${p.repaired} 格 ${ms.toFixed(0)}ms`,
      );
    }
  }

  console.log(`\n难度分布：`);
  for (const [k, v] of [...buckets.entries()].sort()) {
    console.log(`  ${k.padEnd(10)} ${"█".repeat(v)} ${v}`);
  }
  console.log(
    `\n兜底子长方体 ${fallback}/${count}，平均修复 ${(repaired / count).toFixed(1)} 格，` +
      `平均 ${(totalMs / count).toFixed(0)}ms，最慢 ${worstMs.toFixed(0)}ms`,
  );
}

/**
 * 冒烟测试修复算法：故意拿"纯随机噪声"造型当输入
 *
 * 噪声造型每条线都被切成很多段，是最坏的输入形态。实测中 3 个轴的提示
 * 对小网格是**高度过约束**的（N³ 个格子对应 3N² 条线），中等填充率的噪声
 * 反而大多可解；真正容易出歧义的是**极稀疏**和**极稠密**的造型，
 * 所以这里对填充率做 0.06~0.94 的扫描，覆盖到会卡住的区间。
 */
function smokeTestRepair(count) {
  console.log(`修复算法冒烟测试 ×${count}（6×6×6 纯噪声造型，填充率扫描）\n`);
  const grid = createGrid([6, 6, 6]);
  let needFix = 0;
  let ok = 0;
  let flips = 0;
  let totalMs = 0;
  let worstMs = 0;

  for (let i = 0; i < count; i++) {
    const rng = new Rng(`noise:${i}`);
    const density = 0.06 + (i % 12) * 0.08;
    const solution = new Uint8Array(grid.count);
    for (let c = 0; c < grid.count; c++) solution[c] = rng.chance(density) ? 1 : 0;

    const beforeAnalysis = analyzePuzzle(grid, solution, { countSolutionsOnStall: false });
    const dirty = !beforeAnalysis.ok;
    if (dirty) needFix++;

    const t0 = performance.now();
    const rep = repairSolution({
      grid,
      solution,
      rng,
      maxFlips: 40,
      sampleSize: 14,
      timeBudgetMs: 8000,
    });
    const ms = performance.now() - t0;
    totalMs += ms;
    worstMs = Math.max(worstMs, ms);

    if (rep.ok) {
      ok++;
      if (dirty) flips += rep.flips.length;
    }
    if (dirty) {
      console.log(
        `  密度 ${density.toFixed(2)} 未定 ${String(beforeAnalysis.propagation.unknown).padStart(3)} 格 → ` +
          `${rep.ok ? "✓" : "✗"} 翻转 ${String(rep.flips.length).padStart(2)} 格 ` +
          `难度 ${rep.analysis.difficulty.score.toFixed(2)}(${rep.analysis.difficulty.label}) ${ms.toFixed(0)}ms`,
      );
    }
  }

  console.log(
    `\n输入本身就不合格 ${needFix}/${count}；最终全部可解 ${ok}/${count}，` +
      `需修复样本平均翻转 ${needFix ? (flips / needFix).toFixed(1) : "-"} 格 ` +
      `(占 ${needFix ? ((flips / needFix / grid.count) * 100).toFixed(1) : "-"}% 格子)，` +
      `平均 ${(totalMs / count).toFixed(0)}ms，最慢 ${worstMs.toFixed(0)}ms`,
  );
  process.exitCode = ok === count ? 0 : 1;
}

/**
 * 关卡 JSON 序列化：只有"含对象的数组"才换行，纯量数组压成一行
 *
 * 关卡文件是**手写资产**，要能读、能 diff。直接 `JSON.stringify(x, null, 2)`
 * 会把 `size`、每一层字符画、`hiddenHints` 的数字列表全部竖着展开，
 * 一个 5³ 关卡能膨胀到 140 行，完全没法看。
 * 这里先把纯量数组换成占位符，格式化之后再替换回单行形式。
 */
function formatLevelJson(raw) {
  const inline = [];
  const wrap = (value) => {
    if (Array.isArray(value)) {
      const flat = value.every((v) => v === null || typeof v !== "object");
      if (flat) {
        inline.push(JSON.stringify(value));
        return `@@INLINE${inline.length - 1}@@`;
      }
      return value.map(wrap);
    }
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = wrap(v);
      return out;
    }
    return value;
  };

  const text = JSON.stringify(wrap(raw), null, 2);
  return `${text.replace(/"@@INLINE(\d+)@@"/g, (_, i) => inline[Number(i)])}\n`;
}

/** Uint8Array 造型 → layers 字符画（layers[y][z][x]） */
function solutionToLayers(grid, solution) {
  const layers = [];
  for (let y = 0; y < grid.H; y++) {
    const layer = [];
    for (let z = 0; z < grid.D; z++) {
      let row = "";
      for (let x = 0; x < grid.W; x++) {
        row += solution[indexOf(grid, x, y, z)] ? "#" : ".";
      }
      layer.push(row);
    }
    layers.push(layer);
  }
  return layers;
}
