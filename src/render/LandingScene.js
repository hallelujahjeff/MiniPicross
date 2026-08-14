import * as THREE from "three";
import { createGrid, gridToWorld } from "../core/GridCoords.js";
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
/** 重组时相邻体素的交错延迟（秒） */
const STAGGER = 0.012;
/** 碎片飞散的半径范围 */
const SCATTER_MIN = 4;
const SCATTER_MAX = 8;

const easeInCubic = (t) => t * t * t;
/** easeOutBack：重组末尾轻微回弹，更有"拼合"的弹性 */
function easeOutBack(t) {
  const c1 = 1.35;
  const c3 = c1 + 1;
  const p = t - 1;
  return 1 + c3 * p * p * p + c1 * p * p;
}

/** 随机散布位置（以原点为球心，均匀方向） */
function scatter(out) {
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  const r = SCATTER_MIN + Math.random() * (SCATTER_MAX - SCATTER_MIN);
  out.set(
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.sin(phi) * Math.sin(theta) * 0.7 + 1.5,
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
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.camera.position.set(0, 0, 14);
    this.camera.lookAt(0, 0, 0);

    /** 体素组：整体自转 */
    this.group = new THREE.Group();
    this.scene.add(this.group);

    /** 不可见的命中球（点击检测用） */
    this.hitSphere = new THREE.Mesh(
      new THREE.SphereGeometry(5.2, 12, 12),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    this.group.add(this.hitSphere);

    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
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
    this.camera.updateProjectionMatrix();
  }

  /* ===================== 模型切换 ===================== */

  _applyModel(idx, immediate) {
    const model = LANDING_MODELS[idx];
    const grid = createGrid(model.size);
    const voxels = parseVoxels(model);
    this._grid = grid;

    // 旧活跃体素 → 飞散
    if (!immediate) {
      for (const a of this.activeAnims) {
        a.from.copy(a.pos);
        scatter(a.to);
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
        delay: i * STAGGER,
        t: immediate ? Infinity : -i * STAGGER,
        ease: easeOutBack,
        colorIdx: v.c,
      };
      scatter(anim.from);
      gridToWorld(grid, v.x, v.y, v.z, anim.to);
      if (immediate) {
        anim.pos.copy(anim.to);
        anim.scale = 1;
      }
      // 写颜色
      this._color.set(palette[v.c] ?? palette[0]);
      this.solid.setColorAt(slot, this._color);
      return anim;
    });

    if (immediate) {
      // 直接写矩阵
      for (const a of newAnims) this._writeMatrix(a);
      this.solid.instanceMatrix.needsUpdate = true;
      this.wire.instanceMatrix.needsUpdate = true;
    }

    this.anims.push(...newAnims);
    this.activeAnims = newAnims;
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
    // 等重组动画结束才允许再次点击
    setTimeout(() => {
      this._morphing = false;
    }, (ASSEMBLE_DUR + SHATTER_DUR + this.activeAnims.length * STAGGER + 0.2) * 1000);
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

    // 整体缓慢自转
    this.group.rotation.y += dt * 0.35;
    this.group.rotation.x = Math.sin(performance.now() * 0.0004) * 0.12;

    // 粒子缓缓旋转
    this.particles.rotation.y -= dt * 0.02;

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
