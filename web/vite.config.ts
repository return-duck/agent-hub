import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 开发期：前端跑在 5173，/api 反向代理到 Spring Boot（8080）。
 * 这样浏览器只与一个 origin 通信（免 CORS），与生产形态一致 ——
 * 生产环境由静态服务器把 /api 反代到 server 即可，前端代码不需要改。
 */
export default defineConfig({
  // 绝对基址 '/'：资源引用是 '/assets/...'。
  //
  // 为什么不能用相对基址 './'：公开对话页的 URL 是 /a/<slug> 这种"文件形状"的深路径，
  // 浏览器会把 './assets/x.js' 解析成 /a/assets/x.js（404），页面直接白屏。
  // 绝对基址下，深路径页面仍然从 /assets/ 取资源；80 端口的 /studio/ 挂载点由 nginx
  // 额外把 /assets/ 也指向同一份文件（该路径已被确认未被简历站占用）。
  base: '/',
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
