/**
 * 选关界面（原生 DOM，瀑布流剪贴画）
 *
 * 视觉主题：手作剪贴簿——玩家每凿出一个造型，就像把一张"剪贴画"
 * 用 washi 胶带斜贴在软木板上，慢慢攒满一面收藏墙。
 *
 * 每个关卡是一张微微歪斜的卡片，状态分三种：
 *  - locked   未解锁：灰卡片 + 锁，点不动。解锁规则是按顺序——前一个通了才开下一个。
 *  - unlocked 已解锁未完成：大问号 + 星级难度。**不显示名称、不显示贴图**，
 *             在通关之前绝不剧透这个造型是什么。
 *  - completed 已完成：最终模型的离屏渲染贴图 + 名称（此时才揭示它是什么）。
 *
 * 星级来自 `meta.difficulty`（1..5，难度模型在裁剪时写入），五颗星越高越难。
 *
 * 关键细节：卡片旋转角、胶带颜色/位置都由关卡 id 的 hash 决定，
 * 这样每次刷新都长得一样（可复现），但关与关之间错落不同。
 */

import { loadLevel } from "../level/LevelLoader.js";
import { renderLevelThumbnail } from "../render/ThumbnailRenderer.js";

/** washi 胶带颜色（半透明，叠在卡纸上） */
const TAPE_COLORS = [
  "rgba(242,167,179,0.82)",
  "rgba(143,199,232,0.82)",
  "rgba(245,215,110,0.82)",
  "rgba(159,214,164,0.82)",
  "rgba(247,178,103,0.82)",
  "rgba(183,163,224,0.82)",
];

/** FNV-1a 字符串 hash，用作关卡 id 的确定性随机源 */
function hashOf(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class LevelSelect {
  /**
   * @param {HTMLElement} mount
   * @param {Object} options
   * @param {{id:string,name:string,difficulty:number,error?:Error|null}[]} options.levels
   * @param {(id:string) => void} options.onSelect
   */
  constructor(mount, options) {
    this.levels = options.levels;
    this.onSelect = options.onSelect;

    const root = document.createElement("div");
    root.className = "level-select";

    // ---------- 顶栏：标题 + 进度 ----------
    const head = document.createElement("header");
    head.className = "ls-head";
    const title = document.createElement("h1");
    title.className = "ls-title";
    title.textContent = "立体绘图方块";
    const sub = document.createElement("p");
    sub.className = "ls-sub";
    sub.textContent = "按顺序凿出每一个造型，把收藏墙填满";
    const progress = document.createElement("p");
    progress.className = "ls-progress";
    head.append(title, sub, progress);
    this.progress = progress;

    // ---------- 瀑布流卡片墙 ----------
    const wall = document.createElement("div");
    wall.className = "ls-wall";
    head.after?.(wall);

    root.append(head, wall);
    this.wall = wall;
    this.root = root;
    mount.appendChild(root);

    /** @type {Map<string, {el:HTMLButtonElement, id:string, index:number, completed:boolean, thumbRendered:boolean}>} */
    this.cards = new Map();
    this._completed = new Set();

    this._buildCards();
  }

  _buildCards() {
    this.wall.textContent = "";
    this.cards.clear();

    this.levels.forEach((lv, index) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "level-card";
      card.dataset.id = lv.id;

      // 确定性随机：旋转角 + 胶带
      const h = hashOf(lv.id);
      const rot = ((h % 50) - 25) / 10; // -2.5° ~ +2.4°
      const tapeColor = TAPE_COLORS[h % TAPE_COLORS.length];
      const tapeX = 26 + ((h >> 3) % 40); // 26% ~ 65%
      const tapeRot = -9 + ((h >> 6) % 18); // -9° ~ +8°
      card.style.setProperty("--rot", `${rot.toFixed(1)}deg`);
      card.style.setProperty("--tape-x", `${tapeX}%`);
      card.style.setProperty("--tape-rot", `${tapeRot}deg`);
      card.style.setProperty("--tape-color", tapeColor);

      // 胶带
      const tape = document.createElement("span");
      tape.className = "level-tape";
      card.appendChild(tape);

      // 序号（贴在卡片角落）
      const indexEl = document.createElement("span");
      indexEl.className = "level-index";
      indexEl.textContent = String(index + 1).padStart(2, "0");
      card.appendChild(indexEl);

      // 问号（未完成时显示）
      const question = document.createElement("span");
      question.className = "level-question";
      question.textContent = "?";
      card.appendChild(question);

      // 星级（实心/空心分开，便于分别上色）
      const stars = document.createElement("span");
      stars.className = "level-stars";
      const diff = Math.min(5, lv.difficulty ?? 1);
      const filled = document.createElement("span");
      filled.className = "level-stars-filled";
      filled.textContent = "★★★★★".slice(0, diff);
      const empty = document.createElement("span");
      empty.className = "level-stars-empty";
      empty.textContent = "☆☆☆☆☆".slice(diff);
      stars.append(filled, empty);
      card.appendChild(stars);

      // 贴图（完成后显示）
      const thumb = document.createElement("img");
      thumb.className = "level-thumb";
      thumb.alt = "";
      thumb.loading = "lazy";
      card.appendChild(thumb);

      // 名称（完成后显示）
      const name = document.createElement("span");
      name.className = "level-name";
      name.textContent = lv.name;
      card.appendChild(name);

      // 锁：扁平 SVG 图标（挂锁形状，不用 emoji），放在右下角角落，不挡问号
      const lock = document.createElement("span");
      lock.className = "level-lock";
      lock.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path class="lock-shackle" d="M7.5 10.5V7.5a4.5 4.5 0 0 1 9 0v3" />' +
        '<rect class="lock-body" x="4.5" y="10.5" width="15" height="10" rx="3" />' +
        '<circle class="lock-hole" cx="12" cy="14.6" r="1.4" />' +
        '<rect class="lock-slot" x="11.2" y="15.4" width="1.6" height="2.8" rx="0.8" />' +
        "</svg>";
      card.appendChild(lock);

      if (lv.error) {
        card.classList.add("is-broken");
        card.disabled = true;
      }

      card.addEventListener("click", () => {
        if (card.disabled) return;
        if (card.classList.contains("is-locked")) return;
        this.onSelect(lv.id);
      });

      this.wall.appendChild(card);
      this.cards.set(lv.id, {
        el: card,
        id: lv.id,
        index,
        completed: false,
        thumbRendered: false,
      });
    });
  }

  /**
   * 刷新进度（已完成集合变化后调用）
   * @param {Set<string>} completed 已完成关卡 id
   * @param {string} [flashId] 刚完成、需要播放入场闪烁的关卡 id
   */
  setCompleted(completed, flashId) {
    this._completed = completed;

    for (let i = 0; i < this.levels.length; i++) {
      const lv = this.levels[i];
      const rec = this.cards.get(lv.id);
      if (!rec) continue;

      const done = completed.has(lv.id);
      // 解锁：第一关始终解锁；其余需前一关已通
      const unlocked = i === 0 || completed.has(this.levels[i - 1].id);

      rec.el.classList.toggle("is-completed", done);
      rec.el.classList.toggle("is-locked", !done && !unlocked);

      // 移除上一次的闪烁标记，本次仅对 flashId 重新触发
      rec.el.classList.remove("just-completed");
      if (done && lv.id === flashId) {
        // 强制重排以重启动画
        void rec.el.offsetWidth;
        rec.el.classList.add("just-completed");
      }

      rec.completed = done;
    }

    this._updateProgress();
    this._renderThumbnails();
  }

  _updateProgress() {
    const total = this.levels.length;
    const done = this.levels.filter((lv) => this._completed.has(lv.id)).length;
    this.progress.textContent = `已收藏 ${done} / ${total} 个造型`;
  }

  /**
   * 对已完成且尚未渲染贴图的关卡，逐个异步渲染缩略图
   * （每个之间让出主线程，避免一次性渲染全部关卡造成卡顿）
   */
  async _renderThumbnails() {
    const pending = this.levels
      .map((lv) => this.cards.get(lv.id))
      .filter((rec) => rec && rec.completed && !rec.thumbRendered);

    for (const rec of pending) {
      await new Promise((r) => setTimeout(r, 0));
      try {
        const level = loadLevel(rec.id);
        const url = renderLevelThumbnail(level);
        if (url) {
          const img = rec.el.querySelector(".level-thumb");
          img.src = url;
          rec.thumbRendered = true;
        }
      } catch (err) {
        console.warn(`[LevelSelect] 关卡 ${rec.id} 缩略图渲染失败：${err.message}`);
      }
    }
  }

  show() {
    this.root.classList.remove("is-hidden");
  }

  hide() {
    this.root.classList.add("is-hidden");
  }

  dispose() {
    this.root.remove();
    this.cards.clear();
  }
}
