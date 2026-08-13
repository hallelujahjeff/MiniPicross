import * as THREE from "three";
import {
  getShardGeometry,
  getBlockMaterial,
  SHARD_SCALE,
  INSTANCE_COLOR_DEFAULT,
} from "./BlockAssets.js";

/**
 * 方块碎裂特效
 *
 * ## 手感设计（"清脆"是怎么做出来的）
 *  1. **零跳变起手**：一个方块被敲掉的瞬间，用 2×2×2 八块半尺寸碎片替换它。
 *     碎片出生在八个子立方体的中心，第一帧和原方块严丝合缝，
 *     所以看起来是"裂开"，而不是"消失 + 冒出粒子"。
 *  2. **快**：整个过程 0.34 秒。清脆感来自短促——拖长了就变成"融化"。
 *  3. **炸开方向沿对角线**：碎片沿自己相对方块中心的方向飞出，加一点随机扰动
 *     和向上初速，配合重力，落势自然。
 *  4. **边飞边缩**：用 1 - t³ 收缩，前段几乎保持原大小（看得清是"块"），
 *     末段迅速收没，避免出现"小方块凭空消失"的突兀感。
 *  5. **自转**：每块给一个随机轴的自转，破坏对称性，避免八块整齐飞出的机械感。
 *
 * 全部碎片共用一个 InstancedMesh（+1 draw call），材质与方块共享，
 * 所以碎片的材质表现（乳白亚光、环境反射）与本体完全一致。
 */

/** 单次碎裂产生的碎片数（2×2×2） */
const SHARDS_PER_BLOCK = 8;
/** 碎片寿命（秒） */
const LIFETIME = 0.34;
/** 重力加速度 */
const GRAVITY = 15;
/** 初速大小范围 */
const SPEED_MIN = 3.0;
const SPEED_MAX = 4.6;
/** 额外向上初速，让碎裂有一点"崩起来"的感觉 */
const UP_BOOST = 1.5;
/** 自转角速度范围（弧度/秒） */
const SPIN_MIN = 4;
const SPIN_MAX = 13;

export class ShardBurst {
  /** @param {number} [maxBursts] 同时最多容纳几次碎裂 */
  constructor(maxBursts = 26) {
    this.capacity = maxBursts * SHARDS_PER_BLOCK;

    this.group = new THREE.Group();
    this.group.name = "ShardRoot";

    /** @type {THREE.InstancedMesh|null} */
    this.mesh = null;

    // 活跃碎片紧凑排列在数组前段，死亡时与末尾交换（与方块槽位同一套思路）
    this.count = 0;
    this.pos = new Float32Array(this.capacity * 3);
    this.vel = new Float32Array(this.capacity * 3);
    this.spinAxis = new Float32Array(this.capacity * 3);
    this.spinSpeed = new Float32Array(this.capacity);
    this.angle = new Float32Array(this.capacity);
    this.life = new Float32Array(this.capacity);

    this._matrix = new THREE.Matrix4();
    this._pos = new THREE.Vector3();
    this._axis = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._scale = new THREE.Vector3();
  }

  /** 建立实例网格（全局只需一次） */
  build() {
    if (this.mesh) return this.mesh;

    const mesh = new THREE.InstancedMesh(
      getShardGeometry(),
      getBlockMaterial(),
      this.capacity,
    );
    mesh.name = "BlockShards";
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;

    // 材质本色是纯白（着色交给实例色），碎片要跟被敲掉的方块同色，
    // 所以统一填上"未完成方块"的象牙色
    const ivory = new THREE.Color(INSTANCE_COLOR_DEFAULT);
    const colors = new Float32Array(this.capacity * 3);
    for (let i = 0; i < this.capacity; i++) {
      colors[i * 3] = ivory.r;
      colors[i * 3 + 1] = ivory.g;
      colors[i * 3 + 2] = ivory.b;
    }
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    // 碎片四散飞出，包围球会持续变化；数量少、几何体小，直接关掉视锥剔除更省心
    mesh.frustumCulled = false;
    // 只存活 0.34 秒，投影收益极低，关掉省一遍 shadow pass
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    this.mesh = mesh;
    this.group.add(mesh);
    return mesh;
  }

  /**
   * 在某个世界坐标处炸开一个方块
   * @param {THREE.Vector3|{x:number,y:number,z:number}} center
   */
  burst(center) {
    if (!this.mesh) this.build();

    const half = SHARD_SCALE / 2; // 子立方体中心相对方块中心的偏移
    for (let i = 0; i < SHARDS_PER_BLOCK; i++) {
      if (this.count >= this.capacity) {
        // 容量打满时挤掉最老的一片，保证新碎裂一定看得见
        this._recycleOldest();
      }
      const s = this.count++;

      const ox = (i & 1 ? 1 : -1) * half;
      const oy = (i & 2 ? 1 : -1) * half;
      const oz = (i & 4 ? 1 : -1) * half;

      const p = s * 3;
      this.pos[p] = center.x + ox;
      this.pos[p + 1] = center.y + oy;
      this.pos[p + 2] = center.z + oz;

      // 沿"自己相对中心"的方向飞出，再叠加扰动与向上初速
      const len = Math.hypot(ox, oy, oz) || 1;
      const speed = SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN);
      this.vel[p] = (ox / len) * speed + (Math.random() - 0.5) * 1.2;
      this.vel[p + 1] = (oy / len) * speed + UP_BOOST + (Math.random() - 0.5) * 1.2;
      this.vel[p + 2] = (oz / len) * speed + (Math.random() - 0.5) * 1.2;

      // 随机自转轴
      let ax = Math.random() * 2 - 1;
      let ay = Math.random() * 2 - 1;
      let az = Math.random() * 2 - 1;
      const al = Math.hypot(ax, ay, az) || 1;
      ax /= al;
      ay /= al;
      az /= al;
      this.spinAxis[p] = ax;
      this.spinAxis[p + 1] = ay;
      this.spinAxis[p + 2] = az;
      this.spinSpeed[s] = SPIN_MIN + Math.random() * (SPIN_MAX - SPIN_MIN);
      this.angle[s] = 0;
      this.life[s] = 0;
    }

    this.mesh.count = this.count;
    return SHARDS_PER_BLOCK;
  }

  /** @param {number} delta 秒 */
  update(delta) {
    if (!this.mesh || this.count === 0) return;

    for (let s = this.count - 1; s >= 0; s--) {
      this.life[s] += delta;
      const t = this.life[s] / LIFETIME;
      if (t >= 1) {
        this._swapRemove(s);
        continue;
      }

      const p = s * 3;
      this.vel[p + 1] -= GRAVITY * delta;
      this.pos[p] += this.vel[p] * delta;
      this.pos[p + 1] += this.vel[p + 1] * delta;
      this.pos[p + 2] += this.vel[p + 2] * delta;
      this.angle[s] += this.spinSpeed[s] * delta;

      // 1 - t³：前段几乎不缩（看得清是块），末段迅速收没
      const scale = Math.max(0.001, 1 - t * t * t);

      this._pos.set(this.pos[p], this.pos[p + 1], this.pos[p + 2]);
      this._axis.set(this.spinAxis[p], this.spinAxis[p + 1], this.spinAxis[p + 2]);
      this._quat.setFromAxisAngle(this._axis, this.angle[s]);
      this._scale.setScalar(scale);
      this._matrix.compose(this._pos, this._quat, this._scale);
      this.mesh.setMatrixAt(s, this._matrix);
    }

    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** 清空全部碎片（换关时用） */
  clear() {
    this.count = 0;
    if (this.mesh) this.mesh.count = 0;
  }

  getStats() {
    return { drawCalls: this.count > 0 ? 1 : 0, shards: this.count, capacity: this.capacity };
  }

  dispose() {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.dispose();
      this.mesh = null;
    }
    this.count = 0;
  }

  /** 把末尾的碎片搬到 slot 上，实现 O(1) 删除 */
  _swapRemove(slot) {
    const last = this.count - 1;
    if (slot !== last) {
      const a = slot * 3;
      const b = last * 3;
      for (let k = 0; k < 3; k++) {
        this.pos[a + k] = this.pos[b + k];
        this.vel[a + k] = this.vel[b + k];
        this.spinAxis[a + k] = this.spinAxis[b + k];
      }
      this.spinSpeed[slot] = this.spinSpeed[last];
      this.angle[slot] = this.angle[last];
      this.life[slot] = this.life[last];
    }
    this.count = last;
  }

  /** 容量打满时回收寿命最长的那片 */
  _recycleOldest() {
    let oldest = 0;
    for (let s = 1; s < this.count; s++) {
      if (this.life[s] > this.life[oldest]) oldest = s;
    }
    this._swapRemove(oldest);
  }
}
