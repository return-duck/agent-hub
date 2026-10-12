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
        <div className="sidebar__title">我的 agent</div>
        <button className="btn btn-primary btn-block" onClick={newAgent}>
          + 新建 agent
        </button>
        <div className="agent-list">
          {agents.length === 0 && !loading && <p className="muted">还没有保存过 agent。</p>}
          {agents.map((agent) => (
            <div
              key={agent.id}
              className={`agent-item ${agent.id === agentId ? 'active' : ''}`}
              onClick={() => void selectAgent(agent.id)}
            >
              <div className="agent-item__name">{agent.name}</div>
              <div className="agent-item__meta">
                {agent.nodeCount} 个节点 · v{agent.graphSchemaVersion}
              </div>
              <button
                className="btn btn-mini btn-danger"
                title="删除"
                onClick={(event) => {
                  event.stopPropagation();
                  void removeAgent(agent.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="sidebar__section">
        <div className="sidebar__title">节点（点击添加）</div>
        <div className="palette">
          {manifest.nodeTypes.map((spec) => (
            <button
              key={spec.type}
              className="palette__item"
              draggable
              title={spec.description ?? ''}
              onDragStart={(event) => event.dataTransfer.setData('application/agent-node', spec.type)}
              onClick={() => addNode(spec.type, { x: 120 + Math.random() * 240, y: 80 + Math.random() * 240 })}
            >
              <span className={`palette__dot cat-${spec.category}`} />
              {spec.displayName}
            </button>
          ))}
        </div>
        <p className="hint">
          只支持线性链（MVP）：每个节点恰好一条出边，必须有一个「开始」和一个「结束」。
        </p>
      </div>
    </aside>
  );
}
