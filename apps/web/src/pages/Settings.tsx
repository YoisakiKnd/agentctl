import { useEffect, useState } from 'react';
import { api } from '../api';
import { AgentBadge } from '../components/AgentBadge';
import Icon, { type IconName } from '../components/Icon';
import AppShell from '../components/Layout';
import { ChannelsSection, SourcesSection } from '../components/NotifySettings';
import { formatBytes, formatCost, formatDateTime, homeShorten } from '../format';
import { setThemePref, useTheme, type ThemePref } from '../theme';
import type { AgentInfo, Stats } from '../types';
import { AGENT_LABEL } from '../types';

const LIVE_LABEL: Record<string, string> = {
  'stream-json': 'stream-json 事件流',
  rpc: 'JSON-RPC',
  acp: 'ACP',
  pty: 'PTY',
  false: '只读回放',
};

const THEMES: { value: ThemePref; label: string; icon: IconName }[] = [
  { value: 'system', label: '跟随系统', icon: 'monitor' },
  { value: 'dark', label: '深色', icon: 'moon' },
  { value: 'light', label: '浅色', icon: 'sun' },
];

export default function Settings({ onLogout, authRequired }: { onLogout: () => void; authRequired: boolean }) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');
  const { pref } = useTheme();

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
    <AppShell active="settings" title="设置">
      <div className="narrow">
        <header className="pagehead">
          <div className="pagehead__text">
            <h1 className="pagehead__title">设置</h1>
            <p className="pagehead__sub">配置文件在 <span className="mono">~/.agentctl/config.yaml</span>，这里只放网页上能直接改的和需要知道的。</p>
          </div>
          {authRequired ? (
            <div className="pagehead__actions">
              <button className="btn" onClick={() => void logout()}>
                <Icon name="logout" size={15} />
                退出登录
              </button>
            </div>
          ) : null}
        </header>

        {error ? <div className="empty empty--error">{error}</div> : null}

        <section className="card section">
          <div className="section__head">
            <h2 className="section__title">外观</h2>
            <span className="section__hint">只保存在这个浏览器里</span>
          </div>
          <div className="themepick" role="radiogroup" aria-label="主题">
            {THEMES.map((t) => (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={pref === t.value}
                className={`themepick__opt${pref === t.value ? ' is-on' : ''}`}
                onClick={() => setThemePref(t.value)}
              >
                <span className={`themepick__swatch themepick__swatch--${t.value}`} aria-hidden="true" />
                <span className="themepick__label">
                  <Icon name={t.icon} size={14} />
                  {t.label}
                </span>
              </button>
            ))}
          </div>
        </section>

        <SourcesSection />
        <ChannelsSection />

        <section className="card section">
          <div className="section__head">
            <h2 className="section__title">Agent</h2>
          </div>
          <div className="agentlist">
            {agents.map((a) => (
              <div className="agentrow" key={a.id}>
                <AgentBadge agent={a.id} />
                <div className="agentrow__main">
                  <div className="agentrow__name">
                    {AGENT_LABEL[a.id]}
                    <span className={`status${a.available ? ' is-ok' : ''}`}>
                      <span className="status__dot" aria-hidden="true" />
                      {a.available ? '命令行可用' : '命令行未安装'}
                    </span>
                  </div>
                  <div className="agentrow__meta num">
                    <span>{a.sessionCount} 个会话</span>
                    <span>{LIVE_LABEL[String(a.capabilities.live)]}</span>
                    <span className="mono">{homeShorten(a.dataDir)}</span>
                    {a.binaryPath ? <span className="mono">{homeShorten(a.binaryPath)}</span> : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {stats ? (
          <section className="card section">
            <div className="section__head">
              <h2 className="section__title">索引</h2>
              <span className="section__hint">
                <span className="mono">~/.agentctl/index.db</span> 随时可以删，删掉只是重新扫一遍
              </span>
            </div>
            <dl className="statgrid num">
              <div>
                <dt>会话</dt>
                <dd>{stats.sessions}</dd>
              </div>
              <div>
                <dt>累计花费</dt>
                <dd>{formatCost(stats.totalCostUsd) || '—'}</dd>
              </div>
              <div>
                <dt>磁盘占用</dt>
                <dd>{formatBytes(stats.totalBytes)}</dd>
              </div>
              <div>
                <dt>最近活动</dt>
                <dd>{formatDateTime(stats.latestAt)}</dd>
              </div>
            </dl>
          </section>
        ) : null}

        <section className="card section">
          <div className="section__head">
            <h2 className="section__title">远程访问</h2>
          </div>
          <div className="prose">
            <p>
              默认只监听 <span className="mono">127.0.0.1</span>。手机要用，先 <span className="mono">pnpm passwd</span> 设密码，再把
              <span className="mono"> host </span>改成 Tailscale 地址或 <span className="mono">0.0.0.0</span>；没有密码时服务会拒绝绑定非回环地址。
            </p>
            <p>
              跨公网别裸跑明文 HTTP。套一层 HTTPS 反代，或者配置 <span className="mono">tls.cert</span> 与 <span className="mono">tls.key</span>；Tailscale
              之类的隧道本身已经加密。
            </p>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
