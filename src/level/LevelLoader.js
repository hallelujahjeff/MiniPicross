import { parseLevel } from "./LevelParser.js";

/**
 * 关卡导入流程
 *
 * 用 Vite 的 import.meta.glob 静态收集 ./levels/*.json：
 *  - 新增关卡只需往目录里丢一个 JSON 文件，无需改代码
 *  - 天然支持 HMR 与生产打包（不依赖 public/ + fetch，不会出现 404）
 *
 * 单个关卡解析失败**不影响**其他关卡被列出：失败原因记录在清单项的
 * error 字段上，并在控制台以 console.error 输出（带关卡 id 与位置）。
 */

const modules = import.meta.glob("./levels/*.json", { eager: true });

/** @type {Map<string, {id:string,name:string,raw:object,error:Error|null,order:number,source:string}>} */
const registry = new Map();

for (const [path, mod] of Object.entries(modules)) {
  const fileId = path.replace(/^.*\/(.*)\.json$/, "$1");
  const raw = mod?.default ?? mod;
  const id = typeof raw?.id === "string" && raw.id.trim() ? raw.id.trim() : fileId;

  if (registry.has(id)) {
    console.error(
      `[LevelLoader] 关卡 id 冲突："${id}" 同时来自 ${registry.get(id).source} 与 ${path}，后者被忽略`,
    );
    continue;
  }

  registry.set(id, {
    id,
    name: typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    raw,
    error: null,
    order: Number.isFinite(raw?.meta?.order) ? raw.meta.order : 999,
    source: path,
  });
}

/** 解析结果缓存：同一关卡只解析一次 */
const parsedCache = new Map();

/**
 * 关卡清单（已按 meta.order 再按 id 排序）
 *
 * `difficulty` 是 1..5 的整数星级（来自 `meta.difficulty`，由
 * `npm run prune:levels` 在裁剪时按难度模型写入），选关界面用它画星星。
 * 这里只读 `raw.meta` 而不完整解析关卡，避免为拿一个星级去跑完整 parse。
 *
 * @returns {{id:string,name:string,error:Error|null,difficulty:number}[]}
 */
export function listLevels() {
  return [...registry.values()]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((e) => ({
      id: e.id,
      name: e.name,
      error: e.error,
      difficulty: Number.isFinite(e.raw?.meta?.difficulty)
        ? Math.min(5, Math.max(1, Math.round(e.raw.meta.difficulty)))
        : 1,
    }));
}

/** 默认关卡 id（清单里第一个可用的） */
export function getDefaultLevelId() {
  const list = listLevels();
  const ok = list.find((e) => !e.error);
  return (ok ?? list[0])?.id;
}

/**
 * 载入并解析一个关卡
 * @param {string} id
 * @returns {import("./LevelParser.js").LevelData}
 */
export function loadLevel(id) {
  if (parsedCache.has(id)) return parsedCache.get(id);

  const entry = registry.get(id);
  if (!entry) {
    const available = [...registry.keys()].join(", ") || "(无)";
    throw new Error(`[LevelLoader] 找不到关卡 "${id}"，现有关卡：${available}`);
  }

  try {
    const data = parseLevel(entry.raw, entry.id);
    entry.error = null;
    parsedCache.set(id, data);
    return data;
  } catch (err) {
    entry.error = err;
    console.error(`[LevelLoader] 解析失败：${err.message}（文件 ${entry.source}）`);
    throw err;
  }
}

/**
 * 预校验全部关卡，返回 { ok, failed }，用于启动自检与验收
 * 不会抛异常。
 */
export function validateAllLevels() {
  const ok = [];
  const failed = [];
  for (const id of registry.keys()) {
    try {
      const data = loadLevel(id);
      ok.push({
        id,
        name: data.name,
        size: [data.grid.W, data.grid.H, data.grid.D],
        solidCount: data.solidCount,
        solutionCount: data.solutionCount,
      });
    } catch (err) {
      failed.push({ id, message: err.message });
    }
  }
  return { ok, failed };
}
