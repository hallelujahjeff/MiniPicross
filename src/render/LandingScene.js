import * as THREE from "three";
import { LANDING_MODELS, parseVoxels } from "./VoxelModels.js";

/**
 * 首页 3D 场景：旋转的体素模型 + 碎裂重组动画
 *
 * 视觉：半透明彩色体素 + 淡蓝线框（"技术力"发光感）+ 漂浮粒子 + 地面网格，
 * 深色背景衬托。整个体素组绕 Y 轴缓慢自转。
 *
 * ## 碎裂重组
 * 点击体素 → 当前模型的所有方块沿随机方向飞散（缩放归零、随机翻滚），
 * 片刻后下一个模型的方块从随机位置飞回、带交错延迟回弹重组。
 * 这就是"体素碎裂 → 重组为其他模型"。
 *
 * 用**槽位池 + 递增计数器**管理实例：飞散的旧方块不立刻回收 slot，
 * 计数器绕一圈回来时它们早已消失，天然避免新旧方块争抢同一槽位。
 */

const BOX = new THREE.BoxGeometry(1, 1, 1);

/** 碎裂阶段时长（秒） */
const SHATTER_DUR = 0.55;
/** 重组阶段时长（秒） */
const ASSEMBLE_DUR = 0.9;
/**
 * 重组时相邻体素的交错延迟（秒）
 *
 * 复杂模型有三四百个方块，若沿用固定 STAGGER，整段重组会拖到好几秒。
 * 因此实际延迟按方块数动态压缩（见 _applyModel），这里只是上限。
 */
const STAGGER_MAX = 0.012;
/** 整个重组阶段的交错总时长上限（秒）——保证大模型也不会拖沓 */
const STAGGER_TOTAL = 0.85;

/**
 * 模型在画面里占的比例
 *
 * 布局是"标题在上、模型居中、按钮在下"，上下各被文字占掉约 20%，
 * 中间留给模型的只有约 60%。所以这里取 0.5 而不是更大——
 * 早先用 0.62 时，高个子模型（城堡、火箭）的顶和底会直接压到标题与按钮上。
 */
const FRAME_FILL = 0.5;
/** 相机固定距离（不随模型变化，见 _fitGroup 的说明） */
const CAM_DIST = 20;
/** 模型缩放插值速度（每秒收敛比例） */
const FIT_LERP = 5.0;

const easeInCubic = (t) => t * t * t;
/** easeOutBack：重组末尾轻微回弹，更有"拼合"的弹性 */
function easeOutBack(t) {
  const c1 = 1.35;
  const c3 = c1 + 1;
  const p = t - 1;
  return 1 + c3 * p * p * p + c1 * p * p;
}

/**
 * 随机散布位置（以原点为球心，均匀方向）
 *
 * 半径按模型包围球缩放：小模型（兔子）散得近，大模型（城堡）散得远，
 * 否则碎片要么飞不出模型轮廓、要么冲出画面。
 * @param {THREE.Vector3} out
 * @param {number} radius 模型包围球半径
 */
function scatter(out, radius) {
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  const r = radius * (1.25 + Math.random() * 0.95);
  out.set(
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.sin(phi) * Math.sin(theta) * 0.7,
    r * Math.cos(phi),
  );
}

/** 随机单位轴 */
function randomAxis(out) {
  const theta = Math.random() * Math.PI * 2;
  const z = Math.random() * 2 - 1;
  const s = Math.sqrt(1 - z * z);
  out.set(s * Math.cos(theta), s * Math.sin(theta), z);
}

export class LandingScene {
  /**
   * @param {HTMLElement} container 挂载画布的容器
   * @param {{onMorph?:(index:number, name:string)=>void}} [options]
   */
  constructor(container, options = {}) {
    this.container = container;
    this.onMorph = options.onMorph;
    this.modelIndex = 0;
    this._morphing = false;

    this._initRenderer();
    this._initScene();
    this._buildLights();
    this._buildVoxelPool();
    this._buildParticles();
    this._buildGrid();
    this._bindEvents();

    this._applyModel(0, true);

    this._clock = new THREE.Clock();
    this._animate();
  }

  /* ===================== 初始化 ===================== */

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = "landing-canvas";
    this.container.appendChild(this.renderer.domElement);
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    this.camera.position.set(0, 0, CAM_DIST);
    this.camera.lookAt(0, 0, 0);

    /** 模型包围球半径（局部单位，驱动碎片散射距离） */
    this._radius = 6;
    /** 模型实际体素范围 [ex, ey, ez]（驱动取景） */
    this._extent = [7, 9, 5];
    /** 当前 / 目标缩放（换模型时平滑过渡） */
    this._fit = 1;
    this._fitTarget = 1;

    /** 体素组：整体自转 + 统一缩放 */
    this.group = new THREE.Group();
    // 初始给一个 3/4 视角：正对时体素模型会退化成一片"剪影"，认不出造型
    this.group.rotation.y = -0.62;
    this.scene.add(this.group);

    /**
     * 不可见的命中球（点击检测用）
     * 半径随模型变化，见 _applyModel —— 否则小模型要点很偏、大模型点不到边角。
     */
    this.hitSphere = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    this.group.add(this.hitSphere);

    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
  }

  /**
   * 自动取景：**缩放模型组**而不是移动相机
   *
   * 原来相机距离硬编码 14，模型一大就出画（兔子包围球半径 6.2，
   * 而 14 距离在 42° 竖直视野下只能容纳 5.4）。
   *
   * 修法上有两个选择，这里选了"缩放模型"：
   *  - 移动相机：不同模型的相机距离会从 28 变到 50，于是固定在世界坐标里的
   *    粒子云和地面网格相对模型忽大忽小，构图完全失控。
   *  - 缩放模型：相机、粒子、网格全都不动，**每个模型呈现的视觉大小完全一致**，
   *    构图稳定。碎片散射写在组局部空间里，缩放会一起生效，无需额外处理。
   *
   * ## 为什么不用包围球
   * 最初用"包围球半径"拟合，结果扁平模型（飞机 15×5×13）被那颗大球撑开，
   * 画面上反而显得很小——球的半径由最长的对角线决定，而飞机根本填不满球。
   * 改成**分别约束水平与竖直**：
   *  - 水平：模型绕 Y 自转，最坏情况的水平投影宽度是 XZ 平面的对角线 hypot(ex, ez)
   *  - 竖直：高度 ey（X 轴只有很小的固定倾角，已由 FRAME_FILL 的余量吸收）
   * 两个方向各算一个允许缩放，取较小者。这样宽扁的飞机会撑满宽度，
   * 高瘦的火箭会撑满高度，每个模型都用足画面。
   */
  _fitGroup() {
    const vFov = (this.camera.fov * Math.PI) / 180;
    const visibleH = 2 * CAM_DIST * Math.tan(vFov / 2);
    const visibleW = visibleH * this.camera.aspect;

    const [ex, ey, ez] = this._extent;
    const horizSpan = Math.hypot(ex, ez); // 自转一圈里最宽的投影
    const fitH = (visibleW * FRAME_FILL) / Math.max(0.001, horizSpan);
    const fitV = (visibleH * FRAME_FILL) / Math.max(0.001, ey);
    this._fitTarget = Math.min(fitH, fitV);
    this.camera.updateProjectionMatrix();
  }

  _buildLights() {
    this.scene.add(new THREE.AmbientLight(0x8a93a8, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(6, 9, 7);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x6f9bff, 0.9);
    rim.position.set(-7, -2, -6);
    this.scene.add(rim);
  }

  _buildVoxelPool() {
    const maxVoxels = LANDING_MODELS.reduce(
      (m, model) => Math.max(m, parseVoxels(model).length),
      0,
    );
    // 3 倍余量：飞散的旧方块与重组的新方块在时间上重叠，slot 循环复用
    this.capacity = Math.max(maxVoxels * 3, 256);

    this.solidMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.32,
      metalness: 0.12,
      transparent: true,
      opacity: 0.9,
    });
    this.wireMat = new THREE.MeshBasicMaterial({
      color: 0x8fd0ff,
      wireframe: true,
      transparent: true,
      opacity: 0.16,
    });

    this.solid = new THREE.InstancedMesh(BOX, this.solidMat, this.capacity);
    this.wire = new THREE.InstancedMesh(BOX, this.wireMat, this.capacity);
    this.solid.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.wire.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.solid.count = 0;
    this.wire.count = 0;

    this.group.add(this.solid, this.wire);

    /** @type {any[]} 所有动画项（含已完成的，惰性复用） */
    this.anims = [];
    /** 当前活跃（属于当前模型）的动画项 */
    this.activeAnims = [];
    this.nextSlot = 0;
    this._matrix = new THREE.Matrix4();
    this._quat = new THREE.Quaternion();
    this._pos = new THREE.Vector3();
    this._scale = new THREE.Vector3();
    this._axis = new THREE.Vector3();
    this._color = new THREE.Color();
  }

  _buildParticles() {
    const N = 180;
    const positions = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r = 6 + Math.random() * 8;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.6;
      positions[i * 3 + 2] = r * Math.cos(phi);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0x8fb8ff,
      size: 0.05,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    this.particles = new THREE.Points(geo, mat);
    this.scene.add(this.particles);
  }

  _buildGrid() {
    const grid = new THREE.GridHelper(30, 40, 0x4a5a7a, 0x2a3550);
    grid.position.y = -5.5;
    grid.material.transparent = true;
    grid.material.opacity = 0.25;
    this.scene.add(grid);
  }

  _bindEvents() {
    this._onResize = () => this._resize();
    window.addEventListener("resize", this._onResize);

    this._onPointerDown = (e) => this._handleClick(e);
    this.renderer.domElement.addEventListener("pointerdown", this._onPointerDown);

    this._resize();
  }

  _resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // 视野变了要重新取景：窄屏时水平方向会成为新的瓶颈
    this._fitGroup();
  }

  /* ===================== 模型切换 ===================== */

  _applyModel(idx, immediate) {
    const model = LANDING_MODELS[idx];
    const voxels = parseVoxels(model);
    if (voxels.length === 0) return;

    // 按**实际体素范围**（而不是声明的 size）算中心与尺寸：
    // 造型经常填不满声明的网格（飞机的机身只占中间几层），用 size 居中会偏，
    // 用 size 取景会偏小。
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const v of voxels) {
      if (v.x < minX) minX = v.x;
      if (v.y < minY) minY = v.y;
      if (v.z < minZ) minZ = v.z;
      if (v.x > maxX) maxX = v.x;
      if (v.y > maxY) maxY = v.y;
      if (v.z > maxZ) maxZ = v.z;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const extent = [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1];
    const radius = Math.hypot(extent[0], extent[1], extent[2]) / 2;

    // 旧模型飞散时用较大的半径，避免碎片突然改变散布尺度
    const scatterRadius = Math.max(this._radius, radius);
    this._radius = radius;
    this._extent = extent;
    this.hitSphere.scale.setScalar(radius * 0.9);
    this._fitGroup();

    // 交错延迟：方块多时按总时长上限压缩，保证大模型不拖沓
    const stagger = Math.min(STAGGER_MAX, STAGGER_TOTAL / Math.max(1, voxels.length));

    // 旧活跃体素 → 飞散
    if (!immediate) {
      for (const a of this.activeAnims) {
        a.from.copy(a.pos);
        scatter(a.to, scatterRadius);
        a.scaleFrom = a.scale;
        a.scaleTo = 0;
        a.rotFrom = 0;
        a.rotTo = (Math.random() * 2 - 1) * 6;
        randomAxis(a.axis);
        a.dur = SHATTER_DUR;
        a.delay = Math.random() * 0.08;
        a.t = -a.delay;
        a.ease = easeInCubic;
        a.active = true;
      }
    }

    // 新体素 → 重组（交错延迟，形成波浪）
    const palette = model.palette;
    const newAnims = voxels.map((v, i) => {
      const slot = this.nextSlot % this.capacity;
      this.nextSlot++;
      const anim = {
        slot,
        active: true,
        from: new THREE.Vector3(),
        to: new THREE.Vector3(),
        pos: new THREE.Vector3(),
        axis: new THREE.Vector3(),
        scale: 0,
        scaleFrom: 0,
        scaleTo: 1,
        rotFrom: (Math.random() * 2 - 1) * 6,
        rotTo: 0,
        dur: ASSEMBLE_DUR,
        delay: i * stagger,
        // 旧方块要先飞散，新方块整体推迟一个碎裂时长再开始拼合
        t: immediate ? Infinity : -(SHATTER_DUR * 0.55 + i * stagger),
        ease: easeOutBack,
        colorIdx: v.c,
      };
      scatter(anim.from, radius);
      // 用实际内容中心对齐到原点（不是网格中心）
      anim.to.set(v.x - cx, v.y - cy, v.z - cz);
      if (immediate) {
        anim.pos.copy(anim.to);
        anim.scale = 1;
      }
      randomAxis(anim.axis);
      // 写颜色
      this._color.set(palette[v.c] ?? palette[0]);
      this.solid.setColorAt(slot, this._color);
      return anim;
    });

    if (this.solid.instanceColor) this.solid.instanceColor.needsUpdate = true;

    // 回收已播完的动画项：每次 morph 都 push 新项，若不清理，长时间停在首页
    // 会让 anims 无限增长（每轮 5 个模型约 +1100 项），_update 的遍历成本
    // 随之线性上升。已经 !active 的项不再参与任何计算，可以直接丢掉。
    this.anims = this.anims.filter((a) => a.active);
    this.anims.push(...newAnims);
    this.activeAnims = newAnims;

    if (immediate) {
      // 直接写矩阵
      for (const a of newAnims) this._writeMatrix(a);
      this.solid.instanceMatrix.needsUpdate = true;
      this.wire.instanceMatrix.needsUpdate = true;
      // 首帧不做过渡，缩放直接落到目标值
      this._fit = this._fitTarget;
      this.group.scale.setScalar(this._fit);
    }

    /** 本次重组的总时长（含交错），morph 冷却用 */
    this._morphDuration =
      SHATTER_DUR * 0.55 + voxels.length * stagger + ASSEMBLE_DUR + 0.15;

    this.solid.count = this.capacity;
    this.wire.count = this.capacity;
  }

  /** 点击：切换到下一个模型（碎裂重组） */
  morph() {
    if (this._morphing) return;
    this._morphing = true;
    this.modelIndex = (this.modelIndex + 1) % LANDING_MODELS.length;
    this._applyModel(this.modelIndex, false);
    this.onMorph?.(this.modelIndex, LANDING_MODELS[this.modelIndex].name);
    // 等重组动画结束才允许再次点击（时长由 _applyModel 按方块数算出）
    setTimeout(
      () => {
        this._morphing = false;
      },
      (this._morphDuration ?? 1.6) * 1000,
    );
  }

  /* ===================== 交互 ===================== */

  _handleClick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this._raycaster.setFromCamera(this._pointer, this.camera);
    const hit = this._raycaster.intersectObject(this.hitSphere, false);
    if (hit.length > 0) this.morph();
  }

  /* ===================== 动画循环 ===================== */

  _writeMatrix(a) {
    this._pos.copy(a.pos);
    this._scale.setScalar(Math.max(0.0001, a.scale));
    this._quat.setFromAxisAngle(a.axis, a.rotFrom + (a.rotTo - a.rotFrom) * this._easeT(a));
    this._matrix.compose(this._pos, this._quat, this._scale);
    this.solid.setMatrixAt(a.slot, this._matrix);
    this.wire.setMatrixAt(a.slot, this._matrix);
  }

  /** 统一缓动查表（_writeMatrix 里复用以保证 quaternion 与 scale 同步） */
  _easeT(a) {
    return a.ease(Math.min(1, Math.max(0, a.t / a.dur)));
  }

  _update(dt) {
    let dirty = false;
    for (const a of this.anims) {
      if (!a.active) continue;
      a.t += dt;
      if (a.t >= a.dur) {
        a.active = false;
        a.pos.copy(a.to);
        a.scale = a.scaleTo;
        this._writeMatrix(a);
        dirty = true;
      } else if (a.t >= 0) {
        const k = this._easeT(a);
        a.pos.lerpVectors(a.from, a.to, k);
        a.scale = a.scaleFrom + (a.scaleTo - a.scaleFrom) * k;
        this._writeMatrix(a);
        dirty = true;
      }
    }
    if (dirty) {
      this.solid.instanceMatrix.needsUpdate = true;
      this.wire.instanceMatrix.needsUpdate = true;
    }
  }

  _animate = () => {
    this._raf = requestAnimationFrame(this._animate);
    const dt = Math.min(0.05, this._clock.getDelta());

    // 整体缓慢自转；X 轴恒定偏一点，让顶面始终可见（纯水平视角会显得很扁）
    this.group.rotation.y += dt * 0.32;
    this.group.rotation.x = 0.16 + Math.sin(performance.now() * 0.0004) * 0.07;

    // 粒子缓缓旋转
    this.particles.rotation.y -= dt * 0.02;

    // 缩放平滑逼近目标（不同模型尺寸差别大，硬切会很突兀）
    if (Math.abs(this._fit - this._fitTarget) > 0.0005) {
      this._fit += (this._fitTarget - this._fit) * Math.min(1, dt * FIT_LERP);
      this.group.scale.setScalar(this._fit);
    }

    this._update(dt);
    this.renderer.render(this.scene, this.camera);
  };

  /* ===================== 生命周期 ===================== */

  dispose() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener("resize", this._onResize);
    this.renderer.domElement.removeEventListener("pointerdown", this._onPointerDown);

    this.solid.geometry.dispose();
    this.wire.geometry.dispose();
    this.solidMat.dispose();
    this.wireMat.dispose();
    this.solid.dispose();
    this.wire.dispose();
    this.particles.geometry.dispose();
    this.particles.material.dispose();
    this.hitSphere.geometry.dispose();
    this.hitSphere.material.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
