/**
 * 关卡模型缩略图离屏渲染
 *
 * 选关界面上，已完成的关卡要展示"最终模型的贴图"。这里用一个**独立的**
 * 离屏 WebGLRenderer（不挂到 DOM），把某关卡的造型按它的最终配色渲染成
 * 一张透明背景 PNG，交给选关卡片当贴纸。
 *
 * 为什么不复用主 renderer：
 *  - 主 renderer 渲染的是"关卡进行中"的场景（悬空方块 + 贴花 + 截面），
 *    而缩略图要的是"单独、干净、带最终配色"的造型。
 *  - 缩略图在选关界面就要显示，此时主场景根本没在渲染。
 * 独立 renderer + 独立 scene 最干净，且几何体/材质复用 BlockAssets 的共享资源，
 * 不额外占用显存。
 *
 * 光照刻意不走 IBL（envMap 生成太重），用方向光 + 半球光给出体积感即可；
 * 缩略图只有 ~256px，光照细节不重要，颜色准确 + 分得清三个面就够了。
 *
 * ## mesh 复用
 * 跨关卡共用一个 InstancedMesh：只更新 count 与矩阵/颜色数组 needsUpdate。
 * 三次都重建再 dispose 既慢又容易出错（BufferAttribute 没有 dispose()）。
 */

import * as THREE from "three";
import { CELL, coordsOf } from "../core/GridCoords.js";
import { getBlockGeometry, getBlockMaterial } from "./BlockAssets.js";

/** 缩略图输出边长（像素） */
const THUMB_SIZE = 256;
/** 透明背景 */
const CLEAR_ALPHA = 0;
/** 预分配的最大实例容量（足够覆盖内置所有关卡） */
const MAX_CAPACITY = 2000;

/** @type {THREE.WebGLRenderer|null} 进程内缓存的离屏 renderer */
let _renderer = null;
/** @type {THREE.Scene|null} */
let _scene = null;
/** @type {THREE.PerspectiveCamera|null} */
let _camera = null;
/** @type {THREE.InstancedMesh|null} 复用的 mesh，换关时只更新数据 */
let _mesh = null;
/** 复用对象，避免每帧分配 */
const _color = new THREE.Color();
const _matrix = new THREE.Matrix4();
const _pos = { x: 0, y: 0, z: 0 };
const _target = new THREE.Vector3();
const _dir = new THREE.Vector3();

function ensureContext() {
  if (_renderer) return true;
  try {
    _renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      // toDataURL 需要保留绘制缓冲
      preserveDrawingBuffer: true,
    });
    _renderer.setSize(THUMB_SIZE, THUMB_SIZE);
    _renderer.setClearColor(0x000000, CLEAR_ALPHA);
    _renderer.setPixelRatio(1);
    _renderer.outputColorSpace = THREE.SRGBColorSpace;

    _scene = new THREE.Scene();
    _camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);

    // 主光：右上前，勾出亮面
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(6, 8, 5);
    _scene.add(key);
    // 半球光：补足暗部，避免背面全黑
    _scene.add(new THREE.HemisphereLight(0xffffff, 0x454a52, 1.1));
  } catch {
    _renderer = null;
    return false;
  }
  return true;
}

/**
 * 渲染一关的最终造型，返回透明 PNG 的 dataURL
 *
 * @param {import("../level/LevelParser.js").LevelData} level
 * @returns {string|null} dataURL；WebGL 不可用时返回 null
 */
export function renderLevelThumbnail(level) {
  if (!ensureContext()) return null;

  const { grid, solution, palette, colorIndex } = level;
  const geometry = getBlockGeometry();
  const material = getBlockMaterial();

  let solidCount = 0;
  for (let i = 0; i < grid.count; i++) if (solution[i] === 1) solidCount++;

  // 跨关卡复用 mesh：首次创建，后续只更新 count + 数据
  if (!_mesh) {
    _mesh = new THREE.InstancedMesh(geometry, material, MAX_CAPACITY);
    _mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // setColorAt 前需要 instanceColor 存在
    _mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_CAPACITY * 3),
      3,
    );
    _mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    _scene.add(_mesh);
  }
  _mesh.count = solidCount;

  let slot = 0;
  for (let i = 0; i < grid.count; i++) {
    if (solution[i] !== 1) continue;
    coordsOf(grid, i, _pos);
    // 造型中心平移到原点，相机 fit 时就不用再算偏移
    _matrix.setPosition(
      (_pos.x - (grid.W - 1) / 2) * CELL,
      (_pos.y - (grid.H - 1) / 2) * CELL,
      (_pos.z - (grid.D - 1) / 2) * CELL,
    );
    _mesh.setMatrixAt(slot, _matrix);
    _mesh.setColorAt(slot, _color.set(palette[colorIndex[i]] ?? 0xffffff));
    slot++;
  }
  _mesh.instanceMatrix.needsUpdate = true;
  if (_mesh.instanceColor) _mesh.instanceColor.needsUpdate = true;

  // 3/4 等距视角，微微仰视看到顶面 + 两个侧面
  const radius = Math.hypot(grid.W, grid.H, grid.D) * CELL * 0.55 + 0.5;
  const dist = radius / Math.sin((32 * Math.PI) / 180 / 2);
  _dir.set(1, 0.78, 1).normalize().multiplyScalar(dist);
  _camera.position.copy(_dir);
  _camera.lookAt(_target.set(0, 0, 0));
  _camera.near = 0.1;
  _camera.far = dist + radius * 3;
  _camera.updateProjectionMatrix();

  _renderer.render(_scene, _camera);
  return _renderer.domElement.toDataURL("image/png");
}
