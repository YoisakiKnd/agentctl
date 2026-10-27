import { useMemo, useState } from 'react';
import { AgentBadge } from '../components/AgentBadge';
import Icon from '../components/Icon';
import AppShell from '../components/Layout';
import { QuotaAlert } from '../components/Quota';
import { formatBytes, formatCost, homeShorten, projectName, timeAgo } from '../format';
import { navigate, newSessionHref, searchHref, sessionHref } from '../router';
import { useLiveIds, useSessions } from '../store';
import type { AgentId, SessionSummary } from '../types';
import { AGENT_LABEL } from '../types';

const AGENTS: AgentId[] = ['claude', 'codex', 'dsh', 'pi', 'cursor'];

interface Group {
  cwd: string;
  sessions: SessionSummary[];
}

function SessionRow({
  s,
  live,
  showProject,
  onTag,
}: {
  s: SessionSummary;
  live: boolean;
  showProject?: boolean;
  onTag: (tag: string) => void;
}) {
  return (
    <a className={`srow${s.subagent ? ' srow--sub' : ''}`} href={sessionHref(s.id)}>
      <AgentBadge agent={s.agent} />
      <span className="srow__main">
        <span className="srow__title">
          {live ? <span className="live-dot" aria-label="运行中" /> : null}
          {s.pinned && !showProject ? <Icon name="star" size={13} filled className="srow__pin" /> : null}
          <span className="srow__t">{s.title}</span>
          {s.subagent ? <span className="pill pill--quiet" title="子代理会话：由 agent 自动发起">子代理 · {s.subagent}</span> : null}
          {s.tags?.map((t) => (
            <button
              key={t}
              type="button"
              className="pill pill--tag"
              title={`只看标签「${t}」`}
              onClick={(e) => {
                // 行本身是链接：点标签只筛选，不进会话
                e.preventDefault();
                onTag(t);
              }}
            >
              # {t}
            </button>
          ))}
        </span>
        <span className="srow__preview">{s.preview || <span className="is-faint">没有可预览的提问</span>}</span>
      </span>
      <span className="srow__meta num">
        <span className="srow__time">{timeAgo(s.updatedAt)}</span>
        <span className="srow__stats">
          {showProject ? <span>{projectName(s.cwd)}</span> : null}
          {s.turns > 0 ? <span>{s.turns} 轮</span> : null}
          {s.costUsd ? <span>{formatCost(s.costUsd)}</span> : null}
          <span className="srow__size">{formatBytes(s.sizeBytes)}</span>
        </span>
      </span>
    </a>
  );
}

export default function Dashboard() {
  const { data, error, loading, refresh } = useSessions();
  const live = useLiveIds();
  const [agent, setAgent] = useState<AgentId | 'all'>('all');
  const [tag, setTag] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const s of data?.sessions ?? []) out.set(s.agent, (out.get(s.agent) ?? 0) + 1);
    return out;
  }, [data]);

  const tagCounts = useMemo(() => {
    const out = new Map<string, number>();
    for (const s of data?.sessions ?? []) for (const t of s.tags ?? []) out.set(t, (out.get(t) ?? 0) + 1);
    return [...out].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [data]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (data?.sessions ?? []).filter((s) => {
      if (agent !== 'all' && s.agent !== agent) return false;
      if (tag && !s.tags?.includes(tag)) return false;
      if (!needle) return true;
      return `${s.title} ${s.cwd} ${s.preview ?? ''} ${(s.tags ?? []).join(' ')}`.toLowerCase().includes(needle);
    });
  }, [data, agent, tag, query]);

  // 置顶的单独列在最上面，不再在项目分组里重复出现
  const pinned = useMemo(() => filtered.filter((s) => s.pinned), [filtered]);

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, SessionSummary[]>();
    for (const s of filtered) {
      if (s.pinned) continue;
      const key = s.cwd || '';
      const list = map.get(key);
      if (list) list.push(s);
      else map.set(key, [s]);
    }
    return [...map.entries()]
      .map(([cwd, sessions]) => ({ cwd, sessions: [...sessions].sort((a, b) => b.mtime - a.mtime) }))
      .sort((a, b) => (b.sessions[0]?.mtime ?? 0) - (a.sessions[0]?.mtime ?? 0));
  }, [filtered]);

  const runningCount = live.size;

  return (
    <AppShell
      active="sessions"
      title="会话"
      actions={
        <a className="iconbtn" href={newSessionHref(undefined, agent === 'all' ? undefined : agent)} aria-label="新会话">
          <Icon name="plus" />
        </a>
      }
    >
      <header className="pagehead">
        <div className="pagehead__text">
          <h1 className="pagehead__title">会话</h1>
          {data ? (
            <p className="pagehead__sub num">
              {data.sessions.length} 个会话 · {projectCount(data.sessions)} 个项目
              {runningCount ? (
                <>
                  {' · '}
                  <span className="is-live">{runningCount} 个正在运行</span>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
        <div className="pagehead__actions">
          <label className="searchbox">
            <Icon name="search" size={15} />
            <input
              placeholder="筛选标题、路径、标签；回车搜全文"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // 输入框本身只筛列表；回车才去扫所有会话的内容
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && query.trim()) {
                  navigate(searchHref(query.trim(), agent === 'all' ? undefined : agent).slice(1));
                }
              }}
            />
          </label>
          <button
            type="button"
            className="iconbtn iconbtn--bordered"
            onClick={() => void refresh({ rescan: true })}
            disabled={loading}
            title="重新扫描会话文件"
            aria-label="重新扫描"
          >
            <Icon name="refresh" className={loading ? 'is-spinning' : undefined} />
          </button>
          <a className="btn btn--primary" href={newSessionHref(undefined, agent === 'all' ? undefined : agent)}>
            <Icon name="plus" size={15} />
            新会话
          </a>
        </div>
      </header>

      <QuotaAlert />

      <div className="filters">
        <div className="segmented" role="tablist" aria-label="按 agent 筛选">
          <button type="button" role="tab" aria-selected={agent === 'all'} className={agent === 'all' ? 'is-on' : ''} onClick={() => setAgent('all')}>
            全部 <span className="num">{data?.sessions.length ?? 0}</span>
          </button>
          {AGENTS.filter((a) => (counts.get(a) ?? 0) > 0).map((a) => (
            <button
              key={a}
              type="button"
              role="tab"
              aria-selected={agent === a}
              className={agent === a ? 'is-on' : ''}
              onClick={() => setAgent(a)}
              style={{ '--agent': `var(--${a})` } as React.CSSProperties}
            >
              <span className="segmented__dot" aria-hidden="true" />
              {AGENT_LABEL[a]} <span className="num">{counts.get(a)}</span>
            </button>
          ))}
        </div>
        {tagCounts.length ? (
          <div className="tagbar" aria-label="按标签筛选">
            {tagCounts.map(([t, n]) => (
              <button key={t} type="button" className={`pill pill--tag pill--btn${tag === t ? ' is-on' : ''}`} onClick={() => setTag(tag === t ? null : t)}>
                # {t} <span className="num">{n}</span>
              </button>
            ))}
            {tag ? (
              <button type="button" className="linkbtn" onClick={() => setTag(null)}>
                清除
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {error && !data ? <div className="empty empty--error">{error}</div> : null}
      {!data && !error ? <div className="skeleton-list" aria-label="加载中" /> : null}

      {data && data.sessions.length === 0 ? (
        <div className="empty">
          <Icon name="chat" size={28} />
          <p className="empty__title">还没有任何会话</p>
          <p className="empty__body">
            先在终端里跑一次 agent，比如 <span className="mono">claude</span>，它写的会话记录就会出现在这里；或者直接
            <a href={newSessionHref()}>开一个新会话</a>。
          </p>
        </div>
      ) : null}

      {data && data.sessions.length > 0 && filtered.length === 0 ? (
        <div className="empty">
          <Icon name="search" size={28} />
          <p className="empty__title">没有匹配的会话</p>
          <p className="empty__body">
            这里只筛标题、路径和标签。按回车可以在所有会话的内容里
            {query.trim() ? <a href={searchHref(query.trim())}>搜索「{query.trim()}」</a> : '搜索'}。
          </p>
        </div>
      ) : null}

      {pinned.length ? (
        <section className="card group">
          <div className="group__head">
            <Icon name="star" size={15} filled className="group__icon group__icon--pin" />
            <h2 className="group__name">置顶</h2>
            <span className="group__count num">{pinned.length}</span>
          </div>
          {pinned.map((s) => (
            <SessionRow s={s} key={s.id} live={live.has(s.id)} showProject onTag={setTag} />
          ))}
        </section>
      ) : null}

      {groups.map((g) => (
        <section className="card group" key={g.cwd || 'unknown'}>
          <div className="group__head">
            <Icon name="folder" size={15} className="group__icon" />
            <h2 className="group__name">{projectName(g.cwd)}</h2>
            <span className="group__path mono">{homeShorten(g.cwd)}</span>
            <span className="group__count num">{g.sessions.length}</span>
            {g.cwd ? (
              <a className="group__new" href={newSessionHref(g.cwd, g.sessions[0]?.agent)} title="在这个项目里开一个新会话" aria-label="在这个项目里开新会话">
                <Icon name="plus" size={14} />
              </a>
            ) : null}
          </div>
          {g.sessions.map((s) => (
            <SessionRow s={s} key={s.id} live={live.has(s.id)} onTag={setTag} />
          ))}
        </section>
      ))}
    </AppShell>
  );
}

function projectCount(sessions: SessionSummary[]): number {
  return new Set(sessions.map((s) => s.cwd)).size;
}
