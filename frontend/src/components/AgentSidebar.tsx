import { Button, Empty, List, Popconfirm, Typography } from 'antd';
import { useStudio } from '../store/studioStore.js';
import { manifest } from '../manifest.js';

export function AgentSidebar() {
  const agents = useStudio((s) => s.agents);
  const agentId = useStudio((s) => s.agentId);
  const loading = useStudio((s) => s.loading);
  const selectAgent = useStudio((s) => s.selectAgent);
  const removeAgent = useStudio((s) => s.removeAgent);
  const newAgent = useStudio((s) => s.newAgent);
  const addNode = useStudio((s) => s.addNode);

  return (
    <aside className="sidebar">
      <div className="sidebar__section">
        <Typography.Text strong>我的 agent</Typography.Text>
        <Button type="primary" block onClick={newAgent} style={{ marginTop: 8 }}>
          + 新建 agent
        </Button>
        <List
          className="agent-list"
          locale={{ emptyText: loading ? '加载中…' : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有保存过 agent。" /> }}
          dataSource={agents}
          renderItem={(agent) => (
            <List.Item
              className={`agent-item ${agent.id === agentId ? 'active' : ''}`}
              onClick={() => void selectAgent(agent.id)}
              actions={[
                <Popconfirm
                  key="delete"
                  title="删除这个 agent？"
                  onConfirm={(event) => {
                    event?.stopPropagation();
                    void removeAgent(agent.id);
                  }}
                  onCancel={(event) => event?.stopPropagation()}
                >
                  <Button
                    size="small"
                    danger
                    title="删除"
                    onClick={(event) => event.stopPropagation()}
                  >
                    ×
                  </Button>
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                title={agent.name}
                description={`${agent.nodeCount} 个节点 · v${agent.graphSchemaVersion}`}
              />
            </List.Item>
          )}
        />
      </div>

      <div className="sidebar__section">
        <Typography.Text strong>节点（点击添加）</Typography.Text>
        <div className="palette">
          {manifest.nodeTypes.filter((spec) => !('palette' in spec) || spec.palette !== false).map((spec) => (
            <Button
              key={spec.type}
              className="palette__item"
              draggable
              title={spec.description ?? ''}
              onDragStart={(event) => event.dataTransfer.setData('application/agent-node', spec.type)}
              onClick={() => addNode(spec.type, { x: 120 + Math.random() * 240, y: 80 + Math.random() * 240 })}
            >
              <span className={`palette__dot cat-${spec.category}`} />
              {spec.displayName}
            </Button>
          ))}
        </div>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          只支持线性链（MVP）：每个节点恰好一条出边，必须有一个「开始」和一个「结束」。
        </Typography.Paragraph>
      </div>
    </aside>
  );
}
