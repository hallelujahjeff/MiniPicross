/**
 * 游戏 HUD（原生 DOM，不引框架）
 *
 * 四块内容：
 *  - 右上角面板：关卡选择、进度/失误统计、谜面校验结论、各类开关
 *  - 底部条：**只在截面模式下出现**，显示当前剖切范围并提供"恢复"按钮
 *  - 顶部标题 + 底部冷知识：**通关演出**时出现，配合环绕推进镜头
 *  - 其余时间画面保持干净，不遮挡造型
 *
 * 所有开关都配了键盘快捷键，便于自动化验收时绕过 DOM 直接驱动。
 */
export class GameHud {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.mount
   * @param {{id:string,name:string,error:Error|null}[]} options.levels
   * @param {(id:string) => void} options.onSelect
   * @param {(reveal:boolean) => void} options.onToggleReveal
   * @param {(show:boolean) => void} options.onToggleHints
   * @param {(on:boolean) => void} options.onToggleSound
   * @param {() => void} options.onResetSlice
   * @param {() => void} options.onDismissVictory
   */
  constructor(options) {
    this.levels = options.levels;
    this.onSelect = options.onSelect;
    this.onToggleReveal = options.onToggleReveal;
    this.onToggleHints = options.onToggleHints;
    this.onToggleSound = options.onToggleSound;
    this.onResetSlice = options.onResetSlice;
    this.onDismissVictory = options.onDismissVictory;

    const mount = options.mount;

    // ---------- 右上角面板 ----------
    const root = document.createElement("div");
    root.className = "hud-panel";

    const title = document.createElement("div");
    title.className = "hud-title";
    title.textContent = "立体绘图方块";

    const select = document.createElement("select");
    select.className = "hud-select";
    for (const lv of this.levels) {
      const opt = document.createElement("option");
      opt.value = lv.id;
      opt.textContent = lv.error ? `${lv.name}（格式错误）` : lv.name;
      opt.disabled = Boolean(lv.error);
      select.appendChild(opt);
    }
    select.addEventListener("change", () => this.onSelect(select.value));
    this.select = select;

    // 进度条
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
      ["painted", "标记"],
      ["size", "尺寸"],
      ["draw", "Draw Call"],
      ["fps", "FPS"],
    ]) {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = "—";
      stats.append(dt, dd);
      this._rows[key] = dd;
    }

    const verdict = document.createElement("div");
    verdict.className = "hud-verdict";
    verdict.textContent = "—";
    this.verdict = verdict;

    const toggles = document.createElement("div");
    toggles.className = "hud-toggles";
    this.hintsInput = this._addCheck(toggles, "显示提示数字（H）", true, (v) =>
      this.onToggleHints(v),
    );
    this.soundInput = this._addCheck(toggles, "音效（M）", true, (v) =>
      this.onToggleSound(v),
    );
    this.revealInput = this._addCheck(toggles, "显示造型解（R）", false, (v) =>
      this.onToggleReveal(v),
    );

    const hint = document.createElement("div");
    hint.className = "hud-hint";
    hint.innerHTML =
      "<b>左键</b>敲除 · <b>Ctrl+左键</b>标记<br />" +
      "<b>右键拖拽</b>转视角 · <b>滚轮</b>缩放<br />" +
      "拖底部<b>蓝色滑块</b>看内部剖面 · <b>Esc</b> 恢复<br />" +
      "整行推完会<b>亮一下并上色</b>，且不能再改";

    root.append(title, select, progressWrap, stats, verdict, toggles, hint);
    mount.appendChild(root);
    this.root = root;

    // ---------- 底部截面条 ----------
    const sliceBar = document.createElement("div");
    sliceBar.className = "slice-bar";
    const sliceText = document.createElement("span");
    sliceText.className = "slice-bar-text";
    const sliceBtn = document.createElement("button");
    sliceBtn.className = "hud-btn hud-btn-inline";
    sliceBtn.type = "button";
    sliceBtn.textContent = "恢复完整显示（Esc）";
    sliceBtn.addEventListener("click", () => this.onResetSlice());
    sliceBar.append(sliceText, sliceBtn);
    mount.appendChild(sliceBar);
    this.sliceBar = sliceBar;
    this.sliceText = sliceText;

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
    victoryBtn.textContent = "结束展示（Esc）";
    victoryBtn.addEventListener("click", () => this.onDismissVictory());
    victoryBottom.append(triviaLabel, triviaText, victoryBtn);
    mount.appendChild(victoryBottom);
    this.victoryBottom = victoryBottom;
    this.triviaText = triviaText;

    this._onKeyDown = (e) => this._handleKey(e);
    window.addEventListener("keydown", this._onKeyDown);

    // FPS 采样
    this._frames = 0;
    this._elapsed = 0;
    this._fps = 0;
    this._victoryVisible = false;
  }

  /** 键盘快捷键（输入控件聚焦时不拦截） */
  _handleKey(e) {
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) {
      return;
    }
    const key = e.key;

    if (key === "Escape") {
      // 演出中优先关演出，否则恢复截面
      if (this._victoryVisible) this.onDismissVictory();
      else this.onResetSlice();
      return;
    }
    if (key === "r" || key === "R") {
      this._toggle(this.revealInput, this.onToggleReveal);
      return;
    }
    if (key === "h" || key === "H") {
      this._toggle(this.hintsInput, this.onToggleHints);
      return;
    }
    if (key === "m" || key === "M") {
      this._toggle(this.soundInput, this.onToggleSound);
      return;
    }

    const n = Number(key);
    if (!Number.isInteger(n) || n < 1 || n > 9) return;
    const lv = this.levels[n - 1];
    if (!lv || lv.error) return;
    this.select.value = lv.id;
    this.onSelect(lv.id);
  }

  _toggle(input, cb) {
    input.checked = !input.checked;
    cb(input.checked);
  }

  _addCheck(parent, text, checked, cb) {
    const label = document.createElement("label");
    label.className = "hud-check";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", () => cb(input.checked));
    const span = document.createElement("span");
    span.textContent = text;
    label.append(input, span);
    parent.appendChild(label);
    return input;
  }

  /** 同步"显示造型解"勾选态 */
  setReveal(flag) {
    if (this.revealInput.checked !== flag) this.revealInput.checked = flag;
  }

  /** 同步下拉框选中项 */
  setCurrent(id) {
    if (this.levels.some((lv) => lv.id === id)) this.select.value = id;
  }

  /**
   * 每帧调用，节流刷新 FPS
   * @param {number} delta 秒
   */
  tick(delta) {
    this._frames++;
    this._elapsed += delta;
    if (this._elapsed >= 0.35) {
      this._fps = Math.round(this._frames / this._elapsed);
      this._frames = 0;
      this._elapsed = 0;
      this._rows.fps.textContent = String(this._fps);
    }
  }

  /**
   * 更新关卡与渲染统计
   * @param {ReturnType<import("../puzzle/PuzzleModel.js").PuzzleModel["getStats"]>} stats
   * @param {{drawCalls:number}} render
   */
  setStats(stats, render) {
    const pct = Math.round(stats.progress * 100);
    this._rows.progress.textContent = `${pct}%（剩 ${stats.remainingToRemove}）`;
    this._rows.lines.textContent = `${stats.completedLines} / ${stats.totalLines}`;
    this._rows.mistakes.textContent = String(stats.mistakes);
    this._rows.painted.textContent = `${stats.painted}（锁定 ${stats.confirmed}）`;
    this._rows.size.textContent = stats.size.join(" × ");
    this._rows.draw.textContent = String(render.drawCalls);
    this.progressFill.style.width = `${pct}%`;
    this.progressFill.classList.toggle("is-done", stats.solved);
  }

  /**
   * 展示谜面校验结论
   * @param {{ok:boolean, verdict:string, message:string,
   *          difficulty:{score:number,label:string,metrics:object}}|null} analysis
   */
  setAnalysis(analysis) {
    if (!analysis) {
      this.verdict.textContent = "—";
      this.verdict.className = "hud-verdict";
      this.verdict.title = "";
      return;
    }
    const d = analysis.difficulty;
    const h = d.metrics.hints;
    const mark = analysis.ok ? "✓" : "⚠";
    this.verdict.textContent =
      `${mark} ${analysis.ok ? "无需猜测" : "需要猜测"} · ` +
      `难度 ${d.label} ${d.score.toFixed(2)} · 隐藏提示 ${h.hidden}/${h.total}`;
    this.verdict.className = `hud-verdict ${analysis.ok ? "is-ok" : "is-warn"}`;
    this.verdict.title =
      `${analysis.message}\n` +
      `可见提示：数字 ${h.numbered} 个、0 ${h.zero} 个；整行隐藏 ${h.hidden} 个。\n` +
      "空白的面表示这一行的提示被故意藏起来了，需要从另两个轴推出来。";
  }

  /**
   * 更新底部截面条
   * @param {import("../puzzle/SliceRange.js").SliceRange} slice
   */
  setSlice(slice) {
    const active = Boolean(slice?.active) && !this._victoryVisible;
    this.sliceBar.classList.toggle("is-visible", active);
    if (active) {
      this.sliceText.textContent = `截面模式：${slice.describe()}（另一个轴已锁定）`;
    }
  }

  /**
   * 展示通关演出：顶部模型名 + 底部冷知识
   * @param {{name:string, trivia:string}} level
   * @param {{mistakes:number, painted:number, size:number[]}} stats
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
    // 演出期间把操作面板与截面条让出画面
    this.root.classList.add("is-dimmed");
    this.sliceBar.classList.remove("is-visible");
  }

  hideVictory() {
    this._victoryVisible = false;
    this.victoryTop.classList.remove("is-visible");
    this.victoryBottom.classList.remove("is-visible");
    this.root.classList.remove("is-dimmed");
  }

  get victoryVisible() {
    return this._victoryVisible;
  }

  /** 展示关卡加载失败原因 */
  setError(message) {
    this.verdict.textContent = `✗ 加载失败：${message}`;
    this.verdict.className = "hud-verdict is-warn";
    this.verdict.title = message;
  }

  dispose() {
    window.removeEventListener("keydown", this._onKeyDown);
    this.root.remove();
    this.sliceBar.remove();
    this.victoryTop.remove();
    this.victoryBottom.remove();
  }
}
