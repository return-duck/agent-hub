import { useEffect, useState } from 'react';
import { Alert, Empty, List, Spin, Tag } from 'antd';
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
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="保存后这里会显示该 agent 的会话。" />;
  }
  if (loading) {
    return <Spin tip="加载会话…" />;
  }
  if (error) {
    return <Alert type="error" showIcon message={error} />;
  }
  if (items.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有会话。跑一次，或把 agent 发布出去让别人聊。" />;
  }

  return (
    <List
      dataSource={items}
      renderItem={(c) => (
        <List.Item
          extra={<Tag color={c.fromVisitor ? 'warning' : 'success'}>{c.fromVisitor ? '访客' : '本机'}</Tag>}
        >
          <List.Item.Meta
            title={c.title || '新会话'}
            description={`${new Date(c.createdAt).toLocaleString()} · ${c.messageCount} 条消息`}
          />
        </List.Item>
      )}
    />
  );
}
