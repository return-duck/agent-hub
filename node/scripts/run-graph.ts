/**
 * 无 UI 的端到端跑图工具（S3 检查点）：
 *   npm run run-graph fixtures/graph-with-tools.json '{"topic":"(12+8)*3"}'
 *
 * 它把协议事件按行打到 stdout，可以单独验证"编译 → 执行 → 事件"这条链路，
 * 完全不依赖 Java 与前端。
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import type { RunRequest } from '../src/executor/run.js';
import { executeRun } from '../src/executor/run.js';

async function main(): Promise<void> {
  const graphPath = process.argv[2] ?? 'fixtures/graph-with-tools.json';
  const inputJson = process.argv[3] ?? '{"topic":"(12+8)*3"}';
  const historyJson = process.argv[4] ?? '[]';

  const absolute = isAbsolute(graphPath) ? graphPath : resolve(process.cwd(), graphPath);
  const graph = JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
  const input = JSON.parse(inputJson) as Record<string, unknown>;
  const history = JSON.parse(historyJson) as Array<{ role: string; content: string }>;

  const config = loadConfig();
  const request: RunRequest = {
    runId: `cli-${Date.now()}`,
    conversationId: 'cli',
    graph,
    graphSchemaVersion: 1,
    input,
    history,
  };

  const started = Date.now();
  let count = 0;
  const outcome = await (async () => {
    const generator = executeRun(request, config);
    let step = await generator.next();
    while (!step.done) {
      const event = step.value;
      count += 1;
      const node = event.nodeId ? ` [${event.nodeId}]` : '';
      process.stdout.write(`${String(count).padStart(3, ' ')}  ${event.type}${node}\n`);
      if (event.type === 'llm.token') {
        process.stdout.write(`       delta=${JSON.stringify(event.payload.delta)}\n`);
      } else if (event.type === 'tool.finished' || event.type === 'tool.started') {
        process.stdout.write(`       ${JSON.stringify(event.payload)}\n`);
      } else if (event.type === 'run.error' || event.type === 'run.finished') {
        process.stdout.write(`       ${JSON.stringify(event.payload)}\n`);
      }
      step = await generator.next();
    }
    return step.value;
  })();

  process.stdout.write(
    `\n[run-graph] status=${outcome.status} events=${count} ${Date.now() - started}ms ` +
      `llmCalls=${outcome.totals.llmCalls} toolCalls=${outcome.totals.toolCalls} steps=${outcome.totals.steps}\n`,
  );
  if (outcome.answer) {
    process.stdout.write(`[run-graph] answer:\n${outcome.answer}\n`);
  }
  if (outcome.error) {
    process.stdout.write(`[run-graph] error: ${outcome.error.code} ${outcome.error.message}\n`);
  }
}

main().catch((error) => {
  console.error('[run-graph] 失败:', error);
  process.exit(1);
});
