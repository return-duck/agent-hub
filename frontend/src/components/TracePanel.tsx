import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Collapse, Empty, Space, Tag, Typography } from 'antd';
import { ApiError, api, type RunSummary, type TraceSpan } from '../api/client.js';
import { useStudio } from '../store/studioStore.js';

/**
 * 调用轨迹查询。
 *
 * 「对话过程 + 执行过程」的落库视图：左边是这个 agent 最近的运行，
 * 右边选中运行的 span 时间线 —— 每个模型调用、每次工具/MCP/技能调用、
 * 每个画布节点都有独立一条，带耗时、输入与输出。
 *
 * 默认折叠：轨迹是排查时才看的东西，不该一直占满右侧面板。
 */
export function TracePanel() {
  const agentId = useStudio((s) => s.agentId);
  const dirty = useStudio((s) => s.dirty);

  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [spans, setSpans] = useState<TraceSpan[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const loadRuns = useCallback(async () => {
    if (!agentId || dirty) {
      setRuns([]);
      return;
    }
    setLoading(true);
    try {
      const list = await api.agentRuns(agentId, 30);
      setRuns(list);
      setError(null);
      if (list.length > 0 && !list.some((r) => r.id === selectedRun)) {
        setSelectedRun(list[0]!.id);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [agentId, dirty, selectedRun]);

  useEffect(() => {
    if (open) {
      void loadRuns();
    }
  }, [open, loadRuns]);

  useEffect(() => {
    if (!selectedRun) {
      setSpans([]);
      return;
    }
    let cancelled = false;
    api.runTraces(selectedRun)
      .then((list) => {
        if (!cancelled) setSpans(list);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRun]);

  if (!agentId || dirty) {
    return (
      <div className="trace-panel">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="保存后这里可以查该 agent 的调用轨迹。" />
      </div>
    );
  }

  return (
    <div className="trace-panel">
      <Button block type="text" className="trace-panel__toggle" onClick={() => setOpen((v) => !v)}>
        <span>{open ? '收起' : '展开'} 调用轨迹</span>
        <Typography.Text type="secondary">{open ? '' : '模型输入输出 / 工具调用 / 节点耗时'}</Typography.Text>
      </Button>

      {open && (
        <div className="trace-panel__body">
          <div className="trace-panel__runs">
            <div className="trace-panel__head">
              最近运行
              <Button size="small" onClick={() => void loadRuns()} disabled={loading}>
                刷新
              </Button>
            </div>
            {runs.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有运行记录" />}
            {runs.map((run) => (
              <Button
                key={run.id}
                block
                type={run.id === selectedRun ? 'primary' : 'text'}
                onClick={() => setSelectedRun(run.id)}
              >
                <Tag color={statusColor(run.status)}>{statusLabel(run.status)}</Tag>
                <span>{new Date(run.startedAt).toLocaleTimeString()}</span>
                <span>
                  {run.spanCount} 步
                  {run.durationMs !== null ? ` · ${run.durationMs} ms` : ''}
                  {run.retryOfRunId ? ' · 重试' : ''}
                </span>
                {run.answerPreview && <span>{run.answerPreview}</span>}
              </Button>
            ))}
          </div>

          <div className="trace-panel__spans">
            {error && <Alert type="error" showIcon message={error} />}
            {!error && spans.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选中一次运行查看调用轨迹" />}
            <Collapse
              size="small"
              items={spans.map((span) => ({
                key: span.id,
                label: (
                  <Space size={6}>
                    <span>{span.spanSeq}</span>
                    <Tag color={kindColor(span)}>{kindLabel(span)}</Tag>
                    <span>{span.name}</span>
                    {span.nodeId && <Typography.Text type="secondary">{span.nodeId}</Typography.Text>}
                    {span.durationMs !== null && <Typography.Text type="secondary">{span.durationMs} ms</Typography.Text>}
                    {span.status !== 'ok' && <Tag>{span.status}</Tag>}
                  </Space>
                ),
                children: (
                  <>
                    {span.error && <Alert type="error" showIcon message={span.error} />}
                    {span.attributes && (
                      <Space wrap>
                        {Object.entries(span.attributes).map(([k, v]) => (
                          <Tag key={k}>{k}: {String(v)}</Tag>
                        ))}
                      </Space>
                    )}
                    {span.input !== null && span.input !== undefined && (
                      <pre className="trace-span__io">输入：{'\n'}{renderIO(span.input)}</pre>
                    )}
                    {span.output !== null && span.output !== undefined && (
                      <pre className="trace-span__io">输出：{'\n'}{renderIO(span.output)}</pre>
                    )}
                  </>
                ),
              }))}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function statusLabel(status: RunSummary['status']): string {
  return { QUEUED: '排队', RUNNING: '运行中', SUCCEEDED: '成功', FAILED: '失败', CANCELLED: '已中断' }[status];
}

function statusColor(status: RunSummary['status']): string {
  if (status === 'SUCCEEDED') return 'success';
  if (status === 'FAILED') return 'error';
  return 'warning';
}

function kindLabel(span: TraceSpan): string {
  return { node: '节点', model: '模型', tool: '工具', mcp: 'MCP', skill: '技能', log: '日志' }[span.kind] ?? span.kind;
}

function kindColor(span: TraceSpan): string {
  if (span.status === 'error') return 'error';
  if (span.kind === 'model') return 'success';
  if (span.kind === 'mcp' || span.kind === 'skill') return 'error';
  return 'default';
}

function renderIO(value: unknown): string {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['text', 'result']) {
      if (typeof record[key] === 'string') return record[key] as string;
    }
  }
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
