import "./style.css";
import { App } from "./App.js";
import { LevelSelect } from "./ui/LevelSelect.js";
import { listLevels } from "./level/LevelLoader.js";
import { getCompletedLevels, markLevelCompleted } from "./ui/ProgressStore.js";

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

const app = new App(container);

// ---------- 选关界面 ----------
const levelSelect = new LevelSelect(selectMount, {
  levels: listLevels(),
  onSelect: (id) => enterLevel(id),
});

/** 用最新进度刷新选关墙；flashId 是刚通关、需要播闪烁的关卡 */
function refreshSelect(flashId) {
  levelSelect.setCompleted(getCompletedLevels(), flashId);
}

/** 从选关界面进入关卡 */
function enterLevel(id) {
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
  app.hide();
  app.endVictory();
  container.style.display = "none";
  levelSelect.show();
  // 刚完成的关卡播放入场闪烁
  refreshSelect(app.currentLevelId);
}

// 通关回调：立即持久化进度（解锁下一关）
app.onLevelSolved = (id) => {
  markLevelCompleted(id);
};
// 点"回到选关界面"回调
app.onExitLevel = () => exitToSelect();

// 用 async IIFE 而非顶层 await，避免对构建目标的额外要求
(async () => {
  try {
    await app.init();

    // 初始状态：选关界面（3D 暂不渲染）
    container.style.display = "none";
    refreshSelect();
    levelSelect.show();

    // 调试直达：?level=id 直接进入某关（跳过选关）
    const levelParam = new URLSearchParams(window.location.search).get("level");
    if (levelParam) enterLevel(levelParam);

    // 开发期暴露实例，便于控制台调试与自动化验收（生产构建不包含）
    if (import.meta.env?.DEV) {
      window.__picross = app;
      window.__select = levelSelect;
      window.__enterLevel = enterLevel;
      window.__exitToSelect = exitToSelect;
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
  });
}
