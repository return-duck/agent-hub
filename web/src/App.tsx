import { useEffect } from 'react';
import { AgentSidebar } from './components/AgentSidebar.js';
import { Canvas } from './components/Canvas.js';
import { Inspector } from './components/Inspector.js';
import { RunPanel } from './components/RunPanel.js';
import { useStudio } from './store/studioStore.js';

export default function App() {
  const bootstrap = useStudio((s) => s.bootstrap);
  const name = useStudio((s) => s.name);
  const setName = useStudio((s) => s.setName);
  const description = useStudio((s) => s.description);
  const setDescription = useStudio((s) => s.setDescription);
  const save = useStudio((s) => s.save);
  const dirty = useStudio((s) => s.dirty);
  const loading = useStudio((s) => s.loading);
  const notice = useStudio((s) => s.notice);
  const clearNotice = useStudio((s) => s.clearNotice);
  const capabilities = useStudio((s) => s.capabilities);
  const selectedNodeId = useStudio((s) => s.selectedNodeId);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark">AS</span>
          <div>
            <div className="brand__name">Agent Stack</div>
            <div className="brand__sub">画一张图，编译成 LangGraph，看它跑</div>
          </div>
        </div>

        <div className="topbar__form">
          <input
            className="name-input"
            value={name}
            placeholder="agent 名称"
            onChange={(event) => setName(event.target.value)}
          />
          <input
            className="desc-input"
            value={description}
            placeholder="描述（可选）"
            onChange={(event) => setDescription(event.target.value)}
          />
          <button className="btn btn-primary" onClick={() => void save()} disabled={loading}>
            {dirty ? '保存 *' : '已保存'}
          </button>
        </div>

        <div className="topbar__status">
          {capabilities?.runtimeUp === false && <span className="badge badge-error">runtime 未启动</span>}
          {capabilities?.modelMode === 'scripted' && (
            <span className="badge badge-warn" title="在 runtime/.env 里填 OPENAI_API_KEY 即可切换为真实模型，代码不用改">
              内置脚本化模型
            </span>
          )}
          {capabilities?.modelMode === 'live' && (
            <span className="badge badge-ok">真实模型 · {capabilities.modelName}</span>
          )}
        </div>
      </header>

      {notice && (
        <div className={`notice notice-${notice.kind}`} onClick={clearNotice}>
          <strong>{notice.text}</strong>
          {notice.detail && <pre className="notice__detail">{notice.detail}</pre>}
          <span className="notice__close">×</span>
        </div>
      )}

      <div className="body">
        <AgentSidebar />
        <Canvas />
        <section className="right">
          <div className="tabs">
            <div className="tabs__tab tabs__tab--active">运行</div>
            <div className="tabs__tab">节点配置{selectedNodeId ? '' : '（未选中）'}</div>
          </div>
          <div className="right__scroll">
            <RunPanel />
            <div className="divider" />
            <Inspector />
          </div>
        </section>
      </div>
    </div>
  );
}
