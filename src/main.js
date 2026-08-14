import "./style.css";
import { App } from "./App.js";
import { LevelSelect } from "./ui/LevelSelect.js";
import { listLevels } from "./level/LevelLoader.js";
import { getCompletedLevels, markLevelCompleted } from "./ui/ProgressStore.js";
import { BgmPlayer } from "./audio/BgmPlayer.js";
import { LandingScene } from "./render/LandingScene.js";

/** 取不到挂载点时兜底创建，避免内嵌预览环境下容器缺失导致白屏 */
function ensureContainer(selector, id) {
  let el = document.querySelector(selector);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    document.body.appendChild(el);
  }
  return el;
}

/** 启动失败时在页面上给出可读提示（而不是只在控制台报错） */
function showFatal(message) {
  const box = document.createElement("div");
  box.className = "fatal-overlay";
  box.innerHTML = `<strong>启动失败</strong><pre></pre>`;
  box.querySelector("pre").textContent = message;
  document.body.appendChild(box);
}

const container = ensureContainer("#app", "app");
ensureContainer("#hud", "hud");
const selectMount = ensureContainer("#select", "select");
const landingMount = ensureContainer("#landing", "landing");

const app = new App(container);
const bgm = new BgmPlayer();

// ---------- 首页（体素雕塑） ----------
const landing = new LandingScene(landingMount, {
  onMorph: (index, name) => {
    // 碎裂重组时给一点视觉反馈（此处仅记录，避免过度设计）
  },
});

// ---------- 选关界面 ----------
const levelSelect = new LevelSelect(selectMount, {
  levels: listLevels(),
  onSelect: (id) => enterLevel(id),
});

/** 用最新进度刷新选关墙；flashId 是刚通关、需要播闪烁的关卡 */
function refreshSelect(flashId) {
  levelSelect.setCompleted(getCompletedLevels(), flashId);
}

/** 当前场景："landing" = 首页，"select" = 选关界面，"level" = 关卡内 */
let scene = "landing";
/** 用户是否已经有过一次手势（BGM 是否已解锁开播） */
let bgmUnlocked = false;

/** 播放当前场景对应的 BGM */
function playSceneBgm() {
  if (!bgmUnlocked) return;
  // 首页与选关界面共用舒缓组「微光」；关卡内切到轻快组
  if (scene === "level") bgm.playLevel();
  else bgm.playSelect();
}

/** 从首页进入选关界面 */
function enterSelect() {
  scene = "select";
  // 点"进入"按钮本身就是一个用户手势，直接解锁 BGM
  bgmUnlocked = true;
  bgm.unlock();
  bgm.playSelect();

  landingMount.classList.add("is-hidden");
  levelSelect.show();
}

/** 从选关界面进入关卡 */
function enterLevel(id) {
  scene = "level";
  bgmUnlocked = true;
  bgm.unlock();
  bgm.playLevel();

  levelSelect.hide();
  container.style.display = "block";
  app.show();
  app.loadLevel(id).catch((err) => {
    console.error(err);
    // 加载失败退回选关，避免卡在黑屏
    exitToSelect();
  });
}

/** 从关卡界面退回选关 */
function exitToSelect() {
  scene = "select";
  bgm.playSelect();

  app.hide();
  app.endVictory();
  container.style.display = "none";
  levelSelect.show();
  // 刚完成的关卡播放入场闪烁
  refreshSelect(app.currentLevelId);
}

// 首次交互：拉起 BGM。
// 浏览器自动播放策略要求 AudioContext 必须在**用户手势**里恢复，代码无法绕过
// （这是所有浏览器的安全设计，YouTube 等也受同样限制）。
// 因此这里监听尽可能多的"手势"事件——点击 / 按键 / 滚动 / 触摸，任何一个都算，
// 让 BGM 在用户做第一个动作的瞬间就响起，尽量贴近"自动播放"的体验。
const UNLOCK_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"];

function unlockBgm() {
  if (bgmUnlocked) return;
  bgmUnlocked = true;
  bgm.unlock();
  playSceneBgm();
  UNLOCK_EVENTS.forEach((ev) =>
    window.removeEventListener(ev, unlockBgm, { passive: true }),
  );
}
UNLOCK_EVENTS.forEach((ev) =>
  window.addEventListener(ev, unlockBgm, { passive: true }),
);

// 通关回调：立即持久化进度（解锁下一关）
app.onLevelSolved = (id) => {
  markLevelCompleted(id);
};
// 点"回到选关界面"回调
app.onExitLevel = () => exitToSelect();

// "进入游戏"按钮 → 首页隐藏，进入选关界面
document.getElementById("enterBtn")?.addEventListener("click", enterSelect);

// 用 async IIFE 而非顶层 await，避免对构建目标的额外要求
(async () => {
  try {
    await app.init();

    // 初始状态：首页展示（体素雕塑），游戏 3D 与选关界面暂隐藏
    container.style.display = "none";
    levelSelect.hide();
    refreshSelect();

    // 调试直达：?level=id 直接进入某关（跳过首页与选关）
    const levelParam = new URLSearchParams(window.location.search).get("level");
    if (levelParam) {
      landingMount.classList.add("is-hidden");
      enterLevel(levelParam);
    }

    // 开发期暴露实例，便于控制台调试与自动化验收（生产构建不包含）
    if (import.meta.env?.DEV) {
      window.__picross = app;
      window.__select = levelSelect;
      window.__landing = landing;
      window.__enterLevel = enterLevel;
      window.__enterSelect = enterSelect;
      window.__exitToSelect = exitToSelect;
      window.__bgm = bgm;
    }
  } catch (err) {
    console.error("[main] 初始化失败", err);
    showFatal(err?.stack || String(err));
  }
})();

// Vite HMR：热更新前释放 GPU 资源，避免反复重载堆积上下文
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    app.dispose();
    levelSelect.dispose();
    landing.dispose();
    bgm.dispose();
  });
}
