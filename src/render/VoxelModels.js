/**
 * 首页体素模型数据（纯数据，不依赖 three）
 *
 * 一个模型可以用两种方式描述造型，二者取其一：
 *
 *  1. `layers` 字符画 —— 与关卡模板同格式（`layers[y][z][x]`，y 自下而上）：
 *       '.' / ' '  空
 *       '#'        palette[0]（主色）
 *       '2'..'9'   palette[1..8]（强调色）
 *     适合小而扁的造型（兔子这种一眼能画准的）。
 *
 *  2. `build(add)` 程序化构造 —— 回调里用 `add(x, y, z, colorIndex)` 逐个放方块。
 *     飞机、地球仪这类需要"球壳 / 圆柱 / 锥体 / 渐缩"的造型，手写 13×13 的
 *     字符画几乎必错，用距离公式反而又短又准，且改尺寸只需动一个常量。
 *
 * 造型都刻意做到"轮廓一眼可辨"，因为碎裂重组动画的看点就是
 * 玩家能立刻认出"它变成了一架飞机 / 一个地球仪"。
 */

/**
 * @typedef {Object} VoxelModel
 * @property {string} id
 * @property {string} name
 * @property {[number,number,number]} size [W, H, D]
 * @property {string[]} palette 颜色表，`#rrggbb`
 * @property {string[][]} [layers] 字符画（与 build 二选一）
 * @property {(add:(x:number,y:number,z:number,c:number)=>void)=>void} [build] 程序化构造
 */

/** 距离（用于球/圆柱判定） */
const dist3 = (x, y, z, cx, cy, cz) => Math.hypot(x - cx, y - cy, z - cz);
const dist2 = (a, b, ca, cb) => Math.hypot(a - ca, b - cb);

/** 首页展示的 5 个模型（第 1 个是初始展示的兔子） */
export const LANDING_MODELS = [
  /* ---------------- 1. 兔子（手绘字符画） ---------------- */
  {
    id: "rabbit",
    name: "兔子",
    size: [7, 9, 5],
    palette: ["#f4ede2", "#f0a9c0", "#3b3429"],
    layers: [
      [".......", "..###..", "..###..", ".......", "......."],
      [".......", ".#####.", ".#####.", ".#####.", "......."],
      [".......", ".#####.", ".#####.", ".#####.", "......."],
      [".......", "..###..", ".#####.", "..###..", "......."],
      [".......", "..###..", ".#####.", "..###..", "......."],
      [".......", "..###..", ".#3#3#.", "..###..", "......."],
      [".......", "..#.#..", "..#.#..", ".......", "......."],
      [".......", "..2.2..", "..2.2..", ".......", "......."],
      [".......", "..2.2..", "..2.2..", ".......", "......."],
    ],
  },

  /* ---------------- 2. 飞机 ---------------- */
  {
    id: "airplane",
    name: "飞机",
    size: [15, 7, 15],
    palette: ["#dfe7f2", "#63d7e8", "#e5484d", "#8a93a8"],
    build(add) {
      const cx = 7; // 机身中线（X）
      const yb = 3; // 机身所在层（Y）

      // 机身：沿 Z 从尾 z=1 到机头 z=13，中段粗、两端渐缩
      for (let z = 1; z <= 13; z++) {
        // 半宽：机头/机尾收窄成 0（单格），中段 1（3 格宽）
        const half = z >= 3 && z <= 11 ? 1 : 0;
        for (let x = cx - half; x <= cx + half; x++) {
          add(x, yb, z, 0);
          // 机身上半层：只在中段有，形成"背脊"
          if (z >= 3 && z <= 11) add(x, yb + 1, z, 0);
        }
      }
      // 舷窗：机身两侧一排青色
      for (let z = 5; z <= 10; z += 2) {
        add(cx - 1, yb + 1, z, 1);
        add(cx + 1, yb + 1, z, 1);
      }

      // 主翼：全展 15 格，翼根宽、翼尖窄（后掠感）
      // 翼弦（沿 Z 的宽度）刻意做到 3~5 格：只有 1 格的机翼在体素风格下
      // 从斜上方看几乎是一条线，认不出"翅膀"。
      for (let x = 0; x <= 14; x++) {
        const d = Math.abs(x - cx); // 离机身多远
        if (d <= 1) continue; // 机身处已由机身占据
        const zc = 7 - Math.round(d * 0.45); // 越靠翼尖越往机尾偏（后掠）
        const half = d >= 6 ? 1 : 2; // 翼根 5 格弦长，翼尖收到 3 格
        for (let z = zc - half; z <= zc + half; z++) add(x, yb, z, 0);
      }
      // 翼尖小翼（竖起，红色）
      [0, 14].forEach((x) => {
        add(x, yb + 1, 7 - 3, 2);
        add(x, yb + 1, 7 - 2, 2);
      });

      // 发动机吊舱：左右各一，挂在机翼下方
      [cx - 4, cx + 4].forEach((x) => {
        for (let z = 6; z <= 9; z++) add(x, yb - 1, z, 3);
      });

      // 尾翼（水平）
      for (let x = cx - 4; x <= cx + 4; x++) {
        if (Math.abs(x - cx) <= 1) continue;
        add(x, yb, 2, 0);
        add(x, yb, 3, 0);
      }
      // 垂尾（竖直，红色）
      for (let y = yb + 2; y <= yb + 3; y++) {
        add(cx, y, 1, 2);
        add(cx, y, 2, 2);
      }
    },
  },

  /* ---------------- 3. 地球仪 ---------------- */
  {
    id: "globe",
    name: "地球仪",
    size: [11, 14, 11],
    palette: ["#3f7fd0", "#4cb46a", "#c9a227", "#f2f6ff"],
    build(add) {
      const cx = 5;
      const cz = 5;
      const cy = 8.5; // 球心高度
      const R = 4.7;
      const INNER = 3.5; // 只留球壳：内部方块从外面根本看不见，白占实例

      // 大陆：4 块"陆地"用球面上的若干中心点表示，落在附近的壳格子染成绿色
      const LAND = [
        [0.82, 0.28, 0.5],
        [-0.6, 0.45, -0.66],
        [0.2, -0.72, 0.66],
        [-0.55, -0.25, 0.8],
      ].map(([dx, dy, dz]) => {
        const len = Math.hypot(dx, dy, dz);
        return [cx + (dx / len) * R, cy + (dy / len) * R, cz + (dz / len) * R];
      });

      for (let y = 0; y < 14; y++) {
        for (let z = 0; z < 11; z++) {
          for (let x = 0; x < 11; x++) {
            const d = dist3(x, y, z, cx, cy, cz);
            if (d > R || d < INNER) continue;
            // 极点附近留白，读起来更像"地轴穿过去"
            const isLand = LAND.some(([lx, ly, lz]) => dist3(x, y, z, lx, ly, lz) < 2.7);
            add(x, y, z, isLand ? 1 : 0);
          }
        }
      }

      // 地轴 + 底座（金色）
      for (let y = 1; y <= 3; y++) add(cx, y, cz, 2);
      for (let z = cz - 1; z <= cz + 1; z++) {
        for (let x = cx - 1; x <= cx + 1; x++) add(x, 0, z, 2);
      }
      // 北极标记（白）
      add(cx, 13, cz, 3);
    },
  },

  /* ---------------- 4. 火箭 ---------------- */
  {
    id: "rocket",
    name: "火箭",
    size: [9, 17, 9],
    palette: ["#eef2f8", "#e5484d", "#63d7e8", "#ff9f43", "#ffd447"],
    build(add) {
      const cx = 4;
      const cz = 4;

      // 箭体：半径 2.2 的圆柱，y 4..11
      for (let y = 4; y <= 11; y++) {
        for (let z = 0; z < 9; z++) {
          for (let x = 0; x < 9; x++) {
            if (dist2(x, z, cx, cz) > 2.2) continue;
            // 红色环带：两道，作为"涂装"
            const band = y === 6 || y === 10;
            add(x, y, z, band ? 1 : 0);
          }
        }
      }
      // 舷窗（青，朝 +Z 面）
      add(cx, 8, cz + 2, 2);
      add(cx - 1, 8, cz + 2, 2);
      add(cx + 1, 8, cz + 2, 2);

      // 头锥：y 12..15，半径线性收缩到 0
      for (let y = 12; y <= 15; y++) {
        const r = 2.2 - (y - 11) * 0.55;
        for (let z = 0; z < 9; z++) {
          for (let x = 0; x < 9; x++) {
            if (dist2(x, z, cx, cz) > r) continue;
            add(x, y, z, 1);
          }
        }
      }
      add(cx, 16, cz, 1); // 顶尖

      // 四片尾翼：沿 ±X / ±Z 伸出，从 y=4 向下渐宽
      for (let y = 2; y <= 5; y++) {
        const reach = 4 - (y - 2); // 越靠下伸得越远
        for (let k = 3; k <= reach + 2; k++) {
          if (k > 4) continue;
          add(cx + k, y, cz, 1);
          add(cx - k, y, cz, 1);
          add(cx, y, cz + k, 1);
          add(cx, y, cz - k, 1);
        }
      }

      // 尾焰：y 0..3 渐缩，外橙内黄
      for (let y = 0; y <= 3; y++) {
        const r = 2.0 - (3 - y) * 0.45;
        for (let z = 0; z < 9; z++) {
          for (let x = 0; x < 9; x++) {
            const d = dist2(x, z, cx, cz);
            if (d > r) continue;
            add(x, y, z, d < r * 0.5 ? 4 : 3);
          }
        }
      }
    },
  },

  /* ---------------- 5. 城堡 ---------------- */
  {
    id: "castle",
    name: "城堡",
    size: [13, 14, 13],
    palette: ["#cfc6b4", "#c1543f", "#8f8677", "#63d7e8"],
    build(add) {
      const N = 13;
      /** 是否落在方环的边上 */
      const onRing = (x, z, lo, hi) =>
        (x === lo || x === hi || z === lo || z === hi) &&
        x >= lo && x <= hi && z >= lo && z <= hi;

      // 城墙：外圈方环，只有 3 层高 + 垛口。
      // 刻意压矮：早先做 5 层时，城墙把角塔和主楼全遮住了，整体读起来像一个盒子；
      // 矮墙才能让"塔 / 主楼 / 墙"三个高度层次在剪影上分开。
      for (let y = 0; y <= 2; y++) {
        for (let z = 1; z < N - 1; z++) {
          for (let x = 1; x < N - 1; x++) {
            if (!onRing(x, z, 1, N - 2)) continue;
            // 正面（z = N-2）中间 3 格留空当城门
            if (z === N - 2 && x >= 5 && x <= 7) continue;
            add(x, y, z, 0);
          }
        }
      }
      // 城墙垛口：沿外圈隔一格加一块（灰色，和墙体分色）
      for (let z = 1; z < N - 1; z++) {
        for (let x = 1; x < N - 1; x++) {
          if (!onRing(x, z, 1, N - 2)) continue;
          if ((x + z) % 2 === 0) add(x, 3, z, 2);
        }
      }

      // 四座角塔：细圆柱（半径 1.2 → 5 格十字截面）+ 锥顶，高过城墙一大截
      const towers = [
        [1, 1],
        [1, N - 2],
        [N - 2, 1],
        [N - 2, N - 2],
      ];
      towers.forEach(([tx, tz]) => {
        for (let y = 0; y <= 8; y++) {
          for (let z = tz - 1; z <= tz + 1; z++) {
            for (let x = tx - 1; x <= tx + 1; x++) {
              if (dist2(x, z, tx, tz) > 1.2) continue;
              add(x, y, z, 0);
            }
          }
        }
        // 锥顶（红瓦）：先出檐一圈，再收成尖
        for (let z = tz - 1; z <= tz + 1; z++) {
          for (let x = tx - 1; x <= tx + 1; x++) {
            if (dist2(x, z, tx, tz) > 1.5) continue;
            add(x, 9, z, 1);
          }
        }
        add(tx, 10, tz, 1);
        add(tx, 11, tz, 3); // 塔尖旗标（青色，点睛）
      });

      // 主楼：中央塔身，明显高过角塔，构成剪影的最高点
      const mx = 6;
      const mz = 6;
      for (let y = 0; y <= 10; y++) {
        for (let z = mz - 2; z <= mz + 2; z++) {
          for (let x = mx - 2; x <= mx + 2; x++) {
            if (dist2(x, z, mx, mz) > 2.0) continue;
            add(x, y, z, 0);
          }
        }
      }
      // 主楼锥顶（红瓦，三层收尖）
      for (let z = mz - 2; z <= mz + 2; z++) {
        for (let x = mx - 2; x <= mx + 2; x++) {
          if (dist2(x, z, mx, mz) > 2.4) continue;
          add(x, 11, z, 1);
        }
      }
      for (let z = mz - 1; z <= mz + 1; z++) {
        for (let x = mx - 1; x <= mx + 1; x++) {
          if (dist2(x, z, mx, mz) > 1.2) continue;
          add(x, 12, z, 1);
        }
      }
      add(mx, 13, mz, 3);
    },
  },
];

/**
 * 解析一个模型的造型，返回体素数组 `[{x,y,z,c}]`（c = palette 索引）
 *
 * 同时兼容 `layers` 字符画与 `build(add)` 程序化构造；`build` 里重复
 * `add` 同一格是允许的（后写覆盖先写），因为组合造型时经常出现重叠，
 * 这里用一张 Map 去重，保证一个格子只产出一个方块。
 *
 * @param {VoxelModel} model
 * @returns {{x:number,y:number,z:number,c:number}[]}
 */
export function parseVoxels(model) {
  const [W, H, D] = model.size;
  /** @type {Map<number, {x:number,y:number,z:number,c:number}>} */
  const cells = new Map();
  const key = (x, y, z) => (y * D + z) * W + x;

  const add = (x, y, z, c) => {
    if (x < 0 || y < 0 || z < 0 || x >= W || y >= H || z >= D) return;
    cells.set(key(x, y, z), { x, y, z, c: Math.max(0, Math.min(8, c | 0)) });
  };

  if (typeof model.build === "function") {
    model.build(add);
  } else if (model.layers) {
    for (let y = 0; y < H; y++) {
      const rows = model.layers[y];
      if (!rows) continue;
      for (let z = 0; z < D; z++) {
        const row = rows[z];
        if (!row) continue;
        for (let x = 0; x < W; x++) {
          const ch = row[x];
          if (!ch || ch === "." || ch === " ") continue;
          add(x, y, z, ch === "#" ? 0 : ch.charCodeAt(0) - 48 - 1);
        }
      }
    }
  }

  return [...cells.values()];
}
