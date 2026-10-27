import { useState } from 'react';
import { api } from '../api';
import { Logo } from '../components/Layout';

export default function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(password);
      setPassword('');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login__inner card">
        <div className="login__brand">
          <Logo size={24} />
          <span>agentctl</span>
        </div>
        <h1 className="login__title">输入访问密码</h1>
        <p className="login__hint">
          这个控制台能读取你本机上所有 agent 的会话记录，所以设了密码。
          密码由 <span className="mono">pnpm passwd</span> 设置。
        </p>
        <form onSubmit={submit} className="login__form">
          <label className="field">
            <span className="field__label">密码</span>
            <input
              className="input"
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {error ? <div className="login__error">{error}</div> : null}
          <div className="login__actions">
            <button className="btn btn--primary btn--block" type="submit" disabled={busy || !password}>
              {busy ? '验证中…' : '进入'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
