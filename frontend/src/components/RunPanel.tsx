import { useState } from 'react';
import { Alert, Button, Card, Collapse, Empty, Input, Space, Tag, Typography } from 'antd';
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
            <div className="field" key={variable.name}>
              <span className="field__label">
                {variable.name}
                <Typography.Text type="secondary"> · {variable.type}</Typography.Text>
                {variable.required !== false && <Typography.Text type="danger"> *</Typography.Text>}
              </span>
              <Input
                value={values[variable.name] ?? ''}
                placeholder={variable.description ?? ''}
                onChange={(event) => setValues({ ...values, [variable.name]: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !busy) submit();
                }}
              />
            </div>
          ))
        ) : (
          <div className="field">
            <span className="field__label">输入（该图没有 start 变量声明）</span>
            <Input value={fallback} onChange={(event) => setFallback(event.target.value)} />
          </div>
        )}

        <Space wrap>
          <Button type="primary" disabled={busy} onClick={submit}>
            {busy ? '运行中…' : '运行'}
          </Button>
          {busy ? (
            <Button onClick={() => void cancelRun()}>暂停</Button>
          ) : (
            <Button onClick={() => void retryRun()} disabled={!canResume}>
              重试这一轮
            </Button>
          )}
          <Button onClick={resetRun} disabled={run.status === 'idle'}>
            清空
          </Button>
        </Space>
      </div>

      <RunSummary />

      <div className="chat">
        {run.messages.length === 0 && run.logs.length === 0 && run.status === 'idle' && (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="点「运行」后，这里会显示流式输出、工具调用与节点执行情况。" />
        )}

        {run.logs.length > 0 && (
          <div className="node-logs">
            <div className="card__title">节点过程</div>
            <Collapse
              size="small"
              items={run.logs.map((log, index) => ({
                key: `${log.nodeId ?? 'n'}-${index}`,
                label: (
                  <Space size={6}>
                    <Tag>{log.nodeType}</Tag>
                    {log.nodeId && <Typography.Text code type="secondary">{log.nodeId}</Typography.Text>}
                    <span>{log.message}</span>
                  </Space>
                ),
                children: (
                  <>
                    {log.input !== undefined && <pre className="node-log__io">输入{'\n'}{renderLogValue(log.input)}</pre>}
                    {log.output !== undefined && <pre className="node-log__io">输出{'\n'}{renderLogValue(log.output)}</pre>}
                  </>
                ),
              }))}
            />
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
          <Alert
            type="error"
            showIcon
            message={
              <Space>
                运行失败 · <Typography.Text code>{run.error.code}</Typography.Text>
                {run.error.retryable && <Tag color="warning">可重试</Tag>}
              </Space>
            }
            description={run.error.message}
          />
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
    <Space className={`run-summary ${ok ? 'ok' : running ? 'running' : cancelled ? 'cancelled' : 'failed'}`} wrap>
      <Tag color={running ? 'processing' : ok ? 'success' : cancelled ? 'warning' : 'error'}>
        {running ? '运行中' : ok ? '成功' : cancelled ? '已暂停' : '失败'}
      </Tag>
      {run.durationMs !== null && <span>耗时 {run.durationMs} ms</span>}
      {run.usage && (
        <span>
          tokens {run.usage.inputTokens}/{run.usage.outputTokens} · 模型调用 {run.usage.llmCalls} 次
        </span>
      )}
      {run.totals && <span>工具 {run.totals.toolCalls} 次 · 超级步 {run.totals.steps}</span>}
      {run.usage && run.usageEstimated && <Typography.Text type="secondary">tokens 为估算值</Typography.Text>}
    </Space>
  );
}

function MessageBubble({ message, tools }: { message: ChatMessage; tools: ToolCallView[] }) {
  if (message.kind === 'tool-turn') {
    return (
      <Card size="small" title="决定调用工具">
        {(message.toolCalls ?? []).map((call, index) => {
          const view = tools.find((t) => t.callId === call.id);
          return <ToolCard key={call.id ?? index} tool={view} fallbackName={call.name} fallbackArgs={call.args} />;
        })}
      </Card>
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
  if (type === 'object') {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}
