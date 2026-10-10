import { useCallback, useEffect, useState } from 'react';
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
        <div className="trace-empty">保存后这里可以查该 agent 的调用轨迹。</div>
      </div>
    );
  }

  return (
    <div className="trace-panel">
      <button className="trace-panel__toggle" type="button" onClick={() => setOpen((v) => !v)}>
        <span>{open ? '▾' : '▸'} 调用轨迹</span>
        <span className="trace-panel__hint">{open ? '' : '模型输入输出 / 工具调用 / 节点耗时'}</span>
      </button>

      {open && (
        <div className="trace-panel__body">
          <div className="trace-panel__runs">
            <div className="trace-panel__head">
              最近运行
              <button className="btn btn-mini" type="button" onClick={() => void loadRuns()} disabled={loading}>
                刷新
              </button>
            </div>
            {runs.length === 0 && <div className="trace-empty">还没有运行记录</div>}
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                className={`trace-run${run.id === selectedRun ? ' trace-run--active' : ''}`}
                onClick={() => setSelectedRun(run.id)}
              >
                <span className={`badge ${statusBadge(run.status)}`}>{statusLabel(run.status)}</span>
                <span className="trace-run__time">{new Date(run.startedAt).toLocaleTimeString()}</span>
                <span className="trace-run__meta">
                  {run.spanCount} 步
                  {run.durationMs !== null ? ` · ${run.durationMs} ms` : ''}
                  {run.retryOfRunId ? ' · 重试' : ''}
                </span>
                {run.answerPreview && <span className="trace-run__preview">{run.answerPreview}</span>}
              </button>
            ))}
          </div>

          <div className="trace-panel__spans">
            {error && <div className="trace-empty trace-empty--error">{error}</div>}
            {!error && spans.length === 0 && <div className="trace-empty">选中一次运行查看调用轨迹</div>}
            {spans.map((span) => (
              <details key={span.id} className="trace-span">
                <summary>
                  <span className="trace-span__seq">{span.spanSeq}</span>
                  <span className={`badge ${kindBadge(span)}`}>{kindLabel(span)}</span>
                  <span className="trace-span__name">{span.name}</span>
                  {span.nodeId && <span className="trace-span__node">{span.nodeId}</span>}
                  {span.durationMs !== null && <span className="trace-span__ms">{span.durationMs} ms</span>}
                  {span.status !== 'ok' && <span className="trace-span__status">{span.status}</span>}
                </summary>
                <div className="trace-span__body">
                  {span.error && <div className="trace-empty trace-empty--error">{span.error}</div>}
                  {span.attributes && (
                    <div className="trace-span__attrs">
                      {Object.entries(span.attributes).map(([k, v]) => (
                        <span key={k} className="trace-span__attr">
                          {k}: {String(v)}
                        </span>
                      ))}
                    </div>
                  )}
                  {span.input !== null && span.input !== undefined && (
                    <pre className="trace-span__io">输入：{'\n'}{renderIO(span.input)}</pre>
                  )}
                  {span.output !== null && span.output !== undefined && (
                    <pre className="trace-span__io">输出：{'\n'}{renderIO(span.output)}</pre>
                  )}
                </div>
              </details>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function statusLabel(status: RunSummary['status']): string {
  return { QUEUED: '排队', RUNNING: '运行中', SUCCEEDED: '成功', FAILED: '失败', CANCELLED: '已中断' }[status];
}

function statusBadge(status: RunSummary['status']): string {
  if (status === 'SUCCEEDED') return 'badge-ok';
  if (status === 'FAILED') return 'badge-error';
  if (status === 'CANCELLED') return 'badge-warn';
  return 'badge-warn';
}

function kindLabel(span: TraceSpan): string {
  return { node: '节点', model: '模型', tool: '工具', mcp: 'MCP', skill: '技能', log: '日志' }[span.kind] ?? span.kind;
}

function kindBadge(span: TraceSpan): string {
  if (span.status === 'error') return 'badge-error';
  if (span.kind === 'model') return 'badge-ok';
  if (span.kind === 'mcp' || span.kind === 'skill') return 'badge-error';
  return 'badge-warn';
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
