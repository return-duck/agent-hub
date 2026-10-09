import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api/client.js';
import { saveSession } from '../store/session.js';

/**
 * 登录 / 注册。
 *
 * 登录成功后直接 window.location.reload()：让 Studio 以"已登录"的干净状态重新挂载，
 * 省掉把登录态再往 store 里灌一遍的中间态。
 */
export function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isRegister = mode === 'register';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = isRegister
        ? await api.register(email.trim(), displayName.trim(), password)
        : await api.login(email.trim(), password);
      saveSession(result.token, result.user);
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth__card">
        <div className="brand auth__brand">
          <span className="brand__mark">AS</span>
          <div>
            <div className="brand__name">Agent Stack</div>
            <div className="brand__sub">画一张图，编译成 LangGraph，看它跑</div>
          </div>
        </div>

        <div className="auth__tabs">
          <button
            type="button"
            className={`auth__tab${!isRegister ? ' auth__tab--active' : ''}`}
            onClick={() => { setMode('login'); setError(null); }}
          >
            登录
          </button>
          <button
            type="button"
            className={`auth__tab${isRegister ? ' auth__tab--active' : ''}`}
            onClick={() => { setMode('register'); setError(null); }}
          >
            注册
          </button>
        </div>

        <form onSubmit={submit}>
          <label className="auth__field">
            <span>邮箱</span>
            <input
              type="email"
              value={email}
              autoComplete="username"
              placeholder="you@example.com"
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>

          {isRegister && (
            <label className="auth__field">
              <span>昵称</span>
              <input
                value={displayName}
                maxLength={64}
                placeholder="怎么称呼你"
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </label>
          )}

          <label className="auth__field">
            <span>密码</span>
            <input
              type="password"
              value={password}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              placeholder={isRegister ? '至少 8 位' : ''}
              minLength={isRegister ? 8 : undefined}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>

          {error && <div className="auth__error">{error}</div>}

          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? '处理中…' : isRegister ? '注册并进入' : '登录'}
          </button>
        </form>

        <p className="auth__hint">
          {isRegister
            ? '注册后可以创建自己的 agent，并把它发布成一条可分享的链接。'
            : '登录后管理你自己的 agent 与会话。'}
        </p>
      </div>
    </div>
  );
}
