import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json" with { type: "json" };

// Tauri 开发约定：固定端口，失败即报错（不要静默换端口）
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // 版本号只从 package.json 取，界面上那个「v0.6.0」不再手写
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
