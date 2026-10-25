import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { newSessionHref, sessionHref } from '../router';
import type { AgentId, RunInfo, SessionSummary, Stats } from '../types';
import { AGENT_LABEL } from '../types';
import { formatBytes, formatCost, homeShorten, projectName, timeAgo } from '../format';

const AGENTS: AgentId[] = ['claude', 'codex', 'dsh', 'pi', 'cursor'];

interface Group {
  cwd: string;
  sessions: SessionSummary[];
}

function SessionRow({ s, showAgent, live }: { s: SessionSummary; showAgent: boolean; live: boolean }) {
  return (
    <a
      className="sess"
      href={sessionHref(s.id)}
      style={{ '--agent': `var(--${s.agent})` } as React.CSSProperties}
    >
      <span className="sess__rail" aria-hidden="true" />
      <span className="sess__title">
        {live ? <span className="live-dot" aria-label="运行中" /> : null}
        <span className="sess__t">{s.title}</span>
        {showAgent ? <span className="sess__agent">{AGENT_LABEL[s.agent]}</span> : null}
      </span>
      <span className="sess__time num">{timeAgo(s.updatedAt)}</span>
      <span className="sess__preview">{s.preview || <span className="is-faint">没有可预览的提问</span>}</span>
      <span className="sess__cost num">{formatCost(s.costUsd)}</span>
      <span className="sess__size num">{formatBytes(s.sizeBytes)}</span>
    </a>
  );
}

export default function Dashboard() {
  const [data, setData] = useState<{ sessions: SessionSummary[]; stats: Stats; runs: RunInfo[] } | null>(null);
  const [error, setError] = useState('');
  const [agent, setAgent] = useState<AgentId | 'all'>('all');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    setError('');
    try {
      setData(await api.sessions({ refresh }));
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 静默刷新：新会话、运行标记、轮次 / 花费变化 15 秒内出现在列表里
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      api
        .sessions()
        .then(setData)
        .catch(() => undefined);
    }, 15_000);
    return () => clearInterval(timer);
  }, []);

  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const s of data?.sessions ?? []) out.set(s.agent, (out.get(s.agent) ?? 0) + 1);
    return out;
  }, [data]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (data?.sessions ?? []).filter((s) => {
      if (agent !== 'all' && s.agent !== agent) return false;
      if (!needle) return true;
      return `${s.title} ${s.cwd} ${s.preview ?? ''}`.toLowerCase().includes(needle);
    });
  }, [data, agent, query]);

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, SessionSummary[]>();
    for (const s of filtered) {
      const key = s.cwd || '';
      const list = map.get(key);
      if (list) list.push(s);
      else map.set(key, [s]);
    }
    return [...map.entries()]
      .map(([cwd, sessions]) => ({
        cwd,
        sessions: [...sessions].sort((a, b) => b.mtime - a.mtime),
      }))
      .sort((a, b) => (b.sessions[0]?.mtime ?? 0) - (a.sessions[0]?.mtime ?? 0));
  }, [filtered]);

  const liveIds = useMemo(
    () => new Set((data?.runs ?? []).filter((r) => r.state !== 'exited').map((r) => r.sessionKey)),
    [data],
  );

  const stats = data?.stats;
  const title = agent === 'all' ? '全部会话' : AGENT_LABEL[agent];

  return (
    <div className="shell">
      <aside className="spine">
        <div className="spine__brand">agentctl</div>

        <nav className="spine__agents">
          <button
            className={`nav${agent === 'all' ? ' is-active' : ''}`}
            onClick={() => setAgent('all')}
            style={{ '--agent': 'var(--text-dim)' } as React.CSSProperties}
          >
            <span className="nav__label">全部会话</span>
            <span className="nav__count num">{data?.sessions.length ?? 0}</span>
          </button>
          {AGENTS.filter((a) => (counts.get(a) ?? 0) > 0).map((a) => (
            <button
              key={a}
              className={`nav${agent === a ? ' is-active' : ''}`}
              onClick={() => setAgent(a)}
              style={{ '--agent': `var(--${a})` } as React.CSSProperties}
            >
              <span className="nav__label">{AGENT_LABEL[a]}</span>
              <span className="nav__count num">{counts.get(a)}</span>
            </button>
          ))}
        </nav>

        {stats ? (
          <dl className="spine__stats">
            <div>
              <dt>累计花费</dt>
              <dd className="num">{formatCost(stats.totalCostUsd) || '—'}</dd>
            </div>
            <div>
              <dt>磁盘占用</dt>
              <dd className="num">{formatBytes(stats.totalBytes)}</dd>
            </div>
            <div>
              <dt>最近活动</dt>
              <dd className="num">{stats.latestAt ? timeAgo(stats.latestAt) : '—'}</dd>
            </div>
          </dl>
        ) : null}

        <div className="spine__foot">
          <button className="linkbtn" onClick={() => void load(true)} disabled={busy}>
            {busy ? '扫描中…' : '重新扫描'}
          </button>
          <a className="linkbtn" href="#/settings">
            设置
          </a>
        </div>
      </aside>

      <main className="board">
        <header className="board__head">
          <h1 className="board__title">{title}</h1>
          <input
            className="input input--search"
            placeholder="搜索标题、路径、首条消息"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <a className="btn btn--sm btn--primary board__new" href={newSessionHref()}>
            新会话
          </a>
        </header>

        {error ? <div className="empty empty--error">{error}</div> : null}

        {!error && data && data.sessions.length === 0 ? (
          <div className="empty">
            <p className="empty__title">还没有任何会话</p>
            <p className="empty__body">
              先在终端里跑一次 agent，比如 <span className="mono">claude</span>，它写的会话记录就会出现在这里。
            </p>
          </div>
        ) : null}

        {!error && data && data.sessions.length > 0 && filtered.length === 0 ? (
          <div className="empty">
            <p className="empty__title">没有匹配的会话</p>
            <p className="empty__body">换个关键词，或者回到「全部会话」。</p>
          </div>
        ) : null}

        {groups.map((g) => (
          <section className="group" key={g.cwd || 'unknown'}>
            <div className="group__head">
              <h2 className="group__name">{projectName(g.cwd)}</h2>
              <span className="group__path mono">{homeShorten(g.cwd)}</span>
              <span className="group__count num">{g.sessions.length}</span>
              {g.cwd ? (
                <a className="linkbtn group__new" href={newSessionHref(g.cwd)} title="在这个项目里开一个新会话">
                  ＋ 新会话
                </a>
              ) : null}
            </div>
            {g.sessions.map((s) => (
              <SessionRow
                s={s}
                key={s.id}
                live={liveIds.has(s.id)}
                showAgent={new Set(g.sessions.map((x) => x.agent)).size > 1}
              />
            ))}
          </section>
        ))}
      </main>
    </div>
  );
}
