#!/usr/bin/env node
/**
 * 重新录制契约 fixture：contracts/fixtures/events.jsonl
 *
 * 为什么要有这个脚本：这份 fixture 是「三端被同一份数据钉住」的唯一依据
 * （runtime 的 Ajv 校验、Java 的 ContractTest 都读它）。它必须来自**真实运行**，
 * 手改就失去了证据价值。以前它是一次性手工录的，改了协议之后只能靠记忆去同步；
 * 现在录制过程本身可复现。
 *
 * 用法：
 *   cd runtime && npm run build && node ../scripts/record-events.mjs
 *
 * 刻意用脚本化模型（MODEL_PROVIDER=scripted）：录制要可复现、不依赖网络与 API key。
 */
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_DIST = path.join(ROOT, 'runtime', 'dist', 'server.js');
const GRAPH = path.join(ROOT, 'runtime', 'fixtures', 'graph-with-tools.json');
const OUT = path.join(ROOT, 'contracts', 'fixtures', 'events.jsonl');

// 必须在 import 之前设置：config 在模块加载时读取环境变量
process.env.MODEL_PROVIDER = 'scripted';

const { createRuntimeServer } = await import(RUNTIME_DIST);

const graph = JSON.parse(await readFile(GRAPH, 'utf8'));
const server = createRuntimeServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const request = {
  runId: 'fixture-run',
  conversationId: 'fixture-conversation',
  graph,
  graphSchemaVersion: 1,
  input: { topic: '(12+8)*3' },
  history: [],
};

const response = await fetch(`http://127.0.0.1:${port}/execute`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(request),
});

if (!response.ok) {
  console.error(`[record] runtime 返回 ${response.status}`);
  process.exit(1);
}

const text = await response.text();
const lines = text
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .map((event) => {
    // server 会补 seq；fixture 里不该有（ContractTest 会断言这一点）
    delete event.seq;
    return event;
  });

// run 的 id / 时间戳每次不同，录进 fixture 会让契约测试变成"每次都红"。
// 统一替换成稳定占位符 —— 契约关心的形状，不是具体值。
const stable = lines.map((event) => ({
  ...event,
  runId: 'fixture-run',
  ts: '1970-01-01T00:00:00.000Z',
}));

await writeFile(OUT, stable.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
server.close();

const kinds = stable.reduce((acc, e) => ((acc[e.type] = (acc[e.type] ?? 0) + 1), acc), {});
console.log(`[record] 已写入 ${path.relative(ROOT, OUT)}：${stable.length} 行`);
for (const [type, count] of Object.entries(kinds).sort()) {
  console.log(`  ${type}: ${count}`);
}
