import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  api,
  subscribeToPublicRun,
  type ConversationSummary,
  type MessageView,
  type PublicAgent,
  type TraceSpan,
} from '../api/client.js';
import { publicTracePath } from '../config/base.js';
import { visitorId } from '../store/session.js';

/**
 * 公开对话页：/a/<slug>（或 /studio/a/<slug>）。
 *
 * slug 从 URL 路径解析 —— 这就是"一个链接对应一个 agent"的落地方式。
 * 访客身份用浏览器本地生成的 visitorId，服务端据此把不同访客的会话隔离开，
 * 所以分享出去的链接点开即用，不需要访客注册。
 *
 * 中断/重发的语义（注意不是"撤回"）：
 *  - 暂停 = 让服务端把这一轮停下来（已经产生的部分回答会保留在库里）
 *  - 编辑并重发 = 先把这一轮从会话里回退掉，再用新内容发起一轮
 *    这样旧回答不会作为历史继续影响新问题
 *  - 重试 = 回退后用**同样的输入**重跑
 */
export function PublicChatPage({ slug }: { slug: string }) {
  const [agent, setAgent] = useState<PublicAgent | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [streaming, setStreaming] = useState('');
  const [running, setRunning] = useState(false);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [lastStatus, setLastStatus] = useState<string | null>(null);
  /** 发送前要先回退到哪一条（"编辑并重发"用），null 表示不需要回退 */
  const [pendingRewindSeq, setPendingRewindSeq] = useState<number | null>(null);
  const [traces, setTraces] = useState<TraceSpan[] | null>(null);

  const visitor = useRef(visitorId());
  const streamRef = useRef<{ close(): void } | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const loadMessages = useCallback(
    async (conversationId: string) => {
      const list = await api.publicMessages(slug, conversationId, visitor.current);
      setMessages(list);
      return list;
    },
    [slug],
  );

  // 打开页面：先取 agent 展示信息，再取这个访客的会话列表
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await api.publicAgent(slug);
        if (cancelled) return;
        setAgent(info);
        const list = await api.publicConversations(slug, visitor.current);
        if (cancelled) return;
        setConversations(list);
        if (list.length > 0) {
          setActiveId(list[0].id);
        }
      } catch (error) {
        if (!cancelled) {
          setFatal(error instanceof ApiError ? error.message : String(error));
        }
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.close();
    };
  }, [slug]);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    loadMessages(activeId).catch((error) => {
      if (!cancelled) setNotice(String(error));
    });
    return () => {
      cancelled = true;
    };
  }, [activeId, loadMessages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming]);

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await api.publicConversations(slug, visitor.current));
    } catch {
      /* 列表刷新失败不影响对话本身 */
    }
  }, [slug]);

  /** 订阅一个 run 的事件流，并把流式输出接到界面上。 */
  const follow = useCallback(
    (id: string, conversationId: string) => {
      streamRef.current?.close();
      setRunning(true);
      setStreaming('');
      setTraces(null);
      streamRef.current = subscribeToPublicRun(
        slug,
        id,
        visitor.current,
        (event) => {
          if (event.type === 'llm.token') {
            setStreaming((prev) => prev + String((event.payload as { delta?: string }).delta ?? ''));
          }
          if (event.type === 'run.error') {
            setNotice(String((event.payload as { message?: string }).message ?? '运行出错'));
          }
          if (event.type === 'run.finished') {
            const status = String((event.payload as { status?: string }).status ?? 'SUCCEEDED');
            setLastStatus(status);
            setRunning(false);
            setStreaming('');
            if (status === 'CANCELLED') {
              setNotice('已暂停。你可以修改这条消息后重发，或直接重试。');
            }
            loadMessages(conversationId).catch(() => undefined);
            void refreshConversations();
          }
        },
        (message) => setNotice(message),
      );
    },
    [loadMessages, refreshConversations, slug],
  );

  async function send() {
    const text = draft.trim();
    if (!text || running) return;
    setDraft('');
    setNotice(null);
    setStreaming('');
    setTraces(null);
    setRunning(true);

    try {
      // "编辑并重发"：先把旧的那一轮从会话里回退掉，再发新的
      if (pendingRewindSeq !== null && activeId) {
        await api.rewindPublicConversation(slug, activeId, pendingRewindSeq, visitor.current);
        setPendingRewindSeq(null);
      }

      const started = await api.startPublicRun(slug, { topic: text }, activeId, visitor.current);
      setActiveId(started.conversationId);
      setRunId(started.runId);
      setLastStatus(null);

      // 立刻把用户这句话显示出来，不等历史回读
      setMessages((prev) => [
        ...prev.filter((m) => m.seq !== -1),
        {
          id: `local-${started.runId}`,
          runId: started.runId,
          seq: -1,
          role: 'user',
          content: text,
          toolCalls: null,
          createdAt: new Date().toISOString(),
        },
      ]);

      follow(started.runId, started.conversationId);
    } catch (error) {
      setRunning(false);
      setNotice(error instanceof ApiError ? error.message : String(error));
    }
  }

  async function pause() {
    if (!runId || !running) return;
    try {
      await api.cancelPublicRun(slug, runId, visitor.current);
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : String(error));
    }
  }

  async function retry() {
    if (!runId || running) return;
    setNotice(null);
    setStreaming('');
    setTraces(null);
    try {
      const started = await api.retryPublicRun(slug, runId, visitor.current);
      setRunId(started.runId);
      setActiveId(started.conversationId);
      setLastStatus(null);
      follow(started.runId, started.conversationId);
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : String(error));
    }
  }

  /** 编辑并重发：把最后一条 user 消息放回输入框，并记下要回退到哪 */
  function editLast(userMessage: MessageView) {
    setDraft(userMessage.content ?? '');
    setPendingRewindSeq(Math.max(0, userMessage.seq - 1));
    setNotice('已放回输入框：改完点发送，旧的这一轮会被替换。');
  }

  async function showTraces() {
    if (!runId) return;
    if (traces) {
      setTraces(null);
      return;
    }
    try {
      setTraces(await api.publicRunTraces(slug, runId, visitor.current));
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : String(error));
    }
  }

  function newConversation() {
    streamRef.current?.close();
    setActiveId(null);
    setMessages([]);
    setStreaming('');
    setNotice(null);
    setRunId(null);
    setLastStatus(null);
    setPendingRewindSeq(null);
    setTraces(null);
  }

  if (fatal) {
    return (
      <div className="chat chat--empty">
        <div className="chat__empty-card">
          <h2>无法打开这个 agent</h2>
          <p>{fatal}</p>
          <p className="chat__empty-hint">这个链接可能已被取消发布，或者地址有误。</p>
        </div>
      </div>
    );
  }

  if (!agent) {
    return <div className="chat chat--empty">正在加载…</div>;
  }

  const visible = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const lastUserId = [...visible].reverse().find((m) => m.role === 'user')?.id;
  const canResume = !running && runId !== null && (lastStatus === 'CANCELLED' || lastStatus === 'FAILED');

  return (
    <div className="chat">
      <aside className="chat__side">
        <div className="chat__agent">
          <div className="chat__agent-name">{agent.name}</div>
          {agent.description && <div className="chat__agent-desc">{agent.description}</div>}
        </div>

        <button className="btn btn-primary btn-block" type="button" onClick={newConversation}>
          + 新对话
        </button>

        <div className="chat__side-title">我的会话（{conversations.length}）</div>
        <div className="chat__conv-list">
          {conversations.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`chat__conv${c.id === activeId ? ' chat__conv--active' : ''}`}
              onClick={() => {
                streamRef.current?.close();
                setActiveId(c.id);
                setRunId(null);
                setLastStatus(null);
                setPendingRewindSeq(null);
                setTraces(null);
              }}
            >
              <span className="chat__conv-title">{c.title || '新会话'}</span>
              <span className="chat__conv-meta">{c.messageCount} 条</span>
            </button>
          ))}
          {conversations.length === 0 && <div className="chat__conv-empty">还没有会话</div>}
        </div>
      </aside>

      <main className="chat__main">
        <div className="chat__messages">
          {visible.length === 0 && !streaming && (
            <div className="chat__intro">
              <div className="chat__intro-title">开始和「{agent.name}」对话</div>
              <div className="chat__intro-sub">这个页面对任何拿到链接的人都可用，无需登录。</div>
            </div>
          )}

          {visible.map((m) => (
            <div key={m.id} className={`msg msg--${m.role}`}>
              <div className="msg__role">{m.role === 'user' ? '你' : agent.name}</div>
              <div className="msg__body">
                {m.content}
                {m.toolCalls && m.toolCalls.length > 0 && (
                  <div className="msg__tools">
                    调用工具：{m.toolCalls.map((t) => t.name).filter(Boolean).join('、')}
                  </div>
                )}
              </div>
              {/* 暂停/失败后，最后一条用户消息上给出"改一下重发"的入口 */}
              {canResume && m.role === 'user' && m.id === lastUserId && (
                <div className="msg__actions">
                  <button className="btn btn-mini" type="button" onClick={() => editLast(m)}>
                    编辑并重发
                  </button>
                  <button className="btn btn-mini" type="button" onClick={() => void retry()}>
                    重试这一轮
                  </button>
                </div>
              )}
            </div>
          ))}

          {streaming && (
            <div className="msg msg--assistant">
              <div className="msg__role">{agent.name}</div>
              <div className="msg__body">
                {streaming}
                <span className="msg__cursor">▍</span>
              </div>
            </div>
          )}

          {running && !streaming && <div className="chat__typing">正在思考…</div>}

          {/* 调用轨迹：不离开对话就能看这一轮到底发生了什么 */}
          {traces && (
            <div className="trace-inline">
              <div className="trace-inline__title">
                本轮调用轨迹（{traces.length} 步）
                <button className="btn btn-mini" type="button" onClick={() => setTraces(null)}>收起</button>
              </div>
              {traces.map((span) => (
                <details key={span.id} className="trace-inline__span">
                  <summary>
                    <span className={`badge ${badgeFor(span)}`}>{labelOf(span)}</span>
                    <span className="trace-inline__name">{span.name}</span>
                    {span.durationMs !== null && <span className="trace-inline__ms">{span.durationMs} ms</span>}
                  </summary>
                  {span.input !== null && (
                    <pre className="trace-inline__io">
                      {`输入：\n${renderIO(span.input)}`}
                    </pre>
                  )}
                  {span.output !== null && (
                    <pre className="trace-inline__io">
                      {`输出：\n${renderIO(span.output)}`}
                    </pre>
                  )}
                </details>
              ))}
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {notice && <div className="chat__notice">{notice}</div>}

        <div className="chat__composer">
          <textarea
            value={draft}
            rows={2}
            placeholder={pendingRewindSeq !== null ? '改好后发送，旧的这一轮会被替换' : '说点什么…（Enter 发送，Shift+Enter 换行）'}
            disabled={running}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {running ? (
            <button className="btn" type="button" onClick={() => void pause()}>
              暂停
            </button>
          ) : (
            <button className="btn btn-primary" type="button" disabled={!draft.trim()} onClick={send}>
              发送
            </button>
          )}
          {runId && !running && (
            <button className="btn btn-mini" type="button" onClick={() => void showTraces()}>
              {traces ? '隐藏本轮' : '看本轮'}
            </button>
          )}
          {/* 完整轨迹在专门的页面上看：一个会话里的多轮能一起对照 */}
          <a className="btn btn-mini" href={publicTracePath(slug)}>
            调用轨迹
          </a>
        </div>
      </main>
    </div>
  );
}

function labelOf(span: TraceSpan): string {
  return { node: '节点', model: '模型', tool: '工具', mcp: 'MCP', skill: '技能', log: '日志' }[span.kind] ?? span.kind;
}

function badgeFor(span: TraceSpan): string {
  if (span.status === 'error') return 'badge-error';
  if (span.status === 'cancelled') return 'badge-warn';
  return span.kind === 'model' ? 'badge-ok' : 'badge-warn';
}

/** 轨迹里的 input/output 是 {text: "..."} / {result: "..."} / 任意 JSON，统一渲染 */
function renderIO(value: unknown): string {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['text', 'result']) {
      if (typeof record[key] === 'string') return record[key] as string;
    }
  }
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
