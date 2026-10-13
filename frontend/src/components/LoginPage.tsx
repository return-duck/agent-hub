import { useState } from 'react';
import { Alert, Button, Card, Form, Input, Tabs, Typography } from 'antd';
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isRegister = mode === 'register';

  async function submit(values: { email: string; displayName?: string; password: string }) {
    setBusy(true);
    setError(null);
    try {
      const result = isRegister
        ? await api.register(values.email.trim(), (values.displayName ?? '').trim(), values.password)
        : await api.login(values.email.trim(), values.password);
      saveSession(result.token, result.user);
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <Card className="auth__card" style={{ width: 420 }}>
        <div className="brand auth__brand">
          <span className="brand__mark">AS</span>
          <div>
            <div className="brand__name">Agent Stack</div>
            <div className="brand__sub">画一张图，编译成 LangGraph，看它跑</div>
          </div>
        </div>

        <Tabs
          activeKey={mode}
          onChange={(key) => {
            setMode(key as 'login' | 'register');
            setError(null);
          }}
          items={[
            { key: 'login', label: '登录' },
            { key: 'register', label: '注册' },
          ]}
        />

        <Form layout="vertical" onFinish={(values) => void submit(values)} requiredMark={false}>
          <Form.Item label="邮箱" name="email" rules={[{ required: true, type: 'email', message: '请填写邮箱' }]}>
            <Input type="email" autoComplete="username" placeholder="you@example.com" />
          </Form.Item>

          {isRegister && (
            <Form.Item label="昵称" name="displayName" rules={[{ required: true, message: '请填写昵称' }]}>
              <Input maxLength={64} placeholder="怎么称呼你" />
            </Form.Item>
          )}

          <Form.Item
            label="密码"
            name="password"
            rules={[{ required: true, min: isRegister ? 8 : undefined, message: isRegister ? '至少 8 位' : '请填写密码' }]}
          >
            <Input.Password
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              placeholder={isRegister ? '至少 8 位' : ''}
            />
          </Form.Item>

          {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}

          <Button type="primary" htmlType="submit" block loading={busy}>
            {isRegister ? '注册并进入' : '登录'}
          </Button>
        </Form>

        <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>
          {isRegister
            ? '注册后可以创建自己的 agent，并把它发布成一条可分享的链接。'
            : '登录后管理你自己的 agent 与会话。'}
        </Typography.Paragraph>
      </Card>
    </div>
  );
}
