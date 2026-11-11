import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// 产物直接给 Rust 端（axum fallback）托管：base 用 "/"，dist 目录名固定。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // 单页 + 本地回环，不需要拆包；内联小资源减少请求数
    cssCodeSplit: false,
    assetsInlineLimit: 8192,
  },
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      // dev 模式下把 API 转给 Rust 进程，省得跨源
      "/api": "http://127.0.0.1:8787",
    },
  },
});
