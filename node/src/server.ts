/**
 * 运行时 HTTP 服务（Node 内置 http，无 Web 框架依赖）。
 *
 * 这里只导出 createRuntimeServer；进程启动逻辑在 main.ts（见那里的注释，
 * 解释为什么不在这里做"是否被直接执行"的判断）。
 *
 * 端点很少，是因为职责被刻意收窄：
 *   POST /execute   接收一次 run，以 NDJSON 逐行回吐协议事件
 *   GET  /healthz   就绪情况 + 实际生效的模型模式（前端据此显示"脚本化模型"横幅）
 *   GET  /capabilities 节点清单（运维/调试用）
 *
 * 为什么用 NDJSON 而不是 SSE：消费方是 Java（不是浏览器），NDJSON 一行一事件、
 * 无需处理 SSE 的分帧与心跳，Java 侧 HttpClient.ofLines() 直接可用。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadConfig, resolveModelMode, type RuntimeConfig } from './config.js';
import { nodeManifest } from './generated/manifest-data.js';
import { serialize } from './protocol/events.js';
import { executeRun, type RunRequest } from './executor/run.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function createRuntimeServer(config: RuntimeConfig = loadConfig()) {
  return createServer((req, res) => {
    handle(req, res, config).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ code: 'INTERNAL', message: String(error?.message ?? error) }));
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, config: RuntimeConfig): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/healthz') {
    const mode = resolveModelMode(config);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        model: { provider: config.model.provider, name: config.model.name, mode },
      }),
    );
    return;
  }

  if (req.method === 'GET' && url.pathname === '/capabilities') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(nodeManifest));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/execute') {
    await handleExecute(req, res, config);
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ code: 'NOT_FOUND', message: `未知路径: ${req.method} ${url.pathname}` }));
}

async function handleExecute(
  req: IncomingMessage,
  res: ServerResponse,
  config: RuntimeConfig,
): Promise<void> {
  const raw = await readBody(req);
  let request: RunRequest;
  try {
    request = JSON.parse(raw) as RunRequest;
  } catch (error) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'INVALID_REQUEST', message: '请求体不是合法 JSON' }));
    return;
  }

  // 一旦开始写事件流就不能再改状态码，所以先把头刷出去。
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  if (typeof (res as ServerResponse & { flushHeaders?: () => void }).flushHeaders === 'function') {
    (res as ServerResponse & { flushHeaders: () => void }).flushHeaders();
  }

  const controller = new AbortController();
  req.on('aborted', () => controller.abort());
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    for await (const event of executeRun(request, config, controller.signal)) {
      res.write(serialize(event) + '\n');
    }
  } catch (error) {
    // executeRun 内部已经把异常收敛成 run.error + run.finished，
    // 能走到这里说明是流本身出问题，补一行让 Java 侧不至于挂住。
    const message = error instanceof Error ? error.message : String(error);
    res.write(
      serialize({
        type: 'run.error',
        runId: request.runId ?? 'unknown',
        nodeId: null,
        ts: new Date().toISOString(),
        payload: { code: 'INTERNAL', message, retryable: false },
      } as never) + '\n',
    );
  } finally {
    res.end();
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
