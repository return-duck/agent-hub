import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App.js';
import { LoginPage } from './components/LoginPage.js';
import { PublicChatPage } from './components/PublicChatPage.js';
import { PublicTracePage } from './components/PublicTracePage.js';
import { routeSlug, routeTraceSlug } from './config/base.js';
import { getToken } from './store/session.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('缺少 #root 容器');
}

/**
 * 极简路由：按 URL 路径决定渲染什么。
 *
 *   /a/<slug>/traces（以及 /studio/a/<slug>/traces） → 该 agent 的调用轨迹页，免登录
 *   /a/<slug>（以及 /studio/a/<slug>）               → 公开对话页，免登录
 *   其它路径且未登录                                 → 登录页
 *   其它路径且已登录                                 → 工作室
 *
 * 没有引入 react-router：这里只有三条分支，而且要显式控制"未登录时不渲染工作室"，
 * 手写反而更清楚、也少一个依赖。注意轨迹页必须比对话页先判断 ——
 * /a/<slug>/traces 不是对话页的合法 slug。
 */
function Root() {
  const traceSlug = routeTraceSlug();
  if (traceSlug) {
    return <PublicTracePage slug={traceSlug} />;
  }
  const slug = routeSlug();
  if (slug) {
    return <PublicChatPage slug={slug} />;
  }
  if (!getToken()) {
    return <LoginPage />;
  }
  return <App />;
}

createRoot(container).render(
  <StrictMode>
    <ConfigProvider
      locale={zhCN}
      button={{ autoInsertSpace: false }}
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#3b82f6',
          borderRadius: 8,
        },
      }}
    >
      <Root />
    </ConfigProvider>
  </StrictMode>,
);
