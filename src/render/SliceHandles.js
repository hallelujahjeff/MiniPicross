import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { AXIS_X, AXIS_Z, CELL } from "../core/GridCoords.js";
import { SLICE_AXES } from "../puzzle/SliceRange.js";

/**
 * 截面拖动条（3D 手柄）
 *
 * ## 交互形态
 * 沿 X 轴和 Z 轴各有一根导轨，每根导轨上有**两个滑块**（低端 / 高端）。
 * 拖动任一滑块就进入截面模式：对应轴的可见范围被收窄，
 * 平面另一侧的方块隐藏，露出内部构造。两个滑块可以夹成一层薄片，
 * 这是查看内部最有效的姿势。
 *
 * ## 导轨会跟着相机换边
 * 导轨固定在长方体底部的某条棱上。如果写死在"前边"，玩家把视角转到背面后
 * 手柄就被造型挡住了。因此每帧根据相机所在象限，把 X 导轨放到 z 的近侧、
 * Z 导轨放到 x 的近侧——手柄永远在离相机最近的两条底棱上。
 * 换边带来的跳变会破坏拖动，所以**拖动过程中冻结换边**。
 *
 * ## 坐标映射
 * 世界坐标与格坐标的换算（N = 该轴格数）：
 *   低端滑块在 lo 时，世界坐标 = lo - N/2      （它站在 lo 这一层的外侧面上）
 *   高端滑块在 hi 时，世界坐标 = hi - N/2 + 1
 * 反解就得到"指针落点 → 目标层号"。
 */

/** 导轨离造型表面的距离：够近才读得出"这是这个长方体的标尺" */
const RAIL_GAP = 0.48;
/** 导轨半径 */
const RAIL_RADIUS = 0.05;
/** 滑块边长 */
const KNOB_SIZE = 0.42;

const COLOR_RAIL = 0x6f7681;
const COLOR_KNOB = 0x4a9eff;
const COLOR_KNOB_HOT = 0x9ed0ff;
const COLOR_PLANE = 0x4a9eff;
const COLOR_OUTLINE = 0x6f8bb0;

/** 相机换边的滞回阈值，避免在 z≈0 时反复抖动 */
const FLIP_HYSTERESIS = 0.45;

export class SliceHandles {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = "SliceHandles";
    this.group.renderOrder = 3;

    /** @type {import("../puzzle/SliceRange.js").SliceRange|null} */
    this.slice = null;
    this.grid = null;

    /** @type {Map<number, THREE.Mesh>} axis → 导轨 */
    this.rails = new Map();
    /** @type {THREE.Mesh[]} 可拾取的滑块 */
    this.knobs = [];
    /** @type {Map<string, THREE.Mesh>} `${axis}:${side}` → 剖切面 */
    this.planes = new Map();
    /** @type {THREE.LineSegments|null} 完整体积的轮廓线（截面模式下显示） */
    this.outline = null;

    /** axis → 当前导轨所在的另一轴符号（+1 / -1） */
    this._railSide = new Map();

    /** @type {THREE.Mesh|null} */
    this.hovered = null;
    /** @type {THREE.Mesh|null} */
    this.dragging = null;

    this._geometries = [];
    this._materials = [];

    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._closest = new THREE.Vector3();
  }

  /**
   * 为一个关卡重建手柄
   * @param {import("../core/GridCoords.js").Grid} grid
   * @param {import("../puzzle/SliceRange.js").SliceRange} slice
   */
  build(grid, slice) {
    this.dispose();
    this.grid = grid;
    this.slice = slice;

    const knobGeo = new RoundedBoxGeometry(KNOB_SIZE, KNOB_SIZE, KNOB_SIZE, 1, 0.09);
    this._geometries.push(knobGeo);

    for (const axis of SLICE_AXES) {
      const n = axis === AXIS_X ? grid.W : grid.D;

      // 导轨：默认沿 Y 的圆柱，旋转到目标轴
      const railGeo = new THREE.CylinderGeometry(
        RAIL_RADIUS,
        RAIL_RADIUS,
        n * CELL,
        8,
        1,
      );
      this._geometries.push(railGeo);
      const railMat = new THREE.MeshStandardMaterial({
        color: COLOR_RAIL,
        roughness: 0.5,
        metalness: 0.15,
      });
      this._materials.push(railMat);
      const rail = new THREE.Mesh(railGeo, railMat);
      rail.name = `SliceRail_${axis === AXIS_X ? "X" : "Z"}`;
      if (axis === AXIS_X) rail.rotation.z = Math.PI / 2;
      else rail.rotation.x = Math.PI / 2;
      this.rails.set(axis, rail);
      this.group.add(rail);
      this._railSide.set(axis, 1);

      for (const side of [0, 1]) {
        const knobMat = new THREE.MeshStandardMaterial({
          color: COLOR_KNOB,
          roughness: 0.35,
          metalness: 0.1,
          emissive: new THREE.Color(COLOR_KNOB).multiplyScalar(0.18),
        });
        this._materials.push(knobMat);
        const knob = new THREE.Mesh(knobGeo, knobMat);
        knob.name = `SliceKnob_${axis === AXIS_X ? "X" : "Z"}_${side === 0 ? "lo" : "hi"}`;
        knob.userData.axis = axis;
        knob.userData.side = side;
        knob.userData.isSliceKnob = true;
        knob.castShadow = false;
        this.knobs.push(knob);
        this.group.add(knob);

        // 剖切面：只在该端被收窄时显示
        const planeGeo = new THREE.PlaneGeometry(1, 1);
        this._geometries.push(planeGeo);
        const planeMat = new THREE.MeshBasicMaterial({
          color: COLOR_PLANE,
          transparent: true,
          opacity: 0.085,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        this._materials.push(planeMat);
        const plane = new THREE.Mesh(planeGeo, planeMat);
        plane.name = `SlicePlane_${axis}_${side}`;
        plane.visible = false;
        plane.renderOrder = 3;
        if (axis === AXIS_X) plane.rotation.y = Math.PI / 2;
        this.planes.set(`${axis}:${side}`, plane);
        this.group.add(plane);
      }
    }

    // 完整体积轮廓：截面模式下提示"原本有多大"
    const boxGeo = new THREE.BoxGeometry(grid.W * CELL, grid.H * CELL, grid.D * CELL);
    const edges = new THREE.EdgesGeometry(boxGeo);
    boxGeo.dispose();
    this._geometries.push(edges);
    const outlineMat = new THREE.LineBasicMaterial({
      color: COLOR_OUTLINE,
      transparent: true,
      opacity: 0.32,
    });
    this._materials.push(outlineMat);
    this.outline = new THREE.LineSegments(edges, outlineMat);
    this.outline.name = "SliceOutline";
    this.outline.visible = false;
    this.group.add(this.outline);

    this.syncFromSlice();
    return this.group;
  }

  /**
   * 可被指针拾取的对象
   *
   * 只返回**当前显示中**的滑块。这一点很重要：进入某个轴的截面模式后，
   * 另一个轴的拖动条会被隐藏，此时它绝不能还能被点到——
   * 否则玩家会拖动一个看不见的东西却毫无反应。
   */
  get interactiveObjects() {
    return this.knobs.filter((k) => k.visible);
  }

  /** 手柄的整体显隐（例如换关过场时隐藏） */
  setVisible(flag) {
    this.group.visible = flag;
  }

  /**
   * 按当前 SliceRange 更新滑块位置、剖切面与轮廓
   * 每次范围变化后调用即可（不需要每帧调）。
   */
  syncFromSlice() {
    if (!this.slice || !this.grid) return;
    const grid = this.grid;
    // 同一时刻只允许切一个轴：另一个轴的导轨与滑块整组隐藏
    const activeAxis = this.slice.activeAxis;

    for (const [axis, rail] of this.rails) {
      rail.visible = activeAxis < 0 || activeAxis === axis;
    }

    for (const knob of this.knobs) {
      const { axis, side } = knob.userData;
      const usable = activeAxis < 0 || activeAxis === axis;
      knob.visible = usable;

      const n = axis === AXIS_X ? grid.W : grid.D;
      const along = this._boundToWorld(axis, side);

      const yBase = -(grid.H * CELL) / 2 - RAIL_GAP;
      if (axis === AXIS_X) {
        const zSide = this._railSide.get(AXIS_X);
        knob.position.set(along, yBase, zSide * ((grid.D * CELL) / 2 + RAIL_GAP));
      } else {
        const xSide = this._railSide.get(AXIS_Z);
        knob.position.set(xSide * ((grid.W * CELL) / 2 + RAIL_GAP), yBase, along);
      }

      // 剖切面
      const plane = this.planes.get(`${axis}:${side}`);
      const atEdge =
        side === 0 ? this.slice.getBound(axis, 0) === 0 : this.slice.getBound(axis, 1) === n - 1;
      plane.visible = usable && !atEdge;
      if (plane.visible) {
        if (axis === AXIS_X) {
          plane.position.set(along, 0, 0);
          plane.scale.set(grid.D * CELL, grid.H * CELL, 1);
        } else {
          plane.position.set(0, 0, along);
          plane.scale.set(grid.W * CELL, grid.H * CELL, 1);
        }
      }
    }

    if (this.outline) this.outline.visible = this.slice.active;
  }

  /**
   * 每帧调用：把导轨挪到离相机最近的底棱，并处理滑块高亮
   * @param {THREE.Camera} camera
   */
  update(camera) {
    if (!this.grid || !this.slice) return;
    const grid = this.grid;
    const yBase = -(grid.H * CELL) / 2 - RAIL_GAP;

    let flipped = false;
    if (!this.dragging) {
      // 拖动中冻结换边，否则导轨一跳，拖动映射也跟着跳
      flipped = this._updateRailSide(AXIS_X, camera.position.z) || flipped;
      flipped = this._updateRailSide(AXIS_Z, camera.position.x) || flipped;
    }

    const railX = this.rails.get(AXIS_X);
    if (railX) {
      railX.position.set(
        0,
        yBase,
        this._railSide.get(AXIS_X) * ((grid.D * CELL) / 2 + RAIL_GAP),
      );
    }
    const railZ = this.rails.get(AXIS_Z);
    if (railZ) {
      railZ.position.set(
        this._railSide.get(AXIS_Z) * ((grid.W * CELL) / 2 + RAIL_GAP),
        yBase,
        0,
      );
    }

    if (flipped) this.syncFromSlice();
  }

  /** 设置悬停的滑块（-> 提亮 + 放大一点，给出"可以拖"的暗示） */
  setHover(object) {
    const next = object && object.userData?.isSliceKnob ? object : null;
    if (next === this.hovered) return false;
    if (this.hovered) this._applyKnobStyle(this.hovered, false);
    this.hovered = next;
    if (next) this._applyKnobStyle(next, true);
    return true;
  }

  /** 标记正在拖动的滑块 */
  setDragging(object) {
    this.dragging = object ?? null;
    for (const knob of this.knobs) {
      this._applyKnobStyle(knob, knob === this.dragging || knob === this.hovered);
    }
  }

  /**
   * 把指针射线换算成该滑块对应的目标层号
   * @param {THREE.Mesh} knob
   * @param {THREE.Ray} ray
   * @returns {number|null}
   */
  valueFromRay(knob, ray) {
    if (!this.grid || !knob?.userData?.isSliceKnob) return null;
    const { axis, side } = knob.userData;
    const rail = this.rails.get(axis);
    if (!rail) return null;

    const grid = this.grid;
    const n = axis === AXIS_X ? grid.W : grid.D;
    const halfLen = (n * CELL) / 2;

    // 导轨线段（世界空间）
    this._a.copy(rail.position);
    this._b.copy(rail.position);
    if (axis === AXIS_X) {
      this._a.x -= halfLen;
      this._b.x += halfLen;
    } else {
      this._a.z -= halfLen;
      this._b.z += halfLen;
    }

    ray.distanceSqToSegment(this._a, this._b, null, this._closest);
    const along = axis === AXIS_X ? this._closest.x : this._closest.z;

    // _boundToWorld 的反函数
    const raw = along / CELL + n / 2 - (side === 0 ? 0 : 1);
    return Math.round(raw);
  }

  /** 释放本关资源 */
  dispose() {
    this.group.clear();
    for (const g of this._geometries) g.dispose();
    for (const m of this._materials) m.dispose();
    this._geometries = [];
    this._materials = [];
    this.rails.clear();
    this.planes.clear();
    this.knobs = [];
    this.outline = null;
    this.hovered = null;
    this.dragging = null;
    this.grid = null;
    this.slice = null;
  }

  /** 层号 → 沿轴的世界坐标 */
  _boundToWorld(axis, side) {
    const n = axis === AXIS_X ? this.grid.W : this.grid.D;
    const v = this.slice.getBound(axis, side);
    return (side === 0 ? v - n / 2 : v - n / 2 + 1) * CELL;
  }

  /** 根据相机位置决定导轨放在哪一侧，返回是否发生了换边 */
  _updateRailSide(axis, cameraCoord) {
    const current = this._railSide.get(axis) ?? 1;
    const want = cameraCoord >= 0 ? 1 : -1;
    if (want === current) return false;
    if (Math.abs(cameraCoord) < FLIP_HYSTERESIS) return false;
    this._railSide.set(axis, want);
    return true;
  }

  _applyKnobStyle(knob, hot) {
    knob.material.color.set(hot ? COLOR_KNOB_HOT : COLOR_KNOB);
    knob.material.emissive.set(hot ? COLOR_KNOB_HOT : COLOR_KNOB);
    knob.material.emissive.multiplyScalar(hot ? 0.4 : 0.18);
    knob.scale.setScalar(hot ? 1.22 : 1);
  }
}
