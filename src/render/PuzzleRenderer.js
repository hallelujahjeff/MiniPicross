import * as THREE from "three";
import { coordsOf, gridToWorld, CELL } from "../core/GridCoords.js";
import * as BlockState from "../core/BlockState.js";
import {
  getBlockGeometry,
  getBlockMaterial,
  getTrianglesPerBlock,
  INSTANCE_COLOR_DEFAULT,
  INSTANCE_COLOR_PAINTED,
  HOVER_GAIN,
} from "./BlockAssets.js";

/**
 * 方块渲染管线
 *
 * 全部方块由**一个 InstancedMesh** 绘制 → 1 个 draw call。
 *
 * 槽位（slot）与方块（block）的关系：
 *  - slotToBlock[slot]  → 该实例槽位当前显示的方块线性索引
 *  - blockToSlot[block] → 该方块占用的槽位，-1 表示当前不可见
 *  - 移除方块用"**尾部交换 + count--**"：O(1)，不需要重建 buffer，
 *    也不需要每帧遍历全量实例。
 *
 * "不可见"有两个来源，且共用同一套槽位机制：
 *  1. 被玩家凿除（模型状态里的 REMOVED）
 *  2. 被**截面**隐藏（SliceRange 之外）
 * 因此 `blockToSlot[block] >= 0` 就是全局唯一的"这块看得见吗"判据，
 * 提示贴花与鼠标拾取都直接复用它，不会出现两套可见性打架的情况。
 *
 * 每帧只处理 PuzzleModel 的 dirty 集合，无改动时不上传任何 buffer。
 */

const APPEAR_DURATION = 0.22; // 单个方块的出现动画时长（秒）
const APPEAR_LAYER_STAGGER = 0.02; // 每层的延迟（秒），形成自下而上的上浮感
const DISAPPEAR_DURATION = 0.14;

/** 闪烁反馈时长（秒） */
const FLASH_DURATION = 0.45;

export class PuzzleRenderer {
  constructor() {
    /** 挂载点：切关时整体缩放做淡出，不影响实例矩阵 */
    this.group = new THREE.Group();
    this.group.name = "PuzzleRoot";

    /** @type {THREE.InstancedMesh|null} */
    this.mesh = null;
    /** @type {import("../puzzle/PuzzleModel.js").PuzzleModel|null} */
    this.model = null;
    /** @type {import("../puzzle/SliceRange.js").SliceRange|null} */
    this.slice = null;

    /** @type {Int32Array|null} */
    this.slotToBlock = null;
    /** @type {Int32Array|null} */
    this.blockToSlot = null;
    /** 当前可见实例数（= mesh.count） */
    this.visibleCount = 0;

    /**
     * 可见集合每变化一次就自增。
     * 提示贴花只需要在它变化时重算，靠比较这个数字即可，省掉每帧全量扫描。
     */
    this.visibilityVersion = 0;

    /** 当前鼠标悬停的方块（-1 = 无） */
    this.hoverBlock = -1;

    /** @type {Map<number, {time:number, duration:number, color:THREE.Color, bounce:number}>} */
    this._flashes = new Map();

    // 复用对象，避免热路径产生垃圾
    this._matrix = new THREE.Matrix4();
    this._color = new THREE.Color();
    this._colorB = new THREE.Color();
    this._coord = { x: 0, y: 0, z: 0 };
    this._world = { x: 0, y: 0, z: 0 };
    this._scaleVec = new THREE.Vector3(1, 1, 1);
    this._quat = new THREE.Quaternion();
    this._pos = new THREE.Vector3();

    this._appear = { active: false, time: 0, total: 0 };
    this._disappear = { active: false, time: 0, onDone: null };
  }

  /**
   * 根据谜题数据构建实例化网格
   * @param {import("../puzzle/PuzzleModel.js").PuzzleModel} model
   * @param {import("../puzzle/SliceRange.js").SliceRange} [slice]
   */
  build(model, slice = null) {
    this.dispose();

    this.model = model;
    this.slice = slice;
    const grid = model.grid;
    const capacity = grid.count;

    const mesh = new THREE.InstancedMesh(
      getBlockGeometry(),
      getBlockMaterial(),
      capacity,
    );
    mesh.name = `Puzzle_${model.level.id}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // 显式创建实例色（默认全白 = 不改变材质本色），避免运行中首次涂色触发着色器重编译
    mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3).fill(1),
      3,
    );
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

    // 场景不使用阴影（见 SceneEnvironment），显式关掉省一遍 shadow pass
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    this.slotToBlock = new Int32Array(capacity).fill(-1);
    this.blockToSlot = new Int32Array(capacity).fill(-1);

    // 手动设置包围球：网格居中于原点，避免 three 为动态实例反复计算/误判剔除
    const half = new THREE.Vector3(grid.W, grid.H, grid.D).multiplyScalar(CELL / 2);
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), half.length());
    mesh.frustumCulled = true;

    this.mesh = mesh;
    this.rebuildVisible();

    this.group.scale.setScalar(1);
    this.group.add(mesh);

    this.startAppear();
    return mesh;
  }

  /** 方块当前是否应该显示（未被凿除 且 落在截面范围内） */
  shouldBeVisible(block) {
    if (BlockState.isRemoved(this.model.getState(block))) return false;
    if (this.slice && !this.slice.containsIndex(block)) return false;
    return true;
  }

  /**
   * 按当前模型状态 + 截面范围整体重建可见槽位
   *
   * 拖动截面时被隐藏/恢复的方块可能成百上千，逐个走"尾部交换"反而更慢也更绕；
   * 直接按整数坐标顺序重填一遍，既 O(N) 又保证槽位顺序稳定（截图可复现）。
   */
  rebuildVisible() {
    if (!this.mesh || !this.model) return 0;

    const capacity = this.model.grid.count;
    this.slotToBlock.fill(-1);
    this.blockToSlot.fill(-1);

    let slot = 0;
    for (let block = 0; block < capacity; block++) {
      if (!this.shouldBeVisible(block)) continue;
      this.slotToBlock[slot] = block;
      this.blockToSlot[block] = slot;
      slot++;
    }
    this.visibleCount = slot;
    this.mesh.count = slot;

    for (let s = 0; s < slot; s++) {
      const block = this.slotToBlock[s];
      this._writeMatrix(s, block, 1);
      this._writeColor(s, block);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
    this.visibilityVersion++;
    return slot;
  }

  /** 更换截面范围（App 在拖动手柄后调用） */
  setSlice(slice) {
    this.slice = slice;
    if (this.mesh) this.rebuildVisible();
  }

  /** 启动"自下而上上浮淡入"的出现动画 */
  startAppear() {
    if (!this.mesh || !this.model) return 0;
    this._disappear.active = false;
    this._appear.active = true;
    this._appear.time = 0;
    this._appear.total =
      APPEAR_DURATION + APPEAR_LAYER_STAGGER * Math.max(0, this.model.grid.H - 1);
    return this._appear.total;
  }

  /**
   * 启动整体淡出（切关用）
   * @param {() => void} [onDone]
   * @returns {number} 动画时长（秒）
   */
  startDisappear(onDone) {
    if (!this.mesh) {
      onDone?.();
      return 0;
    }
    // 已有一次淡出在途时，先结清旧回调，避免上一个 await 永久挂起
    if (this._disappear.onDone) {
      const prev = this._disappear.onDone;
      this._disappear.onDone = null;
      prev();
    }
    this._appear.active = false;
    this._disappear.active = true;
    this._disappear.time = 0;
    this._disappear.onDone = onDone ?? null;
    return DISAPPEAR_DURATION;
  }

  get isAnimating() {
    return this._appear.active || this._disappear.active;
  }

  /**
   * 每帧调用：同步模型变更 + 推进过场动画 + 推进闪烁反馈
   * @param {number} delta 秒
   */
  update(delta) {
    this.syncFromModel();

    if (this._disappear.active) {
      this._disappear.time += delta;
      const t = Math.min(1, this._disappear.time / DISAPPEAR_DURATION);
      const k = 1 - t * t; // easeInQuad 收缩
      this.group.scale.setScalar(Math.max(0.0001, k));
      if (t >= 1) {
        this._disappear.active = false;
        const cb = this._disappear.onDone;
        this._disappear.onDone = null;
        cb?.();
      }
      return;
    }

    if (this._appear.active) {
      this._appear.time += delta;
      const now = this._appear.time;
      let allDone = true;

      for (let s = 0; s < this.visibleCount; s++) {
        const block = this.slotToBlock[s];
        coordsOf(this.model.grid, block, this._coord);
        const start = this._coord.y * APPEAR_LAYER_STAGGER;
        let t = (now - start) / APPEAR_DURATION;
        if (t < 0) t = 0;
        if (t < 1) allDone = false;
        else t = 1;
        // easeOutBack：轻微过冲，手感更有弹性
        const e = easeOutBack(t);
        this._writeMatrix(s, block, e);
      }

      this.mesh.instanceMatrix.needsUpdate = true;
      if (allDone) {
        this._appear.active = false;
        for (let s = 0; s < this.visibleCount; s++) {
          this._writeMatrix(s, this.slotToBlock[s], 1);
        }
        this.mesh.instanceMatrix.needsUpdate = true;
      }
    }

    this._updateFlashes(delta);
  }

  /** 增量同步：只处理模型的 dirty 方块 */
  syncFromModel() {
    if (!this.model || !this.mesh) return 0;

    let matrixDirty = false;
    let colorDirty = false;

    const processed = this.model.consumeDirty((block) => {
      const slot = this.blockToSlot[block];
      const want = this.shouldBeVisible(block);
      if (!want) {
        if (slot >= 0 && this.removeBlockVisual(block)) matrixDirty = true;
        return;
      }
      if (slot < 0) {
        if (this.restoreBlockVisual(block)) matrixDirty = true;
        return;
      }
      this._writeColor(slot, block);
      colorDirty = true;
    });

    if (matrixDirty) this.mesh.instanceMatrix.needsUpdate = true;
    if (colorDirty) this.mesh.instanceColor.needsUpdate = true;
    return processed;
  }

  /**
   * 隐藏一个方块（尾部交换 + count--，O(1)）
   * @returns {boolean} 是否发生变化
   */
  removeBlockVisual(block) {
    if (!this.mesh) return false;
    const slot = this.blockToSlot[block];
    if (slot < 0) return false;

    const last = this.visibleCount - 1;
    if (slot !== last) {
      const lastBlock = this.slotToBlock[last];
      this.mesh.getMatrixAt(last, this._matrix);
      this.mesh.setMatrixAt(slot, this._matrix);
      this.mesh.getColorAt(last, this._color);
      this.mesh.setColorAt(slot, this._color);
      // 槽位交换同时改写了实例色，必须一并标脏，
      // 否则被换来的方块会残留前一个方块的颜色
      this.mesh.instanceColor.needsUpdate = true;
      this.slotToBlock[slot] = lastBlock;
      this.blockToSlot[lastBlock] = slot;
    }

    this.slotToBlock[last] = -1;
    this.blockToSlot[block] = -1;
    this.visibleCount = last;
    this.mesh.count = last;
    this.visibilityVersion++;
    return true;
  }

  /**
   * 重新显示一个方块（撤销 / 退出截面用；追加到尾部槽位）
   * @returns {boolean}
   */
  restoreBlockVisual(block) {
    if (!this.mesh) return false;
    if (!Number.isInteger(block) || block < 0 || block >= this.blockToSlot.length) {
      return false;
    }
    if (this.blockToSlot[block] >= 0) return false;
    if (this.visibleCount >= this.mesh.instanceMatrix.count) return false;

    const slot = this.visibleCount;
    this.slotToBlock[slot] = block;
    this.blockToSlot[block] = slot;
    this.visibleCount = slot + 1;
    this.mesh.count = this.visibleCount;

    this._writeMatrix(slot, block, 1);
    this._writeColor(slot, block);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
    this.visibilityVersion++;
    return true;
  }

  /** 设置鼠标悬停的方块（-1 表示取消） */
  setHover(block) {
    const next = Number.isInteger(block) && block >= 0 ? block : -1;
    if (next === this.hoverBlock) return false;

    const prev = this.hoverBlock;
    this.hoverBlock = next;
    let dirty = false;
    for (const b of [prev, next]) {
      if (b < 0 || !this.blockToSlot) continue;
      const slot = this.blockToSlot[b];
      if (slot >= 0) {
        this._writeColor(slot, b);
        dirty = true;
      }
    }
    if (dirty) this.mesh.instanceColor.needsUpdate = true;
    return dirty;
  }

  /**
   * 触发一次闪烁反馈
   *
   * 两种曲线，对应两种语义：
   *  - `"blink"`（默认）：快速两下闪动后衰减 —— 读起来是"错了 / 点不动"。
   *  - `"sweep"`：迅速亮起、**保持**一段、最后落回常态色 —— 用于"整行完成"。
   *    保持段的存在是关键：它让描边特效有时间放完，颜色才在特效尾声浮现出来，
   *    而不是"啪"一下直接换色。
   *
   * @param {number} block
   * @param {THREE.ColorRepresentation} color
   * @param {Object} [options]
   * @param {number} [options.bounce] 缩放脉冲幅度（0 = 只闪色不动）
   * @param {number} [options.delay] 延迟多少秒开始（沿线递增即形成扫过效果）
   * @param {number} [options.duration]
   * @param {"blink"|"sweep"} [options.shape]
   */
  flashBlock(block, color, options = {}) {
    if (!this.mesh || !this.blockToSlot) return false;
    if (this.blockToSlot[block] < 0) return false;
    this._flashes.set(block, {
      // 用负时间表示"还没开始"，推进到 0 才真正生效
      time: -Math.max(0, options.delay ?? 0),
      duration: options.duration ?? FLASH_DURATION,
      color: new THREE.Color(color),
      bounce: options.bounce ?? 0.05,
      shape: options.shape ?? "blink",
    });
    return true;
  }

  /** 推进闪烁反馈：色彩混合 + 轻微缩放脉冲 */
  _updateFlashes(delta) {
    if (this._flashes.size === 0) return;

    let colorDirty = false;
    let matrixDirty = false;

    for (const [block, flash] of this._flashes) {
      flash.time += delta;
      if (flash.time < 0) continue; // 还在等自己的出场时刻

      const slot = this.blockToSlot[block];
      if (slot < 0) {
        // 方块已被隐藏（例如切了截面），直接结束这次闪烁
        this._flashes.delete(block);
        continue;
      }

      const t = Math.min(1, flash.time / flash.duration);
      const k = flash.shape === "sweep" ? sweepCurve(t) : blinkCurve(t);

      this._baseColor(block, this._color);
      this._color.lerp(flash.color, k);
      this.mesh.setColorAt(slot, this._color);
      colorDirty = true;

      if (flash.bounce > 0) {
        this._writeMatrix(slot, block, 1 + flash.bounce * k);
        matrixDirty = true;
      }

      if (t >= 1) {
        this._flashes.delete(block);
        this._writeColor(slot, block);
        if (flash.bounce > 0) this._writeMatrix(slot, block, 1);
      }
    }

    if (colorDirty) this.mesh.instanceColor.needsUpdate = true;
    if (matrixDirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * 拾取反查：instanceId → 方块线性索引（-1 表示无效）
   * 这是凿除/涂色交互的唯一入口。
   */
  getBlockIndexByInstanceId(instanceId) {
    if (
      !this.slotToBlock ||
      !Number.isInteger(instanceId) ||
      instanceId < 0 ||
      instanceId >= this.visibleCount
    ) {
      return -1;
    }
    return this.slotToBlock[instanceId];
  }

  /** 拾取反查并转成整数坐标 */
  getBlockCoordsByInstanceId(instanceId, out = { x: 0, y: 0, z: 0 }) {
    const block = this.getBlockIndexByInstanceId(instanceId);
    if (block < 0) return null;
    return coordsOf(this.model.grid, block, out);
  }

  /** 方块中心的世界坐标（特效定位用） */
  getBlockWorldPosition(block, out = new THREE.Vector3()) {
    if (!this.model) return out.set(0, 0, 0);
    coordsOf(this.model.grid, block, this._coord);
    gridToWorld(this.model.grid, this._coord.x, this._coord.y, this._coord.z, this._world);
    return out.set(this._world.x, this._world.y, this._world.z);
  }

  /**
   * 当前造型的包围信息（相机取景用）
   * @returns {{center: THREE.Vector3, radius: number, size: THREE.Vector3}}
   */
  getBounds() {
    const grid = this.model?.grid;
    const size = grid
      ? new THREE.Vector3(grid.W, grid.H, grid.D).multiplyScalar(CELL)
      : new THREE.Vector3(1, 1, 1);
    return {
      center: new THREE.Vector3(0, 0, 0),
      radius: size.length() / 2,
      size,
    };
  }

  /** 渲染统计（HUD 用） */
  getRenderStats() {
    const trisPerBlock = getTrianglesPerBlock();
    return {
      drawCalls: this.mesh ? 1 : 0,
      instances: this.visibleCount,
      capacity: this.mesh ? this.mesh.instanceMatrix.count : 0,
      triangles: this.visibleCount * trisPerBlock,
      trianglesPerBlock: trisPerBlock,
    };
  }

  /** 只销毁本关的 InstancedMesh，共享几何体/材质保持常驻 */
  dispose() {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.dispose(); // 释放 instanceMatrix / instanceColor
      this.mesh = null;
    }
    this.model = null;
    this.slice = null;
    this.slotToBlock = null;
    this.blockToSlot = null;
    this.visibleCount = 0;
    this.hoverBlock = -1;
    this._flashes.clear();
    this._appear.active = false;
    this._disappear.active = false;
    this._disappear.onDone = null;
  }

  /** 写入某槽位的实例矩阵（scale 用于出现动画与闪烁脉冲） */
  _writeMatrix(slot, block, scale) {
    coordsOf(this.model.grid, block, this._coord);
    gridToWorld(
      this.model.grid,
      this._coord.x,
      this._coord.y,
      this._coord.z,
      this._world,
    );
    this._pos.set(this._world.x, this._world.y, this._world.z);
    this._scaleVec.setScalar(scale);
    this._matrix.compose(this._pos, this._quat, this._scaleVec);
    this.mesh.setMatrixAt(slot, this._matrix);
  }

  /**
   * 方块的"常态"实例色（不含闪烁）
   *
   * 三档：
   *   已确认（所在整行推完了） → 关卡的最终配色
   *   已标记                   → 暖琥珀
   *   未处理                   → 乳白象牙
   * 悬停再整体提亮一档。
   */
  _baseColor(block, out) {
    const state = this.model.getState(block);
    if (BlockState.isConfirmed(state)) out.set(this.model.colorOf(block));
    else if (BlockState.isPainted(state)) out.set(INSTANCE_COLOR_PAINTED);
    else out.set(INSTANCE_COLOR_DEFAULT);
    if (block === this.hoverBlock) out.multiplyScalar(HOVER_GAIN);
    return out;
  }

  /** 写入某槽位的实例色（按方块状态决定） */
  _writeColor(slot, block) {
    this._baseColor(block, this._colorB);
    this.mesh.setColorAt(slot, this._colorB);
  }
}

function easeOutBack(t) {
  const c1 = 1.2;
  const c3 = c1 + 1;
  const p = t - 1;
  return 1 + c3 * p * p * p + c1 * p * p;
}

/** 失误/点不动：整体衰减 × 两次余弦闪动 */
function blinkCurve(t) {
  return (1 - t) * (0.5 + 0.5 * Math.cos(t * Math.PI * 4));
}

/**
 * 整行完成：18% 时间亮到满、保持到 60%、再落回常态色
 * 保持段让描边特效放完，颜色在特效尾声才浮出来。
 */
function sweepCurve(t) {
  const rise = smoothstep(Math.min(1, t / 0.18));
  const fall = t <= 0.6 ? 0 : smoothstep(Math.min(1, (t - 0.6) / 0.4));
  return rise * (1 - fall);
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}
