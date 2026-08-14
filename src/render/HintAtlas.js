import * as THREE from "three";
import { MARK_PLAIN, MARK_CIRCLE, MARK_SQUARE } from "../puzzle/HintModel.js";

/**
 * 提示数字的字形图集（运行时用 Canvas2D 生成，不需要任何外部资源）
 *
 * ## 为什么用图集而不是每个数字一张贴图 / 一个 Sprite
 * 一个 10³ 谜面最多有 6000 个提示贴花。如果每个贴花是独立 Mesh/Sprite，
 * 就是 6000 个 draw call；用**一张图集 + 一个 InstancedMesh + 每实例 UV 偏移**，
 * 全部提示只要 1 个 draw call。
 *
 * ## 布局
 * 图集是 COLS × ROWS 的等分格子，格子索引 = 数字 × 3 + 记号：
 *   数字 0..MAX_VALUE（0 表示"整条都要凿掉"，也要显示），记号 0=裸数字 / 1=圆圈 / 2=方框
 * 共 17 × 3 = 51 格，按 8 列 × 7 行排布，单格 128px → 1024 × 896。
 *
 * 图集只画**白色字形 + 透明背景**，真正的墨色在材质里 tint，
 * 这样想改墨色/做主题色不用重新生成图集。
 */

/** 支持的最大数字（= LevelSchema.MAX_AXIS） */
export const MAX_VALUE = 16;
/** 记号种类数 */
const MARK_COUNT = 3;
/** 单格像素 */
const CELL_PX = 128;
export const ATLAS_COLS = 8;
export const ATLAS_ROWS = Math.ceil(((MAX_VALUE + 1) * MARK_COUNT) / ATLAS_COLS);

/** @type {{texture: THREE.CanvasTexture, cols:number, rows:number}|null} */
let _atlas = null;

/** 格子索引（数字 + 记号 → 图集第几格） */
export function atlasCellIndex(value, mark) {
  const v = Math.min(MAX_VALUE, Math.max(0, value | 0));
  const m = mark === MARK_CIRCLE || mark === MARK_SQUARE ? mark : MARK_PLAIN;
  return v * MARK_COUNT + m;
}

/** 格子索引 → 图集内的 UV 原点（左下角） */
export function atlasCellUv(cellIndex, out = { u: 0, v: 0 }) {
  const col = cellIndex % ATLAS_COLS;
  const row = Math.floor(cellIndex / ATLAS_COLS);
  out.u = col / ATLAS_COLS;
  // Canvas 的 y 向下、纹理 UV 的 v 向上，这里做一次翻转
  out.v = 1 - (row + 1) / ATLAS_ROWS;
  return out;
}

/** 单格在 UV 空间的尺寸 */
export function atlasCellScale() {
  return { u: 1 / ATLAS_COLS, v: 1 / ATLAS_ROWS };
}

/** 惰性生成并缓存图集纹理 */
export function getHintAtlas(renderer) {
  if (_atlas) return _atlas;

  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_COLS * CELL_PX;
  canvas.height = ATLAS_ROWS * CELL_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("getHintAtlas: 无法获取 Canvas2D 上下文");

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#ffffff";
  ctx.lineJoin = "round";

  for (let value = 0; value <= MAX_VALUE; value++) {
    for (let mark = 0; mark < MARK_COUNT; mark++) {
      const cell = atlasCellIndex(value, mark);
      const ox = (cell % ATLAS_COLS) * CELL_PX;
      const oy = Math.floor(cell / ATLAS_COLS) * CELL_PX;
      drawGlyph(ctx, ox, oy, value, mark);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = "HintAtlas";
  texture.colorSpace = THREE.SRGBColorSpace;
  // 数字会被斜着看、也会被缩得很小，各向异性 + mipmap 是清晰度的关键
  texture.anisotropy = renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // 图集是拼格的，必须夹取，否则 mipmap 高层会串格
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;

  _atlas = { texture, cols: ATLAS_COLS, rows: ATLAS_ROWS };
  return _atlas;
}

/** 在图集某一格里画出「数字 + 记号」 */
function drawGlyph(ctx, ox, oy, value, mark) {
  const cx = ox + CELL_PX / 2;
  const cy = oy + CELL_PX / 2;
  const text = String(value);
  const twoDigit = text.length > 1;

  // 记号（圆圈 / 方框）先画，数字压在上面
  if (mark === MARK_CIRCLE) {
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(cx, cy, 47, 0, Math.PI * 2);
    ctx.stroke();
  } else if (mark === MARK_SQUARE) {
    ctx.lineWidth = 8;
    roundRect(ctx, cx - 45, cy - 45, 90, 90, 14);
    ctx.stroke();
  }

  // 有记号时数字要缩一点，避免顶到圈/框
  const base = mark === MARK_PLAIN ? 92 : 74;
  let size = twoDigit ? Math.round(base * 0.78) : base;
  // 0 出现频率高（每条全凿线都有一个），画小一点让它在视觉上退后，不抢造型
  if (value === 0) size = Math.round(size * 0.8);
  ctx.font = `700 ${size}px "Nunito", "Segoe UI", system-ui, sans-serif`;
  // 数字视觉重心略高于几何中心，下移一点更居中
  ctx.fillText(text, cx, cy + size * 0.04);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** 整体卸载时释放图集 */
export function disposeHintAtlas() {
  _atlas?.texture.dispose();
  _atlas = null;
}
