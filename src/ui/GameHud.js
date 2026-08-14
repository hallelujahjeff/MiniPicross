/**
 * 游戏 HUD（原生 DOM，不引框架）
 *
 * 按"关卡界面只保留必要信息"精简为四块：
 *  - 右上进度面板：进度条 + 完成行 / 失误，通关后出现"回到选关界面"按钮
 *  - 左下操作说明：一屏能看完的核心操作
 *  - 底部截面条：只在截面模式下出现
 *  - 通关演出：顶部模型名 + 底部冷知识 + 回到选关界面按钮
 *
 * 不显示关卡名称、不显示关卡选择、不显示谜面校验结论、不显示各类开关——
 * 这些要么属于选关界面，要么是调试内容。造型是什么、叫什么，只由玩家在
 * 凿开之后自己揭晓，通关演出才正式点名。
 */
export class GameHud {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.mount
   * @param {() => void} options.onResetSlice  恢复截面
   * @param {() => void} options.onDismissVictory 关闭通关演出
   * @param {() => void} options.onExit  回到选关界面
   */
  constructor(options) {
    this.onResetSlice = options.onResetSlice;
    this.onDismissVictory = options.onDismissVictory;
    this.onExit = options.onExit;

    const mount = options.mount;

    // ---------- 右上进度面板 ----------
    const root = document.createElement("div");
    root.className = "hud-panel";

    const progressWrap = document.createElement("div");
    progressWrap.className = "hud-progress";
    const progressFill = document.createElement("i");
    progressWrap.appendChild(progressFill);
    this.progressFill = progressFill;

    const stats = document.createElement("dl");
    stats.className = "hud-stats";
    this._rows = {};
    for (const [key, label] of [
      ["progress", "进度"],
      ["lines", "完成行"],
      ["mistakes", "失误"],
    ]) {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = "—";
      stats.append(dt, dd);
      this._rows[key] = dd;
    }

    // 回到选关界面（通关后显示）
    const exitBtn = document.createElement("button");
    exitBtn.type = "button";
    exitBtn.className = "hud-btn hud-exit";
    exitBtn.textContent = "回到选关界面";
    exitBtn.addEventListener("click", () => this.onExit());
    this.exitBtn = exitBtn;

    root.append(progressWrap, stats, exitBtn);
    mount.appendChild(root);
    this.root = root;

    // ---------- 左下操作说明 ----------
    // 文案随输入设备切换：触摸设备没有 Ctrl / 右键 / 滚轮，长按才是涂色。
    // 三个条件按可靠性排序：matchMedia 准确但 headless 模拟器可能不返回 true；
    // maxTouchPoints 在所有真实移动设备上 > 0；ontouchstart 是最古老的兜底。
    const isTouch =
      window.matchMedia?.("(pointer: coarse)").matches ||
      (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0) ||
      typeof window.ontouchstart !== "undefined";
    const help = document.createElement("div");
    help.className = "hud-help";
    help.innerHTML = isTouch
      ? "<b>点按</b> 凿除 &nbsp;·&nbsp; <b>长按</b> 涂色<br />" +
        "<b>单指拖</b> 转视角 &nbsp;·&nbsp; <b>双指</b> 缩放<br />" +
        "拖底部<b>滑块</b> 看内部 &nbsp;·&nbsp; <b>点空白</b> 退出"
      : "<b>左键</b> 凿除 &nbsp;·&nbsp; <b>Ctrl+左键</b> 标记<br />" +
        "<b>右键拖拽</b> 转视角 &nbsp;·&nbsp; <b>滚轮</b> 缩放<br />" +
        "拖底部<b>滑块</b> 看内部剖面 &nbsp;·&nbsp; <b>Esc</b> 恢复";
    mount.appendChild(help);
    this.help = help;

    // ---------- 通关演出：顶部模型名 + 底部冷知识 ----------
    const victoryTop = document.createElement("div");
    victoryTop.className = "victory-top";
    const victoryName = document.createElement("h1");
    const victorySub = document.createElement("p");
    victoryTop.append(victoryName, victorySub);
    mount.appendChild(victoryTop);
    this.victoryTop = victoryTop;
    this.victoryName = victoryName;
    this.victorySub = victorySub;

    const victoryBottom = document.createElement("div");
    victoryBottom.className = "victory-bottom";
    const triviaLabel = document.createElement("span");
    triviaLabel.className = "victory-trivia-label";
    triviaLabel.textContent = "冷知识";
    const triviaText = document.createElement("p");
    const victoryBtn = document.createElement("button");
    victoryBtn.className = "hud-btn hud-btn-inline";
    victoryBtn.type = "button";
    victoryBtn.textContent = "回到选关界面";
    victoryBtn.addEventListener("click", () => this.onExit());
    victoryBottom.append(triviaLabel, triviaText, victoryBtn);
    mount.appendChild(victoryBottom);
    this.victoryBottom = victoryBottom;
    this.triviaText = triviaText;

    this._onKeyDown = (e) => this._handleKey(e);
    window.addEventListener("keydown", this._onKeyDown);
    this._victoryVisible = false;
  }

  /** 键盘：Esc 先关演出，否则恢复截面（输入控件聚焦时不拦截） */
  _handleKey(e) {
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) {
      return;
    }
    if (e.key === "Escape") {
      if (this._victoryVisible) this.onDismissVictory();
      else this.onResetSlice();
    }
  }

  /**
   * 更新进度统计
   * @param {ReturnType<import("../puzzle/PuzzleModel.js").PuzzleModel["getStats"]>} stats
   */
  setStats(stats) {
    const pct = Math.round(stats.progress * 100);
    this._rows.progress.textContent = `${pct}%（剩 ${stats.remainingToRemove}）`;
    this._rows.lines.textContent = `${stats.completedLines} / ${stats.totalLines}`;
    this._rows.mistakes.textContent = String(stats.mistakes);
    this.progressFill.style.width = `${pct}%`;
    this.progressFill.classList.toggle("is-done", stats.solved);
  }

  /**
   * 展示通关演出：顶部模型名 + 底部冷知识
   * @param {{name:string, trivia:string}} level
   * @param {{mistakes:number, size:number[]}} stats
   */
  showVictory(level, stats) {
    this._victoryVisible = true;
    this.victoryName.textContent = level.name;
    this.victorySub.textContent =
      stats.mistakes === 0
        ? `${stats.size.join(" × ")} · 全程零失误，完美！`
        : `${stats.size.join(" × ")} · 失误 ${stats.mistakes} 次`;
    this.triviaText.textContent = level.trivia || "（这个造型还没有冷知识）";
    this.triviaText.classList.toggle("is-empty", !level.trivia);

    this.victoryTop.classList.add("is-visible");
    this.victoryBottom.classList.add("is-visible");
    this.root.classList.add("is-dimmed");
    this.help.classList.add("is-dimmed");
    // 通关后常驻"回到选关界面"入口（即使 Esc 关掉演出也找得到）
    this.exitBtn.classList.add("is-visible");
  }

  hideVictory() {
    this._victoryVisible = false;
    this.victoryTop.classList.remove("is-visible");
    this.victoryBottom.classList.remove("is-visible");
    this.root.classList.remove("is-dimmed");
    this.help.classList.remove("is-dimmed");
  }

  get victoryVisible() {
    return this._victoryVisible;
  }

  dispose() {
    window.removeEventListener("keydown", this._onKeyDown);
    this.root.remove();
    this.help.remove();
    this.victoryTop.remove();
    this.victoryBottom.remove();
  }
}
