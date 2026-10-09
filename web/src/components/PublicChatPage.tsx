import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  api,
  subscribeToPublicRun,
  type ConversationSummary,
  type MessageView,
  type PublicAgent,
} from '../api/client.js';
import { visitorId } from '../store/session.js';

/**
 * 公开对话页：/a/<slug>（或 /studio/a/<slug>）。
 *
 * slug 从 URL 路径解析 —— 这就是"一个链接对应一个 agent"的落地方式。
 * 访客身份用浏览器本地生成的 visitorId，服务端据此把不同访客的会话隔离开，
 * 所以分享出去的链接点开即用，不需要访客注册。
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

  const visitor = useRef(visitorId());
  const streamRef = useRef<{ close(): void } | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

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

  // 切换会话时载入历史
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    api.publicMessages(slug, activeId, visitor.current)
      .then((list) => { if (!cancelled) setMessages(list); })
      .catch((error) => { if (!cancelled) setNotice(String(error)); });
    return () => { cancelled = true; };
  }, [slug, activeId]);

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

  async function send() {
    const text = draft.trim();
    if (!text || running) return;
    setDraft('');
    setNotice(null);
    setRunning(true);
    setStreaming('');

    try {
      const started = await api.startPublicRun(slug, { topic: text }, activeId, visitor.current);
      setActiveId(started.conversationId);

      // 立刻把用户这句话显示出来，不等历史回读
      setMessages((prev) => [
        ...prev,
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

      streamRef.current?.close();
      streamRef.current = subscribeToPublicRun(
        slug,
        started.runId,
        visitor.current,
        (event) => {
          if (event.type === 'llm.token') {
            setStreaming((prev) => prev + String((event.payload as { delta?: string }).delta ?? ''));
          }
          if (event.type === 'run.error') {
            setNotice(String((event.payload as { message?: string }).message ?? '运行出错'));
          }
          if (event.type === 'run.finished') {
            setRunning(false);
            setStreaming('');
            // 终态后从库里回读，拿到落库后的权威历史（含助手消息与工具调用）
            api.publicMessages(slug, started.conversationId, visitor.current)
              .then(setMessages)
              .catch(() => undefined);
            void refreshConversations();
          }
        },
        (message) => setNotice(message),
      );
    } catch (error) {
      setRunning(false);
      setNotice(error instanceof ApiError ? error.message : String(error));
    }
  }

  function newConversation() {
    streamRef.current?.close();
    setActiveId(null);
    setMessages([]);
    setStreaming('');
    setNotice(null);
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
              onClick={() => { streamRef.current?.close(); setActiveId(c.id); }}
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
          {messages.length === 0 && !streaming && (
            <div className="chat__intro">
              <div className="chat__intro-title">开始和「{agent.name}」对话</div>
              <div className="chat__intro-sub">这个页面对任何拿到链接的人都可用，无需登录。</div>
            </div>
          )}

          {messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => (
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
          <div ref={bottomRef} />
        </div>

        {notice && <div className="chat__notice">{notice}</div>}

        <div className="chat__composer">
          <textarea
            value={draft}
            rows={2}
            placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
            disabled={running}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="btn btn-primary" type="button" disabled={running || !draft.trim()} onClick={send}>
            发送
          </button>
        </div>
      </main>
    </div>
  );
}
