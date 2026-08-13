import * as THREE from "three";
import { AXIS_X, AXIS_Y, CELL, coordsOf, gridToWorld } from "../core/GridCoords.js";

/**
 * 整行完成的描边特效
 *
 * ## 什么时候放
 * 一条线上"该凿的都凿了、该留的都涂了"时（PuzzleModel 判定），
 * 沿这条线画一个发亮的**线框长条**，从中间向两端弹开、随后淡出。
 * 它的作用是把玩家的注意力精准地拉到"你刚刚做完的是这一行"，
 * 而不是泛泛地闪一下整个造型。
 *
 * ## 为什么用线框而不是发光实体
 * 这一行的方块紧接着就要换成最终配色（由 PuzzleRenderer 的延迟高光扫过完成），
 * 如果特效本身是不透明实体，会把上色过程整个盖住。
 * 线框只勾勒轮廓、不遮挡内容，两个效果可以叠在一起同时看清。
 *
 * ## 实现
 * 所有描边共用**一份** EdgesGeometry（单位立方体的 12 条棱），
 * 每个实例只是一个不同 scale/position 的 LineSegments。
 * 同时在场的描边不会超过几条，用对象池反复复用，运行期零分配。
 */

/** 描边动画时长（秒） */
const DURATION = 0.62;
/** 对象池容量：连锁完成时同一帧可能有好几条线一起完成 */
const POOL_SIZE = 12;
/** 描边颜色：与"确认高光"同一色系，读起来是同一件事 */
const COLOR = 0xfff3c4;
/** 线框相对方块外扩多少，避免与方块表面重合闪烁 */
const INFLATE = 0.06;

export class LineHighlight {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = "LineHighlights";
    this.group.renderOrder = 4;

    /** @type {THREE.EdgesGeometry|null} */
    this.geometry = null;
    /** @type {{mesh: THREE.LineSegments, time: number, active: boolean, span: number}[]} */
    this.pool = [];
    this.grid = null;

    this._coord = { x: 0, y: 0, z: 0 };
    this._world = { x: 0, y: 0, z: 0 };
  }

  /** @param {import("../core/GridCoords.js").Grid} grid */
  build(grid) {
    this.dispose();
    this.grid = grid;

    const box = new THREE.BoxGeometry(1, 1, 1);
    this.geometry = new THREE.EdgesGeometry(box);
    box.dispose();

    for (let i = 0; i < POOL_SIZE; i++) {
      const material = new THREE.LineBasicMaterial({
        color: COLOR,
        transparent: true,
        opacity: 0,
        // 让描边穿透方块可见：整行完成是重要反馈，不该被别的方块挡住
        depthTest: false,
        depthWrite: false,
      });
      const mesh = new THREE.LineSegments(this.geometry, material);
      mesh.name = `LineHighlight_${i}`;
      mesh.visible = false;
      mesh.renderOrder = 4;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.pool.push({ mesh, time: 0, active: false, span: 1 });
    }
    return this.group;
  }

  /**
   * 沿一条线放一次描边
   * @param {number} axis
   * @param {number[]} cells 该线上的方块（至少一个；用首尾算包围盒）
   * @returns {number} 动画时长（秒），0 = 没有可用槽位
   */
  play(axis, cells) {
    if (!this.grid || cells.length === 0) return 0;

    const slot = this.pool.find((p) => !p.active) ?? this._oldest();
    if (!slot) return 0;

    // 沿轴向取首尾格，算出这一段的中心与长度
    let lo = Infinity;
    let hi = -Infinity;
    let anchor = cells[0];
    for (const cell of cells) {
      coordsOf(this.grid, cell, this._coord);
      const along =
        axis === AXIS_X ? this._coord.x : axis === AXIS_Y ? this._coord.y : this._coord.z;
      if (along < lo) {
        lo = along;
        anchor = cell;
      }
      if (along > hi) hi = along;
    }
    const span = hi - lo + 1;

    coordsOf(this.grid, anchor, this._coord);
    gridToWorld(this.grid, this._coord.x, this._coord.y, this._coord.z, this._world);
    const half = ((span - 1) * CELL) / 2;
    slot.mesh.position.set(
      this._world.x + (axis === AXIS_X ? half : 0),
      this._world.y + (axis === AXIS_Y ? half : 0),
      this._world.z + (axis === AXIS_X || axis === AXIS_Y ? 0 : half),
    );
    slot.axis = axis;
    slot.span = span;
    slot.time = 0;
    slot.active = true;
    slot.mesh.visible = true;
    this._applyScale(slot, 0);
    return DURATION;
  }

  /** @param {number} delta 秒 */
  update(delta) {
    for (const slot of this.pool) {
      if (!slot.active) continue;
      slot.time += delta;
      const t = Math.min(1, slot.time / DURATION);
      this._applyScale(slot, t);
      if (t >= 1) {
        slot.active = false;
        slot.mesh.visible = false;
        slot.mesh.material.opacity = 0;
      }
    }
  }

  /** 全部收起（换关时用） */
  clear() {
    for (const slot of this.pool) {
      slot.active = false;
      slot.mesh.visible = false;
      slot.mesh.material.opacity = 0;
    }
  }

  getStats() {
    const active = this.pool.reduce((n, p) => n + (p.active ? 1 : 0), 0);
    return { drawCalls: active, active };
  }

  dispose() {
    for (const slot of this.pool) {
      this.group.remove(slot.mesh);
      slot.mesh.material.dispose();
    }
    this.pool = [];
    this.geometry?.dispose();
    this.geometry = null;
    this.grid = null;
  }

  /**
   * 动画曲线：前 35% 从中心弹开到全长（easeOutBack 的过冲带来"啪"的一下），
   * 后段整体略微外扩并淡出，读起来像一道扫过去的光。
   */
  _applyScale(slot, t) {
    const grow = Math.min(1, t / 0.35);
    const e = easeOutBack(grow);
    const fade = t < 0.35 ? 1 : 1 - (t - 0.35) / 0.65;

    const long = (slot.span * CELL + INFLATE * 2) * e;
    const thin = CELL + INFLATE * 2 + (1 - fade) * 0.22;
    slot.mesh.scale.set(
      slot.axis === AXIS_X ? long : thin,
      slot.axis === AXIS_Y ? long : thin,
      slot.axis === AXIS_X || slot.axis === AXIS_Y ? thin : long,
    );
    slot.mesh.material.opacity = 0.95 * fade;
  }

  _oldest() {
    let oldest = null;
    for (const slot of this.pool) {
      if (!oldest || slot.time > oldest.time) oldest = slot;
    }
    return oldest;
  }
}

function easeOutBack(t) {
  const c1 = 1.7;
  const c3 = c1 + 1;
  const p = t - 1;
  return 1 + c3 * p * p * p + c1 * p * p;
}
