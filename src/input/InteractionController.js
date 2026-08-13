import * as THREE from "three";
import { raycastVoxels } from "../core/VoxelRaycast.js";

/**
 * 指针交互总控
 *
 * 一个左键承担三件事，靠"命中什么 + 有没有按修饰键"分流：
 *   1. 命中截面滑块          → 拖动，进入/调整截面模式
 *   2. 命中方块              → 敲除
 *   3. 命中方块 + Ctrl/⌘     → 标记（涂色）开关
 * 右键始终留给 OrbitControls 转视角，因此不存在"想转视角却敲掉方块"的误触。
 *
 * ## 点击与拖拽的区分
 * 按下时记下命中的方块与屏幕坐标；抬起时若位移超过 CLICK_SLOP 像素，
 * 或者指针已经不在同一个方块上，则视为拖拽/取消，不执行任何操作。
 * 这条规则让"按下后发现敲错了，拖开再松手"成为一个可用的撤销手段。
 *
 * ## 拾取走体素步进，不走 three 的实例拾取
 * 见 core/VoxelRaycast.js：几十步整数运算 vs 十万级三角求交，
 * 这是"鼠标移动时实时高亮"能常驻 60fps 的前提。
 */

/** 点击容差（像素）：超过就当作拖拽 */
const CLICK_SLOP = 6;

export class InteractionController {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.domElement
   * @param {THREE.Camera} options.camera
   * @param {import("../render/PuzzleRenderer.js").PuzzleRenderer} options.puzzleRenderer
   * @param {import("../render/SliceHandles.js").SliceHandles} options.sliceHandles
   * @param {() => import("../puzzle/SliceRange.js").SliceRange|null} options.getSlice
   * @param {(block:number) => void} options.onChisel
   * @param {(block:number) => void} options.onPaint
   * @param {() => void} options.onSliceChange
   * @param {() => void} [options.onGesture] 首次用户手势（用于解锁音频）
   */
  constructor(options) {
    this.domElement = options.domElement;
    this.camera = options.camera;
    this.puzzleRenderer = options.puzzleRenderer;
    this.sliceHandles = options.sliceHandles;
    this.getSlice = options.getSlice;
    this.onChisel = options.onChisel;
    this.onPaint = options.onPaint;
    this.onSliceChange = options.onSliceChange;
    this.onGesture = options.onGesture;

    this.enabled = true;

    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._hit = {};
    this._hasPointer = false;

    /** @type {THREE.Mesh|null} 正在拖动的滑块 */
    this._drag = null;
    this._dragPointerId = -1;
    this._pressBlock = -1;
    this._pressX = 0;
    this._pressY = 0;
    this._gestureDone = false;

    this._isVisible = (block) => {
      const map = this.puzzleRenderer.blockToSlot;
      return Boolean(map) && map[block] >= 0;
    };

    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onPointerMove = this._handlePointerMove.bind(this);
    this._onPointerUp = this._handlePointerUp.bind(this);
    this._onPointerLeave = this._handlePointerLeave.bind(this);
    this._onPointerCancel = this._handlePointerCancel.bind(this);

    const el = this.domElement;
    el.addEventListener("pointerdown", this._onPointerDown);
    el.addEventListener("pointermove", this._onPointerMove);
    el.addEventListener("pointerup", this._onPointerUp);
    el.addEventListener("pointerleave", this._onPointerLeave);
    el.addEventListener("pointercancel", this._onPointerCancel);
  }

  /** 是否正在拖动截面滑块 */
  get isDraggingSlice() {
    return this._drag !== null;
  }

  /**
   * 每帧调用：刷新悬停高亮
   *
   * 不只在 pointermove 时刷新，是因为**相机转动**同样会改变指针下的方块。
   * 体素步进很便宜，每帧重算比维护"相机是否动过"的状态更可靠。
   */
  update() {
    if (!this.enabled || this._drag || !this._hasPointer) return;
    this._applyHover(this._pick());
  }

  /** 释放全部事件监听 */
  dispose() {
    const el = this.domElement;
    el.removeEventListener("pointerdown", this._onPointerDown);
    el.removeEventListener("pointermove", this._onPointerMove);
    el.removeEventListener("pointerup", this._onPointerUp);
    el.removeEventListener("pointerleave", this._onPointerLeave);
    el.removeEventListener("pointercancel", this._onPointerCancel);
    this._endDrag();
    el.style.cursor = "";
  }

  _handlePointerDown(event) {
    if (!this.enabled || event.button !== 0) return;

    if (!this._gestureDone) {
      this._gestureDone = true;
      this.onGesture?.();
    }

    this._updateNdc(event);
    const pick = this._pick();

    if (pick.knob) {
      this._drag = pick.knob;
      this._dragPointerId = event.pointerId;
      this.sliceHandles.setDragging(pick.knob);
      this.domElement.setPointerCapture?.(event.pointerId);
      this.domElement.style.cursor = "grabbing";
      event.preventDefault();
      return;
    }

    this._pressBlock = pick.block;
    this._pressX = event.clientX;
    this._pressY = event.clientY;
  }

  _handlePointerMove(event) {
    if (!this.enabled) return;
    this._hasPointer = true;
    this._updateNdc(event);

    if (this._drag) {
      this._dragTo();
      event.preventDefault();
      return;
    }

    this._applyHover(this._pick());
  }

  _handlePointerUp(event) {
    if (!this.enabled || event.button !== 0) return;

    if (this._drag) {
      this._endDrag();
      return;
    }

    const pressed = this._pressBlock;
    this._pressBlock = -1;
    if (pressed < 0) return;

    // 位移过大 → 当作拖拽，不触发操作（也就成了"按下后反悔"的取消手段）
    const moved = Math.hypot(event.clientX - this._pressX, event.clientY - this._pressY);
    if (moved > CLICK_SLOP) return;

    this._updateNdc(event);
    const pick = this._pick();
    if (pick.block !== pressed) return;

    if (event.ctrlKey || event.metaKey) this.onPaint?.(pressed);
    else this.onChisel?.(pressed);
  }

  _handlePointerLeave() {
    this._hasPointer = false;
    if (!this._drag) {
      this.puzzleRenderer.setHover(-1);
      this.sliceHandles.setHover(null);
      this.domElement.style.cursor = "";
    }
  }

  _handlePointerCancel() {
    this._endDrag();
  }

  /** 拖动中：把指针位置换算成层号并写回 SliceRange */
  _dragTo() {
    const slice = this.getSlice?.();
    if (!slice || !this._drag) return;
    this._raycaster.setFromCamera(this._ndc, this.camera);
    const value = this.sliceHandles.valueFromRay(this._drag, this._raycaster.ray);
    if (value === null || value === undefined) return;
    const { axis, side } = this._drag.userData;
    if (slice.setBound(axis, side, value)) this.onSliceChange?.();
  }

  _endDrag() {
    if (!this._drag) return;
    if (this._dragPointerId >= 0) {
      this.domElement.releasePointerCapture?.(this._dragPointerId);
      this._dragPointerId = -1;
    }
    this._drag = null;
    this.sliceHandles.setDragging(null);
    this.domElement.style.cursor = "";
  }

  _updateNdc(event) {
    const rect = this.domElement.getBoundingClientRect();
    this._ndc.x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    this._ndc.y = -((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
  }

  /**
   * 一次拾取：滑块优先，其次方块
   * @returns {{knob: THREE.Mesh|null, block: number}}
   */
  _pick() {
    const result = { knob: null, block: -1 };
    if (!this.puzzleRenderer.model) return result;

    this._raycaster.setFromCamera(this._ndc, this.camera);
    const ray = this._raycaster.ray;

    const knobs = this.sliceHandles.interactiveObjects;
    const knobHits = knobs.length > 0 ? this._raycaster.intersectObjects(knobs, false) : [];
    const knobDistance = knobHits.length > 0 ? knobHits[0].distance : Infinity;

    const voxel = raycastVoxels(
      this.puzzleRenderer.model.grid,
      ray.origin,
      ray.direction,
      this._isVisible,
      this._hit,
    );
    // 射线方向已归一化、CELL = 1，所以体素步进给出的 t 与 three 的 distance 同量纲
    const voxelDistance = voxel ? voxel.t : Infinity;

    if (knobDistance <= voxelDistance) {
      if (knobHits.length > 0) result.knob = knobHits[0].object;
      return result;
    }
    if (voxel) result.block = voxel.block;
    return result;
  }

  /** 把拾取结果落到高亮与鼠标指针样式上 */
  _applyHover(pick) {
    this.sliceHandles.setHover(pick.knob);
    this.puzzleRenderer.setHover(pick.knob ? -1 : pick.block);

    if (pick.knob) this.domElement.style.cursor = "grab";
    else if (pick.block >= 0) this.domElement.style.cursor = "pointer";
    else this.domElement.style.cursor = "";
  }
}
