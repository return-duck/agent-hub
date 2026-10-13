import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Collapse, Empty, Space, Spin, Tag, Typography } from 'antd';
import {
  ApiError,
  api,
  type ConversationSummary,
  type ConversationTrace,
  type PublicAgent,
  type TraceSpan,
  type TraceTurn,
} from '../api/client.js';
import { mountPrefix } from '../config/base.js';
import { visitorId } from '../store/session.js';

/**
 * 发布的 agent 的调用轨迹页：/<前缀>/a/<slug>/traces
 *
 * 为什么单独开一页而不是塞进对话框旁边：轨迹是"事后复盘"用的，
 * 一个会话往往有好几轮，每轮又有十来个 span —— 和对话挤在一起两边都不好用。
 *
 * 页面结构（对应"每个会话都有自己的调用轨迹"+"一个会话中的多轮在一页里看"）：
 *   左侧：这个访客在该 agent 下的会话列表
 *   右侧：选中会话的**全部轮次**，每轮一块，块内是该轮的 span 时间线
 * 后端一次返回整份 ConversationTrace，前端直接渲染，不在浏览器里拼三张表的数据。
 */
export function PublicTracePage({ slug }: { slug: string }) {
  const [agent, setAgent] = useState<PublicAgent | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [trace, setTrace] = useState<ConversationTrace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visitor = visitorId();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await api.publicAgent(slug);
        if (cancelled) return;
        setAgent(info);
        const list = await api.publicConversations(slug, visitor);
        if (cancelled) return;
        setConversations(list);
        setActiveId(list.length > 0 ? list[0]!.id : null);
        if (list.length === 0) setError(null);
      } catch (e) {
        if (!cancelled) setFatal(e instanceof ApiError ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, visitor]);

  const load = useCallback(
    async (conversationId: string) => {
      setLoading(true);
      setError(null);
      try {
        setTrace(await api.publicConversationTrace(slug, conversationId, visitor));
      } catch (e) {
        setTrace(null);
        setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [slug, visitor],
  );

  useEffect(() => {
    if (activeId) {
      void load(activeId);
    } else {
      setTrace(null);
    }
  }, [activeId, load]);

  if (fatal) {
    return (
      <div className="tracepage tracepage--empty">
        <div className="chat__empty-card">
          <h2>无法打开调用轨迹</h2>
          <p>{fatal}</p>
        </div>
      </div>
    );
  }

  const chatPath = `${mountPrefix()}/a/${slug}`;

  return (
    <div className="tracepage">
      <header className="tracepage__head">
        <Button size="small" href={chatPath}>
          返回对话
        </Button>
        <div className="tracepage__title">
          <strong>{agent?.name ?? '…'}</strong>
          <span className="tracepage__sub">调用轨迹</span>
        </div>
        <Button size="small" onClick={() => activeId && void load(activeId)}>
          刷新
        </Button>
      </header>

      <div className="tracepage__body">
        <aside className="tracepage__side">
          <div className="tracepage__side-title">
            会话（{conversations.length}）
          </div>
          {conversations.length === 0 && (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={<span>还没有会话。先去 <Typography.Link href={chatPath}>对话</Typography.Link> 吧。</span>}
            />
          )}
          {conversations.map((c) => (
            <Button
              key={c.id}
              block
              type={c.id === activeId ? 'primary' : 'text'}
              onClick={() => setActiveId(c.id)}
            >
              <span className="trace-conv__title">{c.title || '新会话'}</span>
              <span className="trace-conv__meta">{c.messageCount} 条消息</span>
            </Button>
          ))}
        </aside>

        <main className="tracepage__main">
          {error && <Alert type="error" showIcon message={error} />}
          {loading && <Spin tip="正在加载轨迹…" />}

          {!loading && !error && trace && trace.turnCount === 0 && (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个会话还没有产生调用轨迹。" />
          )}

          {!loading && trace && trace.turnCount > 0 && (
            <>
              <div className="tracepage__summary">
                {trace.title || '新会话'} · 共 {trace.turnCount} 轮对话 ·{' '}
                {trace.turns.reduce((sum, t) => sum + t.spans.length, 0)} 步
              </div>
              {trace.turns.map((turn, index) => (
                <TurnCard key={turn.runId} turn={turn} index={index + 1} />
              ))}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function TurnCard({ turn, index }: { turn: TraceTurn; index: number }) {
  return (
    <section className="turn">
      <div className="turn__head">
        <span className="turn__index">第 {index} 轮</span>
        <Tag color={statusColor(turn.status)}>{statusLabel(turn.status)}</Tag>
        {turn.startedAt && (
          <span className="turn__time">{new Date(turn.startedAt).toLocaleString()}</span>
        )}
        {turn.durationMs !== null && <span className="turn__meta">{turn.durationMs} ms</span>}
        <span className="turn__meta">{turn.spans.length} 步</span>
      </div>

      {turn.question && <div className="turn__question">你：{turn.question}</div>}
      {turn.error && <Alert type="error" showIcon message={`失败原因：${turn.error}`} />}
      {!turn.error && turn.answerPreview && (
        <div className="turn__answer">回答：{turn.answerPreview}</div>
      )}

      <div className="turn__spans">
        {turn.spans.map((span) => (
          <SpanRow key={span.id} span={span} />
        ))}
        {turn.spans.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这一轮没有轨迹记录" />}
      </div>
    </section>
  );
}

function SpanRow({ span }: { span: TraceSpan }) {
  return (
    <Collapse
      size="small"
      items={[{
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
      }]}
    />
  );
}

function statusLabel(status: TraceTurn['status']): string {
  return {
    QUEUED: '排队',
    RUNNING: '运行中',
    SUCCEEDED: '成功',
    FAILED: '失败',
    CANCELLED: '已中断',
    UNKNOWN: '未知',
  }[status];
}

function statusColor(status: TraceTurn['status']): string {
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
