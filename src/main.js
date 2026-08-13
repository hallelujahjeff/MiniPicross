import "./style.css";
import { App } from "./App.js";

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

const app = new App(container);

// 用 async IIFE 而非顶层 await，避免对构建目标的额外要求
(async () => {
  try {
    await app.init();
    app.start();
    // 开发期暴露实例，便于控制台调试与自动化验收（生产构建不会包含）
    if (import.meta.env?.DEV) window.__picross = app;
  } catch (err) {
    console.error("[main] 初始化失败", err);
    showFatal(err?.stack || String(err));
  }
})();

// Vite HMR：热更新前释放 GPU 资源，避免反复重载堆积上下文
if (import.meta.hot) {
  import.meta.hot.dispose(() => app.dispose());
}
