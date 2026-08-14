import * as THREE from "three";
import { coordsOf, gridToWorld, CELL } from "../core/GridCoords.js";
import {
  FACE_NX,
  FACE_PX,
  FACE_NY,
  FACE_PY,
  FACE_NZ,
  FACE_PZ,
  FACE_NORMALS,
} from "../puzzle/HintFaces.js";
import {
  getHintAtlas,
  atlasCellIndex,
  atlasCellUv,
  ATLAS_COLS,
  ATLAS_ROWS,
} from "./HintAtlas.js";

/**
 * 提示数字的渲染（印在方块表面的贴花）
 *
 * 全部提示由**一个 InstancedMesh** 绘制 → 1 个 draw call：
 *  - 几何体是一张单位平面，靠实例矩阵摆到对应方块的对应面上
 *  - 数字内容靠**每实例 UV 偏移**从图集里取对应格（见 HintAtlas）
 *
 * 材质用 MeshBasicMaterial + onBeforeCompile 注入两个实例属性，
 * 而不是从零写 ShaderMaterial：这样色彩空间转换、tone mapping、雾
 * 这些 three 内置管线依然生效，不会出现"数字颜色和场景不在一个色彩空间"的问题。
 *
 * 遮挡靠深度测试自然解决（贴花只生成在**朝外无遮挡**的面上，
 * 被别的方块挡住时会被方块的深度值剔掉），因此
 * `depthTest: true` + `depthWrite: false` 是正确组合：
 * 既不会穿透显示，也不会因为写深度而互相打架。
 */

/** 贴花相对方块面的外移量：足够避免 z-fighting，又不至于看出"浮起来" */
const FACE_OFFSET = 0.009;
/** 贴花边长（方块圆角后平整区域约 0.83，取 0.78 刚好落在平面内） */
const DECAL_SIZE = 0.78;

/** 墨色基调：暖调深灰，比纯黑更像印在陶瓷上的釉字 */
const INK_COLOR = 0x4a4238;

/**
 * 压淡参数（"这条线已推完、这些方块确定要敲掉"的提示）
 *  - DIM_SHADE：墨色明度乘数，让数字明显"退后"一档
 *  - DIM_ALPHA：透明度乘数，略透出方块底色，读作"已失效的线索"
 */
const DIM_SHADE = 0.42;
const DIM_ALPHA = 0.6;

/**
 * 各面的墨色明度系数
 * 背光面（底面、-X、-Z）的方块本身更暗，墨色要相应提亮才读得清；
 * 迎光面则用足黑度。数值范围刻意收窄，避免六个面看起来像六种颜色。
 */
const FACE_SHADE = new Float32Array(6);
FACE_SHADE[FACE_NX] = 1.08;
FACE_SHADE[FACE_PX] = 1.0;
FACE_SHADE[FACE_NY] = 1.22;
FACE_SHADE[FACE_PY] = 0.94;
FACE_SHADE[FACE_NZ] = 1.12;
FACE_SHADE[FACE_PZ] = 0.97;

/** 六个面的朝向四元数：把平面默认法线 +Z 转到面法线，并保证数字正立 */
const FACE_QUATERNIONS = (() => {
  const HALF = Math.PI / 2;
  const euler = [
    [0, -HALF, 0], // -X
    [0, HALF, 0], // +X
    [HALF, 0, 0], // -Y
    [-HALF, 0, 0], // +Y
    [0, Math.PI, 0], // -Z
    [0, 0, 0], // +Z
  ];
  return euler.map((e) =>
    new THREE.Quaternion().setFromEuler(new THREE.Euler(e[0], e[1], e[2])),
  );
})();

/** 换关时提示淡入时长（秒） */
const FADE_DURATION = 0.3;

export class HintRenderer {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = "HintRoot";
    // 贴花必须在方块之后画（依赖方块已经写好的深度）
    this.group.renderOrder = 2;

    /** @type {THREE.InstancedMesh|null} */
    this.mesh = null;
    /** @type {THREE.PlaneGeometry|null} */
    this.geometry = null;
    /** @type {THREE.MeshBasicMaterial|null} */
    this.material = null;
    /** @type {THREE.InstancedBufferAttribute|null} */
    this.cellUvAttr = null;
    /** @type {THREE.InstancedBufferAttribute|null} */
    this.shadeAttr = null;
    /** @type {THREE.InstancedBufferAttribute|null} */
    this.dimAttr = null;

    this.grid = null;
    this.visibleCount = 0;

    this._matrix = new THREE.Matrix4();
    this._pos = new THREE.Vector3();
    this._scale = new THREE.Vector3(DECAL_SIZE, DECAL_SIZE, DECAL_SIZE);
    this._coord = { x: 0, y: 0, z: 0 };
    this._world = { x: 0, y: 0, z: 0 };
    this._uv = { u: 0, v: 0 };

    this._fade = { active: false, time: 0 };
    this._enabled = true;
    this._suppressed = false;
  }

  /**
   * 为一个关卡建立贴花网格
   * @param {import("../core/GridCoords.js").Grid} grid
   * @param {number} capacity 贴花容量（见 HintFaces.hintFaceCapacity）
   * @param {THREE.WebGLRenderer} renderer 用于取各向异性上限
   */
  build(grid, capacity, renderer) {
    this.dispose();
    this.grid = grid;

    const atlas = getHintAtlas(renderer);

    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.geometry.setAttribute(
      "aCellUv",
      new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2),
    );
    this.geometry.setAttribute(
      "aShade",
      new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1),
    );
    this.geometry.setAttribute(
      "aDim",
      new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1),
    );
    this.cellUvAttr = this.geometry.getAttribute("aCellUv");
    this.shadeAttr = this.geometry.getAttribute("aShade");
    this.dimAttr = this.geometry.getAttribute("aDim");
    this.cellUvAttr.setUsage(THREE.DynamicDrawUsage);
    this.shadeAttr.setUsage(THREE.DynamicDrawUsage);
    this.dimAttr.setUsage(THREE.DynamicDrawUsage);

    this.material = createHintMaterial(atlas.texture);

    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    mesh.name = "HintDecals";
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = true;
    mesh.renderOrder = 2;
    // 手动包围球：贴花始终贴在造型表面，用造型包围球外扩一格即可
    const half = new THREE.Vector3(grid.W, grid.H, grid.D).multiplyScalar(CELL / 2);
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), half.length() + 1);

    this.mesh = mesh;
    this.group.add(mesh);
    this.visibleCount = 0;
    return mesh;
  }

  /** 换关时的淡入 */
  startFadeIn() {
    if (!this.material) return;
    this._fade.active = true;
    this._fade.time = 0;
    this.material.opacity = 0;
  }

  /** 提示总开关（玩家在 HUD 里控制） */
  setEnabled(flag) {
    this._enabled = flag;
    this._applyVisibility();
  }

  get enabled() {
    return this._enabled;
  }

  /**
   * 临时压制提示（通关演出用）
   *
   * 与 setEnabled 分开是为了不覆盖玩家自己的开关状态：
   * 演出结束后恢复的是玩家原本的选择，而不是"演出前刚好可见"。
   */
  setSuppressed(flag) {
    this._suppressed = flag;
    this._applyVisibility();
  }

  _applyVisibility() {
    this.group.visible = this._enabled && !this._suppressed;
  }

  /**
   * 按贴花列表重建全部实例
   *
   * 凿除 / 拖动截面 / 涂色（压淡）都会调用；上限 6000 个实例（10³ 关卡）的
   * 重写是纯 TypedArray 写入，远比"维护增量差异"简单且不易出错，
   * 实测成本在 0.5ms 量级，可以忽略。
   *
   * @param {import("../puzzle/HintFaces.js").HintFaceList} list
   */
  rebuild(list) {
    if (!this.mesh) return 0;

    const n = Math.min(list.length, this.mesh.instanceMatrix.count);
    const uvArr = this.cellUvAttr.array;
    const shadeArr = this.shadeAttr.array;
    const dimArr = this.dimAttr.array;

    for (let i = 0; i < n; i++) {
      const block = list.blocks[i];
      const face = list.faces[i];

      coordsOf(this.grid, block, this._coord);
      gridToWorld(this.grid, this._coord.x, this._coord.y, this._coord.z, this._world);

      const normal = FACE_NORMALS[face];
      const push = CELL / 2 + FACE_OFFSET;
      this._pos.set(
        this._world.x + normal[0] * push,
        this._world.y + normal[1] * push,
        this._world.z + normal[2] * push,
      );
      this._matrix.compose(this._pos, FACE_QUATERNIONS[face], this._scale);
      this.mesh.setMatrixAt(i, this._matrix);

      atlasCellUv(atlasCellIndex(list.values[i], list.marks[i]), this._uv);
      uvArr[i * 2] = this._uv.u;
      uvArr[i * 2 + 1] = this._uv.v;
      shadeArr[i] = FACE_SHADE[face];
      dimArr[i] = list.dims[i];
    }

    this.mesh.count = n;
    this.visibleCount = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.cellUvAttr.needsUpdate = true;
    this.shadeAttr.needsUpdate = true;
    this.dimAttr.needsUpdate = true;
    return n;
  }

  /** @param {number} delta 秒 */
  update(delta) {
    if (!this._fade.active || !this.material) return;
    this._fade.time += delta;
    const t = Math.min(1, this._fade.time / FADE_DURATION);
    this.material.opacity = t;
    if (t >= 1) this._fade.active = false;
  }

  /** 渲染统计（HUD 用） */
  getStats() {
    const shown = this.mesh && this.visibleCount > 0 && this._enabled && !this._suppressed;
    return {
      drawCalls: shown ? 1 : 0,
      decals: this.visibleCount,
      capacity: this.mesh ? this.mesh.instanceMatrix.count : 0,
    };
  }

  /** 释放本关资源（图集为共享资源，不在此销毁） */
  dispose() {
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.dispose();
      this.mesh = null;
    }
    this.geometry?.dispose();
    this.material?.dispose();
    this.geometry = null;
    this.material = null;
    this.cellUvAttr = null;
    this.shadeAttr = null;
    this.dimAttr = null;
    this.grid = null;
    this.visibleCount = 0;
    this._fade.active = false;
  }
}

/**
 * 贴花材质：MeshBasicMaterial + 三个实例属性
 *
 *  - aCellUv：该实例在图集里的格子原点，配合常量缩放取到对应数字
 *  - aShade ：该面的墨色明度系数
 *  - aDim   ：是否压淡（0 = 正常，1 = 压淡）
 */
function createHintMaterial(atlasTexture) {
  const material = new THREE.MeshBasicMaterial({
    color: INK_COLOR,
    map: atlasTexture,
    transparent: true,
    // 深度测试要开（被方块挡住时不该看见），深度写入要关（贴花不参与遮挡别人）
    depthTest: true,
    depthWrite: false,
    // 图集大部分区域是全透明的，先 discard 掉能省下大量混合与排序麻烦
    alphaTest: 0.05,
    side: THREE.FrontSide,
    toneMapped: true,
  });
  material.name = "HintDecal";

  const cellU = (1 / ATLAS_COLS).toFixed(8);
  const cellV = (1 / ATLAS_ROWS).toFixed(8);
  const dimShade = DIM_SHADE.toFixed(6);
  const dimAlpha = DIM_ALPHA.toFixed(6);

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        attribute vec2 aCellUv;
        attribute float aShade;
        attribute float aDim;
        varying float vShade;
        varying float vDim;`,
      )
      .replace(
        "#include <uv_vertex>",
        `#include <uv_vertex>
        // 把 [0,1] 的平面 UV 映射到图集里那一格
        vMapUv = aCellUv + vMapUv * vec2( ${cellU}, ${cellV} );
        vShade = aShade;
        vDim = aDim;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying float vShade;
        varying float vDim;`,
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        // 压淡：明度与透明度一并压低，读作"这条线已经推完，这些方块确定要敲"
        diffuseColor.rgb *= vShade * mix(1.0, ${dimShade}, vDim);
        diffuseColor.a *= mix(1.0, ${dimAlpha}, vDim);`,
      );
  };
  // 注入过的 shader 必须有独立缓存键，否则会和普通 MeshBasicMaterial 撞程序缓存
  material.customProgramCacheKey = () => "picross-hint-decal-v2";

  return material;
}
