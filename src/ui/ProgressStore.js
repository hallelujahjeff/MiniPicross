/**
 * 关卡进度持久化（localStorage，纯数据，不依赖 three）
 *
 * 记录"哪些关卡已完成"，用于：
 *  - 选关界面：未完成的显示问号（不剧透造型），已完成的显示模型贴图
 *  - 关卡解锁：只有当前已完成关卡之后的一个关卡可进入
 *
 * 结构很简单：只存一个 id 数组。用版本号作 key，未来结构变了可以直接迁移。
 */

const KEY = "picross3d:progress:v1";

/** 读取已完成关卡的 id 集合（永不抛异常，坏数据一律回退为空） */
export function getCompletedLevels() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x) => typeof x === "string"));
  } catch {
    return new Set();
  }
}

/** 标记某关已完成，返回更新后的集合 */
export function markLevelCompleted(id) {
  const done = getCompletedLevels();
  done.add(id);
  try {
    localStorage.setItem(KEY, JSON.stringify([...done]));
  } catch {
    // 存储满 / 隐私模式等极端情况：本次会话内仍可用内存里的集合
  }
  return done;
}

/** 清空进度（供"重置进度"这类开发/验收入口用） */
export function resetProgress() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}
