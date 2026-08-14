import { defineConfig } from "vite";

export default defineConfig({
  /**
   * 资源基路径。
   *
   * 本地开发 / 构建默认 `/`（根域），GitHub Pages 项目站点部署时通过环境变量
   * `BASE_PATH=/MiniPicross/` 注入子路径前缀。这样同一份配置既能本地跑，
   * 又能在 Pages 上正确解析资源（否则构建产物里的 /assets/... 会指到根域 404）。
   */
  base: process.env.BASE_PATH || "/",
  root: ".",
  publicDir: "public",
  server: {
    port: 5173,
    open: true,
  },
  build: {
    outDir: "dist",
  },
});
