import { useEffect, useState } from 'react';
import { api } from '../api';
import { formatBytes, formatCost, formatDateTime, homeShorten } from '../format';
import type { AgentInfo, Stats } from '../types';
import { AGENT_LABEL } from '../types';

const LIVE_LABEL: Record<string, string> = {
  'stream-json': 'stream-json 事件流',
  rpc: 'JSON-RPC',
  acp: 'ACP',
  pty: 'PTY',
  false: '未接入',
};

export default function Settings({
  onLogout,
  authRequired,
}: {
  onLogout: () => void;
  authRequired: boolean;
}) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .agents()
      .then(({ agents, stats }) => {
        setAgents(agents);
        setStats(stats);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, []);

  async function logout() {
    await api.logout().catch(() => undefined);
    onLogout();
  }

  return (
    <div className="shell">
      <aside className="spine">
        <div className="spine__brand">agentctl</div>
        <nav className="spine__agents">
          <a className="nav" href="#/">
            <span className="nav__label">会话</span>
          </a>
          <span className="nav is-active" style={{ '--agent': 'var(--text)' } as React.CSSProperties}>
            <span className="nav__label">设置</span>
          </span>
        </nav>
        <div className="spine__foot">
          {authRequired ? (
            <button className="linkbtn" onClick={() => void logout()}>
              退出登录
            </button>
          ) : null}
        </div>
      </aside>

      <main className="board board--narrow">
        <header className="board__head">
          <h1 className="board__title">设置</h1>
          <a className="linkbtn board__back" href="#/">
            返回会话
          </a>
        </header>

      {error ? <div className="empty empty--error">{error}</div> : null}

      {stats ? (
        <section className="section">
          <div className="section__head">
            <h2 className="section__title">索引</h2>
          </div>
          <dl className="kv num">
            <dt>会话</dt>
            <dd>{stats.sessions}</dd>
            <dt>累计花费</dt>
            <dd>{formatCost(stats.totalCostUsd) || '—'}</dd>
            <dt>磁盘占用</dt>
            <dd>{formatBytes(stats.totalBytes)}</dd>
            <dt>最近活动</dt>
            <dd>{formatDateTime(stats.latestAt)}</dd>
          </dl>
        </section>
      ) : null}

      <section className="section">
        <div className="section__head">
          <h2 className="section__title">Agent 适配器</h2>
          <span className="section__hint">当前只接入了 Claude Code，其余按里程碑推进</span>
        </div>
        {agents.map((a) => (
          <div className="agent" key={a.id}>
            <span
              className="agent__rail"
              style={{ '--agent': `var(--${a.id})` } as React.CSSProperties}
            />
            <div>
              <div className="agent__name">
                {AGENT_LABEL[a.id]}
                <span className={`agent__state${a.available ? ' is-on' : ''}`}>
                  {a.available ? '命令行可用' : '命令行未安装'}
                </span>
              </div>
              <div className="agent__meta num">
                <span>{a.sessionCount} 个会话</span>
                <span>{LIVE_LABEL[String(a.capabilities.live)]}</span>
                <span className="mono">{homeShorten(a.dataDir)}</span>
                {a.binaryPath ? <span className="mono">{homeShorten(a.binaryPath)}</span> : null}
              </div>
            </div>
          </div>
        ))}
      </section>

      <section className="section">
        <div className="section__head">
          <h2 className="section__title">远程访问</h2>
        </div>
        <div className="prose">
          <p>
            默认只监听 <span className="mono">127.0.0.1</span>。手机要用，先
            <span className="mono"> pnpm passwd </span>
            设密码，再用 <span className="mono">AGENTCTL_HOST=0.0.0.0 pnpm start</span>{' '}
            启动；没有密码时服务会拒绝绑定非回环地址。
          </p>
          <p>
            跨公网别裸跑明文 HTTP。套一层 HTTPS 反代，或者在
            <span className="mono"> ~/.agentctl/config.yaml </span>
            里配置 <span className="mono">tls.cert</span> 与
            <span className="mono"> tls.key</span>；Tailscale 之类的隧道也可以。
          </p>
          <p>
            配置与索引都在 <span className="mono">~/.agentctl/</span>。
            <span className="mono"> index.db </span>
            随时可以删，删掉只是重新扫一遍，agent 自己的会话文件不会被改动。
          </p>
        </div>
      </section>
      </main>
    </div>
  );
}
