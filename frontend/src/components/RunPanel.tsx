import { useState } from 'react';
import { useStudio } from '../store/studioStore.js';
import { inputVariablesOf, readConfig } from '../manifest.js';
import type { ChatMessage, ToolCallView } from '../store/runReducer.js';

/**
 * 运行面板：输入表单（由 start 节点声明的变量生成）→ 提交 run → 消费事件流。
 * 所有渲染都来自 runReducer 产出的状态，组件里没有状态迁移逻辑。
 */
export function RunPanel() {
  const nodes = useStudio((s) => s.nodes);
  const run = useStudio((s) => s.run);
  const runWithInput = useStudio((s) => s.runWithInput);
  const resetRun = useStudio((s) => s.resetRun);

  const startNode = nodes.find((n) => n.type === 'start');
  const variables = inputVariablesOf(readConfig(startNode?.data));
  const [values, setValues] = useState<Record<string, string>>({});
  const [fallback, setFallback] = useState('(12+8)*3');

  const busy = run.status === 'running';
  const cancelRun = useStudio((s) => s.cancelRun);
  const retryRun = useStudio((s) => s.retryRun);
  const canResume = !busy && (run.status === 'failed' || run.status === 'cancelled');

  const submit = (): void => {
    const input: Record<string, unknown> = {};
    if (variables.length > 0) {
      for (const variable of variables) {
        const raw = values[variable.name] ?? '';
        input[variable.name] = coerce(raw, variable.type);
      }
    } else {
      input['input'] = fallback;
    }
    void runWithInput(input);
  };

  return (
    <div className="run-panel">
      <div className="run-form">
        {variables.length > 0 ? (
          variables.map((variable) => (
            <label className="field" key={variable.name}>
              <span className="field__label">
                {variable.name}
                <span className="muted"> · {variable.type}</span>
                {variable.required !== false && <span className="required"> *</span>}
              </span>
              <input
                value={values[variable.name] ?? ''}
                placeholder={variable.description ?? ''}
                onChange={(event) => setValues({ ...values, [variable.name]: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !busy) submit();
                }}
              />
            </label>
          ))
        ) : (
          <label className="field">
            <span className="field__label">输入（该图没有 start 变量声明）</span>
            <input value={fallback} onChange={(event) => setFallback(event.target.value)} />
          </label>
        )}

        <div className="row">
          <button className="btn btn-primary" disabled={busy} onClick={submit}>
            {busy ? '运行中…' : '▶ 运行'}
          </button>
          {busy ? (
            <button className="btn" type="button" onClick={() => void cancelRun()}>
              暂停
            </button>
          ) : (
            <button className="btn" type="button" onClick={() => void retryRun()} disabled={!canResume}>
              重试这一轮
            </button>
          )}
          <button className="btn" onClick={resetRun} disabled={run.status === 'idle'}>
            清空
          </button>
        </div>
      </div>

      <RunSummary />

      <div className="chat">
        {run.messages.length === 0 && run.logs.length === 0 && run.status === 'idle' && (
          <p className="panel-empty muted">点「运行」后，这里会显示流式输出、工具调用与节点执行情况。</p>
        )}

        {run.logs.length > 0 && (
          <div className="node-logs">
            <div className="card__title">节点过程</div>
            {run.logs.map((log, index) => (
              <details key={`${log.nodeId ?? 'n'}-${index}`} className={`node-log node-log-${log.level}`}>
                <summary>
                  <span className="badge">{log.nodeType}</span>
                  {log.nodeId && <code className="muted">{log.nodeId}</code>}
                  <span>{log.message}</span>
                </summary>
                {log.input !== undefined && (
                  <pre className="node-log__io">输入{'\n'}{renderLogValue(log.input)}</pre>
                )}
                {log.output !== undefined && (
                  <pre className="node-log__io">输出{'\n'}{renderLogValue(log.output)}</pre>
                )}
              </details>
            ))}
          </div>
        )}

        {run.messages.map((message) => (
          <MessageBubble key={message.id} message={message} tools={run.tools} />
        ))}

        {run.streamingText && (
          <div className="bubble bubble-assistant">
            <pre>{run.streamingText}</pre>
            <span className="cursor">▌</span>
          </div>
        )}

        {run.error && (
          <div className="card card-error">
            <div className="card__title">
              运行失败 · <code>{run.error.code}</code>
              {run.error.retryable && <span className="badge badge-warn">可重试</span>}
            </div>
            <p>{run.error.message}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function RunSummary() {
  const run = useStudio((s) => s.run);
  if (run.status === 'idle') return null;

  const running = run.status === 'running';
  const ok = run.status === 'succeeded';
  const cancelled = run.status === 'cancelled';

  return (
    <div className={`run-summary ${ok ? 'ok' : running ? 'running' : cancelled ? 'cancelled' : 'failed'}`}>
      <span className="run-summary__status">
        {running ? '● 运行中' : ok ? '✓ 成功' : cancelled ? '⏸ 已暂停' : '✕ 失败'}
      </span>
      {run.durationMs !== null && <span>耗时 {run.durationMs} ms</span>}
      {run.usage && (
        <span>
          tokens {run.usage.inputTokens}/{run.usage.outputTokens} · 模型调用 {run.usage.llmCalls} 次
        </span>
      )}
      {run.totals && <span>工具 {run.totals.toolCalls} 次 · 超级步 {run.totals.steps}</span>}
      {run.usage && run.usageEstimated && <span className="muted">tokens 为估算值</span>}
    </div>
  );
}

function MessageBubble({ message, tools }: { message: ChatMessage; tools: ToolCallView[] }) {
  if (message.kind === 'tool-turn') {
    return (
      <div className="card card-tool">
        <div className="card__title">决定调用工具</div>
        {(message.toolCalls ?? []).map((call, index) => {
          const view = tools.find((t) => t.callId === call.id);
          return <ToolCard key={call.id ?? index} tool={view} fallbackName={call.name} fallbackArgs={call.args} />;
        })}
      </div>
    );
  }

  return (
    <div className={`bubble bubble-${message.role}`}>
      <pre>{message.content}</pre>
    </div>
  );
}

function ToolCard({
  tool,
  fallbackName,
  fallbackArgs,
}: {
  tool?: ToolCallView;
  fallbackName?: string;
  fallbackArgs?: unknown;
}) {
  return (
    <div className={`tool ${tool?.isError ? 'tool-error' : ''}`}>
      <div className="tool__head">
        <code>{tool?.toolName ?? fallbackName ?? 'tool'}</code>
        {tool?.done ? (
          <span className="muted">
            {tool.isError ? '失败' : '成功'} · {tool.durationMs ?? 0} ms
            {tool.truncated && ' · 结果已截断'}
          </span>
        ) : (
          <span className="muted">执行中…</span>
        )}
      </div>
      <div className="tool__args">参数：{JSON.stringify(tool?.args ?? fallbackArgs ?? {})}</div>
      {tool?.result !== undefined && <pre className="tool__result">{tool.result}</pre>}
    </div>
  );
}

function renderLogValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function coerce(raw: string, type: string): unknown {
  if (type === 'number') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  if (type === 'boolean') return raw === 'true' || raw === '1';
  return raw;
}
