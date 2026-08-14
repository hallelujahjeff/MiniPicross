import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SceneEnvironment, disposeEnvMap } from "./render/SceneEnvironment.js";
import { PuzzleRenderer } from "./render/PuzzleRenderer.js";
import { HintRenderer } from "./render/HintRenderer.js";
import { ShardBurst } from "./render/ShardBurst.js";
import { SliceHandles } from "./render/SliceHandles.js";
import { LineHighlight } from "./render/LineHighlight.js";
import { VictoryCinematic } from "./render/VictoryCinematic.js";
import {
  disposeAssets,
  INSTANCE_COLOR_MISTAKE,
  INSTANCE_COLOR_BLOCKED,
  INSTANCE_COLOR_CONFIRM,
} from "./render/BlockAssets.js";
import { disposeHintAtlas } from "./render/HintAtlas.js";
import { PuzzleModel } from "./puzzle/PuzzleModel.js";
import { SliceRange } from "./puzzle/SliceRange.js";
import { HintFaceList, collectHintFaces, hintFaceCapacity } from "./puzzle/HintFaces.js";
import { analyzePuzzle } from "./puzzle/PuzzleSolver.js";
import {
  listLevels,
  loadLevel as loadLevelData,
  validateAllLevels,
} from "./level/LevelLoader.js";
import { GameHud } from "./ui/GameHud.js";
import { SoundKit } from "./audio/SoundKit.js";
import { InteractionController } from "./input/InteractionController.js";

/**
 * 应用装配层
 *
 * 一关的完整链路：
 *   LevelLoader（模板解析：造型 + 提示 + 隐藏掩码 + 配色 + 冷知识）
 *     → PuzzleModel（整数坐标系 + TypedArray 状态 + 整行完成判定）
 *     → PuzzleRenderer（单 InstancedMesh 画方块）
 *     + HintRenderer  （单 InstancedMesh 画表面数字）
 *     + SliceHandles  （截面拖动条）
 *     + ShardBurst    （碎裂特效）
 *     + LineHighlight （整行完成描边）
 *
 * 三个"可见性"来源汇聚到同一处：模型的 REMOVED 位、SliceRange 的剖切范围，
 * 最终都体现为 `PuzzleRenderer.blockToSlot[block] >= 0`。
 * 提示贴花与鼠标拾取都直接读它，因此不可能出现"看得见却点不到"这类割裂。
 *
 * URL 参数：
 *   ?debug=1  显示网格/坐标轴辅助
 *   ?audit=1  启动时把全部内置关卡的谜面校验结果打到控制台
 *   ?level=id 指定初始关卡
 */

const PARAMS = new URLSearchParams(window.location.search);
const DEBUG = PARAMS.has("debug");
const AUDIT = PARAMS.has("audit");

/** 整行完成时，沿线依次亮起的单格间隔（秒） */
const CONFIRM_STAGGER = 0.045;
/** 上色高光的时长（含"保持"段，用来等描边特效放完） */
const CONFIRM_FLASH_DURATION = 0.62;
/** 通关时全模型上色的逐层间隔（秒） */
const VICTORY_STAGGER = 0.02;

export class App {
  constructor(container) {
    this.container = container;

    this.scene = new THREE.Scene();

    const { width, height } = this._measure();
    this.camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
    this.camera.position.set(9, 8, 12);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.container.appendChild(this.renderer.domElement);

    this.environment = new SceneEnvironment();
    this.puzzleRenderer = new PuzzleRenderer();
    this.hintRenderer = new HintRenderer();
    this.shards = new ShardBurst();
    this.sliceHandles = new SliceHandles();
    this.lineHighlight = new LineHighlight();
    this.cinematic = new VictoryCinematic();

    // 数字/碎片/手柄/描边都挂在造型根节点下，这样换关的整体缩放过场是一致的，
    // 不会出现"方块缩没了、数字还留在原地"。
    this.puzzleRenderer.group.add(
      this.hintRenderer.group,
      this.shards.group,
      this.sliceHandles.group,
      this.lineHighlight.group,
    );
    this.scene.add(this.puzzleRenderer.group);

    this.sound = new SoundKit();

    /** @type {PuzzleModel|null} */
    this.puzzle = null;
    /** @type {SliceRange|null} */
    this.slice = null;
    /** @type {GameHud|null} */
    this.hud = null;
    /** @type {HintFaceList|null} */
    this._hintFaces = null;
    /** 上次重建提示贴花时的可见性版本号 */
    this._hintVisVersion = -1;
    /** 上次重建提示贴花时的谜题进度版本号（涂色/整行完成会推进它） */
    this._hintRevision = -1;
    /** 当前关卡的谜面校验结论 */
    this.analysis = null;
    /** 是否直接展示"造型解"（把非解方块一次性凿除，用于校验模板解析） */
    this.reveal = false;
    /** 并发保护：只有最后一次 loadLevel 生效 */
    this._loadToken = 0;
    /** 通关演出中：禁用玩法输入与轨道控制 */
    this.victory = false;
    /** 通关回调（由外部协调层设置）：完成一关时通知 */
    this.onLevelSolved = null;
    /** 退出回调（由外部协调层设置）：点"回到选关界面"时调用 */
    this.onExitLevel = null;
    /** 关卡是否正在展示（由外部协调层控制渲染循环启停） */
    this._visible = false;

    this._tmpVec = new THREE.Vector3();
    this._statsTimer = 0;

    this._setupHelpers();
    this._setupControls();
    this._setupInteraction();
    this._bindEvents();

    this.clock = new THREE.Clock();
    this._animate = this._animate.bind(this);
  }

  /** 异步初始化：环境光照 + HUD + 载入首关 */
  async init() {
    this.environment.applyTo(this.scene, this.renderer);

    // 启动自检：一次性校验全部模板，坏模板不阻塞启动。
    // 必须先自检再取清单，否则清单快照里的 error 字段还是空的，
    // HUD 无法把坏模板标灰禁选。
    const { ok, failed } = validateAllLevels();
    if (failed.length > 0) {
      console.error(
        `[App] ${failed.length} 个关卡模板校验失败：\n` +
          failed.map((f) => `  - ${f.id}: ${f.message}`).join("\n"),
      );
    }
    if (DEBUG) {
      console.info(
        `[App] 关卡自检通过 ${ok.length} 个：\n` +
          ok
            .map(
              (l) =>
                `  - ${l.id} ${l.size.join("×")} 实心 ${l.solidCount} 解 ${l.solutionCount}`,
            )
            .join("\n"),
      );
    }
    if (AUDIT) this._auditLevels();

    const levels = listLevels();
    if (levels.length === 0) {
      throw new Error("没有找到任何关卡模板（src/level/levels/*.json）");
    }

    const mount = document.querySelector("#hud") ?? document.body;
    this.hud = new GameHud({
      mount,
      onResetSlice: () => this.resetSlice(),
      onDismissVictory: () => this.endVictory(),
      onExit: () => this.onExitLevel?.(this.currentLevelId),
    });

    // 不再自动加载关卡：初始入口是选关界面，由外部协调层调用 enterLevel。
    // ?level=id 仅作为调试直达入口（外部协调层会处理）。
    return this;
  }

  /**
   * 载入并渲染一个关卡（可重复调用，自动释放上一关资源）
   * @param {string} id
   */
  async loadLevel(id) {
    const token = ++this._loadToken;
    this.endVictory();

    if (this.puzzleRenderer.mesh) {
      this.sliceHandles.setVisible(false);
      await new Promise((resolve) => {
        const d = this.puzzleRenderer.startDisappear(resolve);
        if (d === 0) resolve();
      });
      if (token !== this._loadToken) return;
    }

    let level;
    try {
      level = loadLevelData(id);
    } catch (err) {
      console.error(`[App] 关卡 ${id} 加载失败：${err.message}`);
      // 旧造型此刻已被淡出缩到接近 0，若不复位画面会像黑屏
      this.puzzleRenderer.group.scale.setScalar(1);
      throw err;
    }

    this._applyLevel(level, id);
    return level;
  }

  /**
   * 把一份 LevelData 装配成可玩的一关
   * @param {import("./level/LevelParser.js").LevelData} level
   * @param {string} id
   */
  _applyLevel(level, id) {
    this.puzzle = new PuzzleModel(level);
    this.slice = new SliceRange(level.grid);

    this.puzzleRenderer.build(this.puzzle, this.slice);

    // 提示贴花：容量有紧上界（每个格子最多 6 个），一次分配够用到通关
    this._hintFaces = new HintFaceList(hintFaceCapacity(level.grid));
    this.hintRenderer.build(level.grid, this._hintFaces.capacity, this.renderer);
    this.hintRenderer.startFadeIn();
    this._hintVisVersion = -1;
    this._hintRevision = -1;

    this.sliceHandles.build(level.grid, this.slice);
    this.sliceHandles.setVisible(true);
    this.lineHighlight.build(level.grid);
    this.shards.clear();

    this.environment.fitToGrid(level.grid);
    this._frameCamera();

    // 谜面校验：验证"含隐藏掩码之后"依然无需猜测。这是一道重要防线——
    // 如果有人改了造型却忘了重跑 --prune，隐藏掩码会失配，这里立刻报出来。
    this.analysis = analyzePuzzle(level.grid, level.solution, { hints: level.hints });
    if (!this.analysis.ok) {
      console.warn(
        `[App] 关卡 ${id} 的谜面不合格：${this.analysis.message}\n` +
          "如果最近改过造型，请重新跑 `npm run prune:levels` 重算 hiddenHints。",
      );
    }

    if (this.reveal) this._applyReveal();

    this.currentLevelId = id;
    this.hud?.setSlice(this.slice);
    this._refreshStats();

    if (DEBUG) {
      const s = this.puzzle.getStats();
      const r = this.puzzleRenderer.getRenderStats();
      const h = this.analysis.difficulty.metrics.hints;
      console.info(
        `[App] 已载入关卡 ${id}：${s.size.join("×")}，实例 ${r.instances}/${r.capacity}，` +
          `三角面 ${r.triangles}，draw call ${r.drawCalls}，` +
          `提示 可见${h.shown}(含 0 ${h.zero}) 隐藏${h.hidden}，` +
          `难度 ${this.analysis.difficulty.score.toFixed(2)}，校验 ${this.analysis.verdict}`,
      );
    }
  }

  /** 敲击一个方块（左键） */
  chisel(block) {
    if (!this.puzzle || this.victory) return;
    const alreadySolved = this.puzzle.isSolved();
    const { result, solved } = this.puzzle.chisel(block);

    if (result === "broken") {
      // 碎片位置只取决于格坐标，与可见性无关，所以先算位置再让渲染层隐藏方块
      this.puzzleRenderer.getBlockWorldPosition(block, this._tmpVec);
      this.shards.burst(this._tmpVec);
      this.sound.playBreak();
    } else if (result === "mistake") {
      this.puzzleRenderer.flashBlock(block, INSTANCE_COLOR_MISTAKE, { bounce: 0.07 });
      this.sound.playMistake();
    } else if (result === "blocked") {
      this.puzzleRenderer.flashBlock(block, INSTANCE_COLOR_BLOCKED, { bounce: 0.03 });
      this.sound.playBlocked();
    } else {
      return;
    }

    this._playCompletedLines();
    this._refreshStats();
    if (solved && !alreadySolved) this._onSolved();
  }

  /** 切换标记（Ctrl + 左键） */
  togglePaint(block) {
    if (!this.puzzle || this.victory) return;
    const { result } = this.puzzle.togglePaint(block);
    if (result === "painted") this.sound.playPaint();
    else if (result === "unpainted") this.sound.playUnpaint();
    else if (result === "mistake") {
      // 涂到"应该敲掉"的方块上：和敲错完全一样的反馈
      this.puzzleRenderer.flashBlock(block, INSTANCE_COLOR_MISTAKE, { bounce: 0.07 });
      this.sound.playMistake();
    } else if (result === "locked") {
      // 已确认的方块不能再改，给一个"点不动"的反馈
      this.puzzleRenderer.flashBlock(block, INSTANCE_COLOR_BLOCKED, { bounce: 0.02 });
      this.sound.playBlocked();
    } else {
      return;
    }

    this._playCompletedLines();
    this._refreshStats();
  }

  /**
   * 播放"整行完成"的反馈
   *
   * 两层叠加：
   *  1. 沿这一行画一道线框描边（LineHighlight），把注意力精准拉到这一行；
   *  2. 这一行的方块**依次**闪一下高光再落到最终配色——延迟按线上顺序递增，
   *     读起来就是"描边扫过去，颜色跟着亮起来"。
   * 模型那边已经把状态改成 CONFIRMED，所以高光褪去后自然停在配色上。
   */
  _playCompletedLines() {
    const lines = this.puzzle.drainCompletedLines();
    if (lines.length === 0) return;

    for (const line of lines) {
      this.lineHighlight.play(line.axis, line.cells);
      line.cells.forEach((cell, i) => {
        this.puzzleRenderer.flashBlock(cell, INSTANCE_COLOR_CONFIRM, {
          bounce: 0.05,
          delay: i * CONFIRM_STAGGER,
          duration: CONFIRM_FLASH_DURATION,
          shape: "sweep",
        });
      });
    }
    this.sound.playLineClear(lines.length);
  }

  /** 剖切范围变化后的统一收尾 */
  onSliceChanged() {
    this.puzzleRenderer.rebuildVisible();
    this.sliceHandles.syncFromSlice();
    this.hud?.setSlice(this.slice);
    this.sound.playSlice();
  }

  /** 退出截面模式，恢复完整显示 */
  resetSlice() {
    if (!this.slice) return;
    if (this.slice.reset()) {
      this.puzzleRenderer.rebuildVisible();
      this.sliceHandles.syncFromSlice();
    }
    this.hud?.setSlice(this.slice);
  }

  /**
   * 切换"显示造型解"
   *  - 开启：把所有非解方块凿除（走 forceRemove，不计失误、不受标记保护）
   *  - 关闭：重新载入关卡恢复实心初始态
   * @param {boolean} flag
   */
  setReveal(flag) {
    this.reveal = flag;
    if (!this.puzzle) return;

    if (flag) {
      this._applyReveal();
      this._refreshStats();
    } else if (this.currentLevelId) {
      this.loadLevel(this.currentLevelId).catch((err) => console.error(err));
    }
  }

  /** 凿除全部非解方块，并立即同步一次渲染层 */
  _applyReveal() {
    const solution = this.puzzle.solution;
    for (let i = 0; i < solution.length; i++) {
      if (solution[i] === 0) this.puzzle.forceRemove(i);
    }
    this.puzzle.drainCompletedLines(); // 工具路径不播特效
    this.puzzleRenderer.syncFromModel();
  }

  /**
   * 通关演出：全模型上色 → 环绕推进镜头 → 顶部模型名 + 底部冷知识
   *
   * 上色按 y 自下而上分批延迟，形成"从脚下往上填色"的一道波，
   * 时间上正好和镜头开始环绕重合。
   */
  _onSolved() {
    this.victory = true;
    // 立即记录进度（不等演出），外部协调层据此解锁下一关
    this.onLevelSolved?.(this.currentLevelId);

    // 演出要看完整造型，先把截面复位
    if (this.slice?.reset()) {
      this.puzzleRenderer.rebuildVisible();
      this.sliceHandles.syncFromSlice();
    }
    this.sliceHandles.setVisible(false);
    // 演出要展示"造型本身"，把表面数字与拖动条一起收起来
    this.hintRenderer.setSuppressed(true);
    this.puzzle.drainCompletedLines();

    // 还没被"整行完成"覆盖到的方块，这里一次性确认上色
    const cells = this.puzzle.confirmAll();
    this.puzzle.drainCompletedLines();
    cells.forEach((cell, i) => {
      this.puzzleRenderer.flashBlock(cell, INSTANCE_COLOR_CONFIRM, {
        bounce: 0.04,
        delay: i * VICTORY_STAGGER,
        duration: CONFIRM_FLASH_DURATION,
        shape: "sweep",
      });
    });
    this.puzzleRenderer.setHover(-1);
    this.puzzleRenderer.syncFromModel();

    this.controls.enabled = false;
    this.interaction.enabled = false;
    const { radius } = this.puzzleRenderer.getBounds();
    this.cinematic.start(this.camera, this.controls.target, radius * 1.15);

    this.hud?.showVictory(
      { name: this.puzzle.level.name, trivia: this.puzzle.level.trivia },
      this.puzzle.getStats(),
    );
    this.sound.playWin();
    this._refreshStats();
  }

  /** 结束通关演出，把镜头与操作交还玩家 */
  endVictory() {
    if (!this.victory) return;
    this.victory = false;
    this.cinematic.stop();
    this.hud?.hideVictory();
    this.hintRenderer.setSuppressed(false);
    this.sliceHandles.setVisible(true);
    this.controls.enabled = true;
    this.interaction.enabled = true;
    // 演出把相机挪走了，把 OrbitControls 的内部状态同步到当前位置
    this.controls.update();
  }

  /** 刷新 HUD 统计 */
  _refreshStats() {
    if (!this.puzzle) return;
    this.hud?.setStats(this.puzzle.getStats(), {
      drawCalls:
        this.puzzleRenderer.getRenderStats().drawCalls +
        this.hintRenderer.getStats().drawCalls +
        this.shards.getStats().drawCalls +
        this.lineHighlight.getStats().drawCalls,
    });
  }

  /**
   * 提示贴花在"可见集合"或"谜题进度"变化后重算
   *
   * 两个触发源缺一不可：
   *  - 凿除、拖动截面会改变可见集合（PuzzleRenderer.visibilityVersion）；
   *  - 纯涂色、整行完成不改变可见性，却会改变压淡/隐藏判定
   *    （PuzzleModel.hintRevision）。
   * 靠两个版本号比较可以避免每帧无意义地重扫全部线。
   */
  _maybeRebuildHints() {
    if (!this.puzzle || !this._hintFaces) return;
    const visVersion = this.puzzleRenderer.visibilityVersion;
    const hintRevision = this.puzzle.hintRevision;
    if (visVersion === this._hintVisVersion && hintRevision === this._hintRevision) return;
    this._hintVisVersion = visVersion;
    this._hintRevision = hintRevision;

    collectHintFaces(
      this.puzzle.grid,
      this.puzzle.hints,
      this.puzzle,
      this.puzzleRenderer.blockToSlot,
      this._hintFaces,
    );
    if (this._hintFaces.overflow > 0) {
      console.error(
        `[App] 提示贴花容量不足，丢弃 ${this._hintFaces.overflow} 个（容量公式有误）`,
      );
    }
    this.hintRenderer.rebuild(this._hintFaces);
  }

  /** ?audit=1：把全部内置关卡的谜面校验结果打到控制台 */
  _auditLevels() {
    const rows = [];
    for (const entry of listLevels()) {
      if (entry.error) {
        rows.push({ 关卡: entry.id, 结论: "解析失败", 说明: entry.error.message });
        continue;
      }
      const level = loadLevelData(entry.id);
      const t0 = performance.now();
      const a = analyzePuzzle(level.grid, level.solution, { hints: level.hints });
      const h = a.difficulty.metrics.hints;
      rows.push({
        关卡: entry.id,
        尺寸: `${level.grid.W}×${level.grid.H}×${level.grid.D}`,
        解: level.solutionCount,
        结论: a.ok ? "无需猜测" : a.verdict,
        难度: `${a.difficulty.score.toFixed(2)} ${a.difficulty.label}`,
        波次: a.difficulty.metrics.waves,
        可见提示: `裸${h.plain}/圆${h.circle}/方${h.square}/零${h.zero}`,
        隐藏提示: `${h.hidden}/${h.total}`,
        耗时: `${(performance.now() - t0).toFixed(1)}ms`,
      });
    }
    console.table(rows);
  }

  /** 根据关卡包围球自动取景，保持当前观察方向 */
  _frameCamera() {
    const { center, radius } = this.puzzleRenderer.getBounds();
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const distance = (radius / Math.sin(fov / 2)) * 1.35;

    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0.7, 0.6, 1);
    dir.normalize();

    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, distance);
    // 近裁面固定取小值，保证拉近观察时不会切掉方块；远裁面按包围球外扩
    this.camera.near = 0.1;
    this.camera.far = distance + radius * 10 + 50;
    this.camera.updateProjectionMatrix();

    this.controls.minDistance = radius * 0.75;
    this.controls.maxDistance = distance * 3;
    this.controls.update();
  }

  _setupHelpers() {
    if (!DEBUG) return;
    this._helpers = new THREE.Group();
    this._helpers.add(new THREE.GridHelper(20, 20, 0x444444, 0x2a2a2a));
    this._helpers.add(new THREE.AxesHelper(3));
    this.scene.add(this._helpers);
  }

  _setupControls() {
    const controls = new OrbitControls(this.camera, this.renderer.domElement);

    // 观察中心恒定为造型中心（世界原点），禁止平移
    controls.target.set(0, 0, 0);
    controls.enablePan = false;

    controls.enableDamping = true;
    controls.dampingFactor = 0.075;

    controls.rotateSpeed = 0.85;
    controls.zoomSpeed = 0.9;

    controls.minDistance = 3;
    controls.maxDistance = 60;

    controls.minPolarAngle = 0.05;
    controls.maxPolarAngle = Math.PI - 0.05;

    // 右键旋转，滚轮/中键缩放，左键交给凿除/标记/拖截面
    controls.mouseButtons = {
      LEFT: null,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.ROTATE,
    };
    controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_ROTATE,
    };

    controls.update();
    this.controls = controls;
  }

  _setupInteraction() {
    this.interaction = new InteractionController({
      domElement: this.renderer.domElement,
      camera: this.camera,
      puzzleRenderer: this.puzzleRenderer,
      sliceHandles: this.sliceHandles,
      getSlice: () => this.slice,
      onChisel: (block) => this.chisel(block),
      onPaint: (block) => this.togglePaint(block),
      onSliceChange: () => this.onSliceChanged(),
      // 浏览器要求音频在用户手势里启动，第一次按下时顺手解锁
      onGesture: () => this.sound.unlock(),
    });
  }

  _bindEvents() {
    // 基于容器尺寸自适应（比监听 window 更稳，兼容内嵌预览与布局变化）
    if (typeof ResizeObserver !== "undefined") {
      this._resizeObserver = new ResizeObserver(() => this._onResize());
      this._resizeObserver.observe(this.container);
    }
    this._onWindowResize = () => this._onResize();
    window.addEventListener("resize", this._onWindowResize);

    // 存成字段以便 dispose 时解绑
    this._onContextMenu = (e) => e.preventDefault();
    this.renderer.domElement.addEventListener("contextmenu", this._onContextMenu);
  }

  /** 容器尺寸（对 0 尺寸做兜底，避免内嵌预览时出现 NaN aspect） */
  _measure() {
    const rect = this.container?.getBoundingClientRect?.();
    const width = Math.max(1, Math.floor(rect?.width || window.innerWidth || 1));
    const height = Math.max(1, Math.floor(rect?.height || window.innerHeight || 1));
    return { width, height };
  }

  _onResize() {
    const { width, height } = this._measure();
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
  }

  /** 展示关卡：重新测量尺寸 + 开始渲染循环（选关界面切换到关卡界面时调用） */
  show() {
    this._visible = true;
    // 从 display:none 恢复后尺寸可能还是 0，先同步一次测量
    this._onResize();
    this.start();
  }

  /** 隐藏关卡：停止渲染循环（回到选关界面时调用） */
  hide() {
    this._visible = false;
    this.stop();
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.clock.start();
    this._animate();
  }

  stop() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
  }

  _animate() {
    if (!this._running) return;
    this._raf = requestAnimationFrame(this._animate);
    const delta = Math.min(this.clock.getDelta(), 0.1);
    this.update(delta);
    this.renderer.render(this.scene, this.camera);
  }

  update(delta) {
    if (this.victory) this.cinematic.update(delta, this.camera);
    else this.controls.update(delta);

    this.puzzleRenderer.update(delta);
    // 可见集合可能刚被 puzzleRenderer 改过，紧接着重算提示
    this._maybeRebuildHints();
    this.hintRenderer.update(delta);
    this.shards.update(delta);
    this.lineHighlight.update(delta);
    if (!this.victory) {
      this.sliceHandles.update(this.camera);
      this.interaction.update();
    }
    // draw call / 碎片数这类统计会随动画变化，按低频刷新即可
    this._statsTimer += delta;
    if (this._statsTimer >= 0.35) {
      this._statsTimer = 0;
      this._refreshStats();
    }
  }

  /** 释放全部资源（HMR / 卸载用） */
  dispose() {
    this.stop();
    this._resizeObserver?.disconnect();
    window.removeEventListener("resize", this._onWindowResize);
    this.renderer.domElement.removeEventListener("contextmenu", this._onContextMenu);
    this.interaction?.dispose();
    this.controls?.dispose();
    this.hud?.dispose();
    this.sound.dispose();
    this.lineHighlight.dispose();
    this.sliceHandles.dispose();
    this.shards.dispose();
    this.hintRenderer.dispose();
    this.puzzleRenderer.dispose();
    this.scene.remove(this.puzzleRenderer.group);
    this.environment.dispose();
    // 共享资源只在应用整体卸载时回收（切关不会走到这里）
    disposeAssets();
    disposeHintAtlas();
    disposeEnvMap();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
