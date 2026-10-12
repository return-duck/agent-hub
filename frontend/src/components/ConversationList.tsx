import { useEffect, useState } from 'react';
import { ApiError, api, type ConversationSummary } from '../api/client.js';
import { useStudio } from '../store/studioStore.js';

/**
 * 当前 agent 的会话列表。
 *
 * 会话是"每个 agent 各自一份"的：工作室里自己跑出来的会话 fromVisitor=false，
 * 公开分享页访客开的会话 fromVisitor=true，这里都会列出来，方便看访客都聊了什么。
 */
export function ConversationList() {
  const agentId = useStudio((s) => s.agentId);
  const dirty = useStudio((s) => s.dirty);

  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId || dirty) {
      // 还没保存过的 agent 没有会话可列
      setItems([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api.listConversations(agentId)
      .then((list) => { if (!cancelled) { setItems(list); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e instanceof ApiError ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [agentId, dirty]);

  if (!agentId || dirty) {
    return <div className="conv-empty">保存后这里会显示该 agent 的会话。</div>;
  }
  if (loading) {
    return <div className="conv-empty">加载会话…</div>;
  }
  if (error) {
    return <div className="conv-empty conv-empty--error">{error}</div>;
  }
  if (items.length === 0) {
    return <div className="conv-empty">还没有会话。跑一次，或把 agent 发布出去让别人聊。</div>;
  }

  return (
    <div className="conv-list">
      {items.map((c) => (
        <div key={c.id} className="conv">
          <div className="conv__main">
            <div className="conv__title">{c.title || '新会话'}</div>
            <div className="conv__meta">
              {new Date(c.createdAt).toLocaleString()} · {c.messageCount} 条消息
            </div>
          </div>
          <span className={`badge ${c.fromVisitor ? 'badge-warn' : 'badge-ok'}`}>
            {c.fromVisitor ? '访客' : '本机'}
          </span>
        </div>
      ))}
    </div>
  );
}
