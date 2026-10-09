import { useEffect, useState } from 'react';
import { api } from './api/client.js';
import { AgentSidebar } from './components/AgentSidebar.js';
import { ConversationList } from './components/ConversationList.js';
import { publicAgentPath } from './config/base.js';
import { clearSession, getStoredUser } from './store/session.js';
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
  const published = useStudio((s) => s.published);
  const publicSlug = useStudio((s) => s.publicSlug);
  const publishAgent = useStudio((s) => s.publishAgent);
  const unpublishAgent = useStudio((s) => s.unpublishAgent);

  const [user] = useState(() => getStoredUser());
  const [copied, setCopied] = useState(false);
  const shareUrl = publicSlug ? `${window.location.origin}${publicAgentPath(publicSlug)}` : '';

  async function logout() {
    try {
      await api.logout();
    } catch {
      // 令牌可能已过期，本地清掉就行
    }
    clearSession();
    window.location.reload();
  }

  async function copyShareUrl() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

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
          <button
            className="btn"
            type="button"
            onClick={() => void publishAgent()}
            disabled={loading}
            title="先保存，再生成一条可分享的公开链接"
          >
            {published ? '重新发布' : '发布'}
          </button>
          {published && (
            <button className="btn btn-mini" type="button" onClick={() => void unpublishAgent()} disabled={loading}>
              取消发布
            </button>
          )}
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
          {user && (
            <span className="topbar__user">
              <span className="topbar__user-name" title={user.email}>{user.displayName}</span>
              <button className="btn btn-mini" type="button" onClick={() => void logout()}>登出</button>
            </span>
          )}
        </div>
      </header>

      {published && shareUrl && (
        <div className="publish-bar">
          <span className="publish-bar__label">公开链接</span>
          <a className="publish-bar__link" href={shareUrl} target="_blank" rel="noreferrer">{shareUrl}</a>
          <button className="btn btn-mini" type="button" onClick={() => void copyShareUrl()}>
            {copied ? '已复制' : '复制'}
          </button>
          <span className="publish-bar__hint">任何拿到链接的人都可以直接对话，无需登录</span>
        </div>
      )}

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
            <div className="panel-title">该 agent 的会话</div>
            <ConversationList />
            <div className="divider" />
            <Inspector />
          </div>
        </section>
      </div>
    </div>
  );
}
