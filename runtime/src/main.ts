/**
 * 运行时进程入口。
 *
 * 刻意单独存在，而不是把 listen 塞在 server.ts 底部靠
 * `import.meta.url === file://${process.argv[1]}` 判断"是不是被直接执行"：
 * 部署时是通过 `current/` 软链启动的，Node 会把主模块解析成 realpath，
 * 于是 import.meta.url 与 process.argv[1] 永远不相等 —— 表现为**进程活着但不监听**，
 * 在服务器上极难排查（这个坑是本地用软链布局实测出来的）。
 *
 * 现在入口只有一个，启动逻辑无条件执行，不再依赖任何启发式判断。
 */
import { loadConfig, resolveModelMode } from './config.js';
import { createRuntimeServer } from './server.js';

const config = loadConfig();
const mode = resolveModelMode(config);
const server = createRuntimeServer(config);

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[runtime] 端口 ${config.port} 已被占用，无法启动`);
  } else {
    console.error(`[runtime] 启动失败: ${error.message}`);
  }
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  console.log(
    `[runtime] listening on http://${config.host}:${config.port}  ` +
      `model=${config.model.provider}/${config.model.name} mode=${mode}`,
  );
  if (mode === 'scripted') {
    console.log('[runtime] 未配置 API key：使用内置脚本化模型（填 runtime/.env 即可切到真实模型）');
  }
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[runtime] 收到 ${signal}，正在关闭 ...`);
    server.close(() => process.exit(0));
    // 兜底：SSE 长连接可能拖住关闭流程
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
