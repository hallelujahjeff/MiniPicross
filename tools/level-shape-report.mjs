#!/usr/bin/env node
/**
 * 造型的"分段结构"体检（离线诊断，不写回任何文件）
 *
 * 回答一个具体问题：**为什么方框提示（≥3 段）几乎不出现？**
 * 方框是造型的性质，不是裁剪的性质——如果造型本身没有任何一条线被切成 3 段以上，
 * 那不管怎么裁剪都不可能出现方框。这个脚本按轴统计每条线的分段分布，
 * 顺带检查造型在 X / Z 上是否镜像对称（对称造型推理量减半，偏简单）。
 *
 *   node tools/level-shape-report.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseLevel } from "../src/level/LevelParser.js";
import { AXES, lineDims } from "../src/puzzle/HintModel.js";
import { lineOf, indexOf } from "../src/core/GridCoords.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const LEVEL_DIR = resolve(HERE, "../src/level/levels");
const AXIS_NAMES = ["X", "Y", "Z"];

const files = readdirSync(LEVEL_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

console.log("造型分段结构体检（方框提示 = 某条线被切成 ≥3 段）\n");

for (const file of files) {
  const id = file.replace(/\.json$/, "");
  let level;
  try {
    level = parseLevel(JSON.parse(readFileSync(join(LEVEL_DIR, file), "utf8")), id);
  } catch (err) {
    console.log(`✗ ${id}：${err.message}`);
    continue;
  }

  const { grid, solution } = level;
  /** 分段数 → 条数 */
  const dist = new Map();
  const perAxisSquare = [0, 0, 0];

  for (const axis of AXES) {
    const { uCount, vCount } = lineDims(grid, axis);
    for (let v = 0; v < vCount; v++) {
      for (let u = 0; u < uCount; u++) {
        const line = lineOf(grid, axis, u, v);
        let groups = 0;
        let prev = 0;
        for (let i = 0; i < line.length; i++) {
          const s = solution[line.start + i * line.step];
          if (s && !prev) groups++;
          prev = s;
        }
        dist.set(groups, (dist.get(groups) ?? 0) + 1);
        if (groups >= 3) perAxisSquare[axis]++;
      }
    }
  }

  // 镜像对称检测：X 与 Z 各测一次
  const mirrorX = isMirror(grid, solution, "x");
  const mirrorZ = isMirror(grid, solution, "z");

  const parts = [...dist.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([g, n]) => `${g}段×${n}`)
    .join(" ");
  const square = perAxisSquare.reduce((a, b) => a + b, 0);

  console.log(
    `${id.padEnd(15)} ${`${grid.W}×${grid.H}×${grid.D}`.padEnd(9)} ` +
      `方框 ${String(square).padStart(3)} ` +
      `(${AXIS_NAMES.map((n, i) => `${n}${perAxisSquare[i]}`).join("/")})  ` +
      `对称 ${mirrorX ? "X" : "-"}${mirrorZ ? "Z" : "-"}   ${parts}`,
  );
}

console.log(
  "\n对称列：X = 沿 X 轴镜像对称，Z = 沿 Z 轴镜像对称，- = 不对称（更有推理量）",
);

/** 造型是否沿某轴镜像对称 */
function isMirror(grid, solution, axis) {
  for (let z = 0; z < grid.D; z++) {
    for (let y = 0; y < grid.H; y++) {
      for (let x = 0; x < grid.W; x++) {
        const mirrored =
          axis === "x"
            ? indexOf(grid, grid.W - 1 - x, y, z)
            : indexOf(grid, x, y, grid.D - 1 - z);
        if (solution[indexOf(grid, x, y, z)] !== solution[mirrored]) return false;
      }
    }
  }
  return true;
}
