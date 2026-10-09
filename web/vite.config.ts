import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 开发期：前端跑在 5173，/api 反向代理到 Spring Boot（8080）。
 * 这样浏览器只与一个 origin 通信（免 CORS），与生产形态一致 ——
 * 生产环境由静态服务器把 /api 反代到 server 即可，前端代码不需要改。
 */
export default defineConfig({
  // 相对基址：产物里的资源引用是 './assets/...'，
  // 于是同一份 dist 既能挂在 /（8080 根路径）也能挂在 /studio/（80 端子路径）。
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
