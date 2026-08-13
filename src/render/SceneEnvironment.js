import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CELL } from "../core/GridCoords.js";

/**
 * 场景环境与光照
 *
 * 目标质感：柔和棚拍光 + 乳白亚光陶瓷
 *  - 主体填充来自 IBL（RoomEnvironment 经 PMREMGenerator 烘成 envMap），
 *    这是"亚光象牙白"层次感的来源；纯靠方向光会显得死板发灰。
 *  - 一盏主方向光负责方向性，让相邻方块之间出现明暗差，从而能"数得清"方块。
 *  - 一盏冷调补光 + 顶部柔光抬起暗部，避免背面全黑。
 *
 * ## 不使用阴影
 * 造型是**悬空**的一组方块，投在虚拟地面上的硬阴影既不提供任何解题信息，
 * 又会随镜头旋转在画面里扫出一大块黑影，抢走造型本身的注意力。
 * 所以整个场景关闭 shadowMap，也不放接影地面；
 * 方块之间的体积感完全靠 IBL + 方向光的明暗差和圆角高光来表达。
 * 副作用是省掉每帧一次 shadow pass。
 *
 * envMap 生成一次后缓存复用，切换关卡不重算；PMREMGenerator 用完立即销毁。
 */

const BACKGROUND_COLOR = 0x22252a;
const ENV_INTENSITY = 0.62;

/** @type {THREE.Texture|null} 进程内缓存的 IBL */
let _envMap = null;

export class SceneEnvironment {
  constructor() {
    /** @type {THREE.Scene|null} */
    this.scene = null;
    this.lights = [];
    /** @type {THREE.DirectionalLight|null} */
    this.keyLight = null;
  }

  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   */
  applyTo(scene, renderer) {
    this.scene = scene;

    scene.background = new THREE.Color(BACKGROUND_COLOR);
    scene.environment = getEnvMap(renderer);
    scene.environmentIntensity = ENV_INTENSITY;

    renderer.shadowMap.enabled = false;

    // 主光：右上前方，负责造型的明暗关系（不投影）
    const key = new THREE.DirectionalLight(0xfff6e8, 1.75);
    key.position.set(7, 11, 6);
    key.castShadow = false;
    this.keyLight = key;

    // 补光：左后下方，冷调，抬起暗部并勾出轮廓
    const fill = new THREE.DirectionalLight(0xbcd2ff, 0.5);
    fill.position.set(-8, -2, -7);

    // 头顶柔光，模拟棚拍顶部柔光箱与浅色台面的反弹
    const hemi = new THREE.HemisphereLight(0xffffff, 0x40454e, 0.45);

    this.lights = [key, fill, hemi];
    scene.add(key, fill, hemi);
  }

  /**
   * 按关卡尺寸调整光源距离
   * @param {{W:number,H:number,D:number}} grid
   */
  fitToGrid(grid) {
    const radius =
      new THREE.Vector3(grid.W, grid.H, grid.D).multiplyScalar(CELL / 2).length() + 1;
    const key = this.keyLight;
    if (key) {
      // 光源距离随关卡放大，避免大关卡时光线角度过陡
      const dist = Math.max(14, radius * 2.4);
      key.position.set(dist * 0.55, dist * 0.85, dist * 0.48);
    }
  }

  /** 释放本实例创建的资源（缓存的 envMap 不在此销毁） */
  dispose() {
    if (this.scene) {
      for (const l of this.lights) this.scene.remove(l);
    }
    for (const l of this.lights) l.dispose?.();
    this.lights = [];
    this.keyLight = null;
    this.scene = null;
  }
}

/** 生成（并缓存）柔和室内 IBL */
function getEnvMap(renderer) {
  if (_envMap) return _envMap;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const roomScene = new RoomEnvironment();
  _envMap = pmrem.fromScene(roomScene, 0.04).texture;
  roomScene.dispose();
  pmrem.dispose();
  return _envMap;
}

/** 整体卸载时释放缓存的 IBL */
export function disposeEnvMap() {
  _envMap?.dispose();
  _envMap = null;
}
