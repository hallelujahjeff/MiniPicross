import * as THREE from "three";

/**
 * 通关演出镜头：环绕 + 推进
 *
 * ## 为什么不用"关键帧动画"
 * 相机的起点是玩家自己转到的任意角度，硬切到预设机位会很突兀。
 * 所以这里把相机位置转成**球坐标**（以造型中心为原点），
 * 只对三个分量分别做插值：
 *   方位角 azimuth：从当前角度连续转满一圈（环绕）
 *   极角   polar  ：缓动到一个略微俯视的展示角度
 *   半径   radius ：缓动到更近的距离（推进）
 * 这样无论从哪个视角通关，起手都是平滑的。
 *
 * ## 两个阶段
 *  1. 展示（SHOWCASE_DURATION）：一圈 360°，同时推进 + 找到展示角度。
 *  2. 待机：结束后继续以很慢的速度匀速旋转，直到玩家关掉演出。
 *     这一段是有意保留的——玩家往往想多看几眼自己拼出来的造型。
 */

/** 环绕一圈 + 推进的时长（秒） */
const SHOWCASE_DURATION = 7.0;
/** 待机旋转速度（弧度/秒） */
const IDLE_SPEED = 0.16;
/** 展示用的极角（从 +Y 轴量起）：略微俯视 */
const TARGET_POLAR = THREE.MathUtils.degToRad(72);
/** 推进后的半径相对起始半径的比例 */
const PUSH_IN = 0.78;

export class VictoryCinematic {
  constructor() {
    this.active = false;
    this.time = 0;
    this._spherical = new THREE.Spherical();
    this._offset = new THREE.Vector3();
    this._target = new THREE.Vector3();

    this._startRadius = 10;
    this._startPolar = 1;
    this._startAzimuth = 0;
  }

  /**
   * @param {THREE.Camera} camera
   * @param {THREE.Vector3} target 环绕中心（造型中心）
   * @param {number} [minRadius] 推进后的下限，避免小关卡怼到脸上
   */
  start(camera, target, minRadius = 3) {
    this._target.copy(target);
    this._offset.copy(camera.position).sub(this._target);
    this._spherical.setFromVector3(this._offset);

    this._startRadius = Math.max(minRadius, this._spherical.radius);
    this._startPolar = this._spherical.phi;
    this._startAzimuth = this._spherical.theta;
    this._minRadius = minRadius;

    this.time = 0;
    this.active = true;
  }

  /**
   * @param {number} delta 秒
   * @param {THREE.Camera} camera
   * @returns {boolean} 是否仍在演出中
   */
  update(delta, camera) {
    if (!this.active) return false;
    this.time += delta;

    const t = Math.min(1, this.time / SHOWCASE_DURATION);
    const ease = easeInOutSine(t);

    // 环绕：一圈 360°；结束后转为匀速待机旋转
    const extra = this.time > SHOWCASE_DURATION ? (this.time - SHOWCASE_DURATION) * IDLE_SPEED : 0;
    const azimuth = this._startAzimuth + Math.PI * 2 * ease + extra;

    const polar = THREE.MathUtils.lerp(this._startPolar, TARGET_POLAR, ease);
    const radius = THREE.MathUtils.lerp(
      this._startRadius,
      Math.max(this._minRadius, this._startRadius * PUSH_IN),
      ease,
    );

    this._spherical.set(radius, polar, azimuth);
    this._spherical.makeSafe();
    this._offset.setFromSpherical(this._spherical);
    camera.position.copy(this._target).add(this._offset);
    camera.lookAt(this._target);
    return true;
  }

  stop() {
    this.active = false;
    this.time = 0;
  }
}

function easeInOutSine(t) {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}
