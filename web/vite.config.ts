import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 开发期：前端跑在 5173，/api 反向代理到 Spring Boot（8080）。
 * 这样浏览器只与一个 origin 通信（免 CORS），与生产形态一致 ——
 * 生产环境由静态服务器把 /api 反代到 server 即可，前端代码不需要改。
 */
export default defineConfig({
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
