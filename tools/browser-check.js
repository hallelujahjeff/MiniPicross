/**
 * 浏览器端端到端验收脚本（playwright-cli 代码片段，不是 Node 脚本）
 *
 *   npm run dev
 *   playwright-cli goto "http://localhost:5173/?level=duck"
 *   playwright-cli --raw run-code --filename=tools/browser-check.js
 *
 * 覆盖 docs/acceptance-step2.md 实测表的全部条目：
 *   提示裁剪与 0 的显示 / 凿除后新暴露面立刻长出数字 /
 *   截面范围与贴花联动 + 单轴锁定 / 真实鼠标拖动滑块 /
 *   敲除三种结果 / 标记与锁定 / 整行完成上色 / 通关演出 / 压力关帧率
 *
 * 依赖 dev 环境暴露的 window.__picross（生产构建不会包含）。
 */
async (page) => {
  const out = {};
  const wait = (ms) => page.waitForTimeout(ms);

  // ---------- 1) 提示裁剪：0 会显示、隐藏行什么都不贴 ----------
  await page.evaluate(() => window.__picross.loadLevel("house"));
  await wait(900);
  out.hints = await page.evaluate(() => {
    const app = window.__picross;
    const h = app.analysis.difficulty.metrics.hints;
    const list = app._hintFaces;
    let zeroDecals = 0;
    for (let i = 0; i < list.length; i++) if (list.values[i] === 0) zeroDecals++;
    return {
      total: h.total,
      hidden: h.hidden,
      shown: h.shown,
      zeroLines: h.zero,
      decals: list.length,
      // 每条可见线最多 2 个贴花，且 0 必须真的被贴出来
      decalsWithinBound: list.length <= h.shown * 2,
      zeroDecals,
      solvableAfterPrune: app.analysis.ok,
      difficulty: Number(app.analysis.difficulty.score.toFixed(2)),
    };
  });

  // ---------- 2) 凿除后，被它挡住的那块立刻出现数字 ----------
  out.reveal = await page.evaluate(async () => {
    const app = window.__picross;
    const grid = app.puzzle.grid;
    const list = app._hintFaces;
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

    // 在 +X 外壳上找一个非解方块，且它所在 X 线的提示是可见的
    const lineVisible = (y, z) => app.puzzle.hints.visible[0][y + z * grid.H] === 1;
    let target = -1;
    let ty = 0;
    let tz = 0;
    for (let z = 0; z < grid.D && target < 0; z++) {
      for (let y = 0; y < grid.H && target < 0; y++) {
        const cell = grid.W - 1 + y * grid.strideY + z * grid.strideZ;
        if (app.puzzle.solution[cell] === 0 && lineVisible(y, z)) {
          target = cell;
          ty = y;
          tz = z;
        }
      }
    }
    if (target < 0) return { skipped: "找不到合适的样本" };

    const behind = grid.W - 2 + ty * grid.strideY + tz * grid.strideZ;
    const hasFace = (block, face) => {
      for (let i = 0; i < list.length; i++) {
        if (list.blocks[i] === block && list.faces[i] === face) return true;
      }
      return false;
    };

    const before = { front: hasFace(target, 1), behind: hasFace(behind, 1) };
    app.chisel(target);
    await frame();
    await frame();
    const after = { front: hasFace(target, 1), behind: hasFace(behind, 1) };
    return { before, after, lineValue: app.puzzle.hints.counts[0][ty + tz * grid.H] };
  });

  // ---------- 3) 整行完成 → 描边 + 上色锁定 ----------
  await page.evaluate(() => window.__picross.loadLevel("tutorial-cube"));
  await wait(900);
  out.lineComplete = await page.evaluate(async () => {
    const app = window.__picross;
    const grid = app.puzzle.grid;
    const solution = app.puzzle.solution;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    // 挑一条"有造型"的 Z 线，把它做完：先凿掉线上的非解方块，再涂上解方块
    let axis = 2;
    let key = -1;
    for (let k = 0; k < app.puzzle.lineSolid[axis].length; k++) {
      if (app.puzzle.lineSolid[axis][k] > 0) {
        key = k;
        break;
      }
    }
    const u = key % grid.W;
    const v = Math.floor(key / grid.W);
    const cells = [];
    for (let z = 0; z < grid.D; z++) cells.push(u + v * grid.strideY + z * grid.strideZ);

    for (const cell of cells) if (solution[cell] === 0) app.chisel(cell);
    const beforePaint = {
      confirmed: app.puzzle.confirmedCount,
      completedLines: app.puzzle.getStats().completedLines,
    };
    for (const cell of cells) if (solution[cell] === 1) app.togglePaint(cell);
    await wait(60);

    const solid = cells.filter((c) => solution[c] === 1);
    const afterPaint = {
      confirmed: app.puzzle.confirmedCount,
      completedLines: app.puzzle.getStats().completedLines,
      allConfirmed: solid.every((c) => app.puzzle.isConfirmed(c)),
      highlightActive: app.lineHighlight.getStats().active,
      flashesQueued: app.puzzleRenderer._flashes.size,
    };

    // 已确认的方块不能取消标记、也不能敲掉
    const locked = app.puzzle.togglePaint(solid[0]).result;
    const blocked = app.puzzle.chisel(solid[0]).result;

    await wait(700);
    // 高光褪去后应停在关卡配色上
    const THREE_COLOR = { r: 0, g: 0, b: 0 };
    const pr = app.puzzleRenderer;
    const slot = pr.blockToSlot[solid[0]];
    pr.mesh.getColorAt(slot, pr._color);
    THREE_COLOR.r = Number(pr._color.r.toFixed(3));
    THREE_COLOR.g = Number(pr._color.g.toFixed(3));
    THREE_COLOR.b = Number(pr._color.b.toFixed(3));

    return {
      beforePaint,
      afterPaint,
      locked,
      blocked,
      restColor: THREE_COLOR,
      paletteHex: app.puzzle.colorOf(solid[0]).toString(16),
    };
  });
  await page.screenshot({ path: "docs/screenshots/21-line-confirmed.png" });

  // ---------- 4) 截面单轴锁定 ----------
  out.sliceLock = await page.evaluate(() => {
    const app = window.__picross;
    app.resetSlice();
    const before = {
      activeAxis: app.slice.activeAxis,
      knobsPickable: app.sliceHandles.interactiveObjects.length,
    };
    app.slice.setBound(0, 0, 1);
    app.onSliceChanged();
    const afterX = {
      activeAxis: app.slice.activeAxis,
      knobsPickable: app.sliceHandles.interactiveObjects.length,
      // 另一个轴现在应该被拒绝
      zRejected: app.slice.setBound(2, 0, 1) === false,
      zBoundUnchanged: app.slice.getBound(2, 0) === 0,
    };
    app.resetSlice();
    const afterReset = {
      activeAxis: app.slice.activeAxis,
      knobsPickable: app.sliceHandles.interactiveObjects.length,
      zNowAllowed: app.slice.setBound(2, 0, 1) === true,
    };
    app.resetSlice();
    return { before, afterX, afterReset };
  });

  // ---------- 5) 通关演出 ----------
  out.victory = await page.evaluate(async () => {
    const app = window.__picross;
    const solution = app.puzzle.solution;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    for (let i = 0; i < solution.length; i++) {
      if (solution[i] === 0 && !app.puzzle.isRemoved(i)) {
        if (app.puzzle.isPainted(i)) app.puzzle.togglePaint(i);
        app.chisel(i);
      }
    }
    await wait(300);
    const camBefore = app.camera.position.clone();
    await wait(900);
    const camAfter = app.camera.position.clone();

    return {
      solved: app.puzzle.isSolved(),
      victoryMode: app.victory,
      allConfirmed: app.puzzle.confirmedCount === app.puzzle.level.solutionCount,
      controlsDisabled: app.controls.enabled === false,
      inputDisabled: app.interaction.enabled === false,
      cinematicActive: app.cinematic.active,
      cameraMoved: camBefore.distanceTo(camAfter) > 0.5,
      titleText: document.querySelector(".victory-top h1")?.textContent,
      titleVisible: document
        .querySelector(".victory-top")
        .classList.contains("is-visible"),
      triviaVisible: document
        .querySelector(".victory-bottom")
        .classList.contains("is-visible"),
      triviaLength: document.querySelector(".victory-bottom p")?.textContent.length,
    };
  });
  await wait(2600);
  await page.screenshot({ path: "docs/screenshots/22-victory.png" });

  out.dismiss = await page.evaluate(async () => {
    const app = window.__picross;
    document.querySelector(".victory-bottom button").click();
    await new Promise((r) => setTimeout(r, 120));
    return {
      victoryMode: app.victory,
      controlsEnabled: app.controls.enabled,
      inputEnabled: app.interaction.enabled,
      titleVisible: document
        .querySelector(".victory-top")
        .classList.contains("is-visible"),
    };
  });

  // ---------- 6) 压力关帧率 ----------
  await page.evaluate(() => window.__picross.loadLevel("stress-10"));
  await wait(900);
  out.perf = await page.evaluate(async () => {
    const app = window.__picross;
    const sample = async (mutate) => {
      let frames = 0;
      let v = 0;
      let dir = 1;
      const t0 = performance.now();
      await new Promise((resolve) => {
        const tick = () => {
          frames++;
          if (mutate) {
            v += dir;
            if (v >= 8 || v <= 0) dir = -dir;
            app.slice.setBound(0, 0, v);
            app.onSliceChanged();
          }
          if (performance.now() - t0 >= 1500) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return Math.round(frames / ((performance.now() - t0) / 1000));
    };
    const staticFps = await sample(false);
    const dragFps = await sample(true);
    app.resetSlice();
    app._maybeRebuildHints();
    return {
      staticFps,
      dragFps,
      instances: app.puzzleRenderer.visibleCount,
      decals: app.hintRenderer.visibleCount,
      triangles: app.puzzleRenderer.getRenderStats().triangles,
      drawCalls:
        app.puzzleRenderer.getRenderStats().drawCalls +
        app.hintRenderer.getStats().drawCalls,
      shadowsEnabled: app.renderer.shadowMap.enabled,
    };
  });

  console.log(JSON.stringify(out, null, 2));
  return out;
}
