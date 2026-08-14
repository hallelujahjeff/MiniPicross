// 端到端移动端适配验收
//   1. DOM 验证：截面提示框已移除，HUD 不拦截触摸
//   2. 拖滑块时锁定相机（onDragStateChange 回调）
//   3. 长按涂色（_startLongPress 触发 onPaint）
//   4. 点空白退出截面（_handlePointerUp 命中 pressed<0 且 slice.active）
//
// 用法：playwright-cli --raw run-code --filename=tools/check-mobile.js
// 限制：headless 浏览器没有 pointerType=touch 上下文，所以直接调用内部事件入口
// 验证关键路径；真实设备上的真触摸事件会被同一份代码正常处理。
async (page) => {
  await page.goto('http://localhost:5173/?level=duck');
  await page.waitForTimeout(3000);

  const result = await page.evaluate(async () => {
    const app = window.__picross;
    const interaction = app.interaction;
    const puzzle = app.puzzle;
    const slice = app.slice;
    const controls = app.controls;
    const out = {};

    // ---- 1. DOM 验证 ----
    out.sliceBar = document.querySelector('.slice-bar') ? 'EXISTS (BUG)' : 'removed';
    out.helpPointerEvents = getComputedStyle(document.querySelector('.hud-help')).pointerEvents;
    out.canvasPointerEvents = getComputedStyle(document.querySelector('#app canvas')).pointerEvents;

    // ---- 2. 拖滑块锁相机 ----
    controls.enabled = true;
    interaction.onDragStateChange(true);
    out.dragLockLocked = controls.enabled === false;
    interaction.onDragStateChange(false);
    out.dragLockRestored = controls.enabled === true;

    // ---- 3. 长按涂色 ----
    let block = -1;
    for (let i = 0; i < puzzle.solution.length; i++) {
      if (puzzle.solution[i] === 1) { block = i; break; }
    }
    const paintedBefore = puzzle.paintedCount;
    interaction._startLongPress(block);
    await new Promise(r => setTimeout(r, 600));
    out.paintedBefore = paintedBefore;
    out.paintedAfter = puzzle.paintedCount;
    out.paintTriggered = puzzle.paintedCount > paintedBefore;
    out.pressBlockAfterLongPress = interaction._pressBlock;
    puzzle.togglePaint(block);

    // ---- 4. 点空白退出截面 ----
    interaction._longPressFired = false;
    slice.setBound(2, 0, 2);
    app.onSliceChanged();
    out.sliceActiveBefore = slice.active;
    interaction._pressBlock = -1;
    interaction._handlePointerUp({
      button: 0, pointerType: 'touch', pointerId: 1,
      clientX: 5, clientY: 5, ctrlKey: false, metaKey: false,
    });
    out.sliceActiveAfter = slice.active;
    out.blankTapResetSlice = slice.active === false;

    return out;
  });

  console.log(JSON.stringify(result, null, 2));
  return result;
}
