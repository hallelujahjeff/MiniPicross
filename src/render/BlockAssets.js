import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { CELL } from "../core/GridCoords.js";

/**
 * 方块的共享 GPU 资源（几何体 + 材质）
 *
 * 全场所有方块共用**一份**几何体与**一份**材质，这是"1 个 draw call
 * 画上千方块"的前提。资源常驻缓存，切换关卡时不销毁（见 PuzzleRenderer.dispose）。
 *
 * 视觉基调：乳白象牙色、亚光（高 roughness、零 metalness）、边缘圆润倒角。
 *
 * 注意材质本色刻意留成**纯白**，象牙色放进"默认实例色"里。
 * 因为最终画面颜色 = 材质色 × 实例色，只有材质是白的，
 * 造型完成后把实例色设成关卡配色时才能得到**准确**的颜色，
 * 而不是被象牙色染过一遍的偏色。
 */

/** 圆角细分档位：1 → 每面 3×3 格 = 108 三角/方块（10³ = 10.8 万三角） */
export const SEGMENTS = 1;
/** 倒角半径（相对 CELL），略小以保留体素方正感，同时形成 hairline 缝隙 */
export const RADIUS = 0.085;

/** 材质本色：纯白，真正的着色交给实例色 */
export const COLOR_BASE = 0xffffff;
/** 亚光：高粗糙度、无金属感 */
export const ROUGHNESS = 0.82;
export const METALNESS = 0.0;
/** 环境光贴图强度（配合 SceneEnvironment 的柔和 IBL） */
export const ENV_INTENSITY = 0.55;

/**
 * 未完成方块的实例色：略沉一档的石膏象牙白
 *
 * 刻意比"接近白"的关卡配色（瓷白杯身、蘑菇菌柄、小屋墙面）**暗一档**。
 * 否则那些偏白的最终配色和未处理方块几乎一样，玩家看不出哪些已经锁定，
 * 会反复去点已经确认的方块。压暗之后，任何配色上身都会明显"亮起来"。
 */
export const INSTANCE_COLOR_DEFAULT = 0xded8cb;
/**
 * 涂色标记：饱和度明显的橙琥珀
 *
 * 刻意选了一个**没有关卡会用作造型主色**的色相：
 * 标记（临时结论）必须一眼就和"已确认上色"（最终配色）区分开，
 * 否则玩家分不清哪些是自己猜的、哪些是已经锁定的。
 * 早期用过更淡的 #ffd7a3，结果和小屋的墙色几乎一样，读不出来。
 */
export const INSTANCE_COLOR_PAINTED = 0xf0a94b;
/** 鼠标悬停时的提亮倍率（实例色是乘性的，允许 > 1） */
export const HOVER_GAIN = 1.2;
/** 敲错时的闪红色 */
export const INSTANCE_COLOR_MISTAKE = 0xff4a3d;
/** 敲到被标记保护的方块时的提示色（冷调，区别于失误） */
export const INSTANCE_COLOR_BLOCKED = 0xa9d4ff;
/** 整行完成时扫过的高光色 */
export const INSTANCE_COLOR_CONFIRM = 0xffffff;

/** 碎片尺寸：正好把一个方块切成 2×2×2 八块，出生瞬间与原方块严丝合缝 */
export const SHARD_SCALE = 0.5;

let _geometry = null;
let _material = null;
let _shardGeometry = null;

/** 惰性创建并缓存共享圆角方块几何体 */
export function getBlockGeometry() {
  if (!_geometry) {
    _geometry = new RoundedBoxGeometry(CELL, CELL, CELL, SEGMENTS, RADIUS);
    _geometry.name = "BlockRoundedBox";
  }
  return _geometry;
}

/** 惰性创建并缓存共享乳白亚光材质 */
export function getBlockMaterial() {
  if (!_material) {
    _material = new THREE.MeshStandardMaterial({
      color: COLOR_BASE,
      roughness: ROUGHNESS,
      metalness: METALNESS,
      envMapIntensity: ENV_INTENSITY,
    });
    _material.name = "BlockIvoryMatte";
  }
  return _material;
}

/** 每个方块的三角面数（用于 HUD 统计） */
export function getTrianglesPerBlock() {
  const geo = getBlockGeometry();
  const pos = geo.getAttribute("position");
  return (geo.index ? geo.index.count : pos.count) / 3;
}

/**
 * 碎片几何体：边长为方块一半的圆角小方块
 *
 * 碎裂特效把一个方块换成 2×2×2 八个碎片，出生位置正是八个子立方体的中心，
 * 所以第一帧看起来与原方块完全重合，"碎开"的过程没有任何突兀的跳变。
 * 圆角半径按比例缩小，保证碎片与方块的材质表现一致。
 */
export function getShardGeometry() {
  if (!_shardGeometry) {
    _shardGeometry = new RoundedBoxGeometry(
      CELL * SHARD_SCALE,
      CELL * SHARD_SCALE,
      CELL * SHARD_SCALE,
      SEGMENTS,
      RADIUS * SHARD_SCALE,
    );
    _shardGeometry.name = "BlockShard";
  }
  return _shardGeometry;
}

/** 整体卸载（仅在销毁整个应用时调用） */
export function disposeAssets() {
  _geometry?.dispose();
  _material?.dispose();
  _shardGeometry?.dispose();
  _geometry = null;
  _material = null;
  _shardGeometry = null;
}
