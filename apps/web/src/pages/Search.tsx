import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { clockTime, homeShorten, projectName, timeAgo } from '../format';
import { navigate, searchHref, sessionHref } from '../router';
import type { AgentId, SearchHit, SearchResult } from '../types';
import { AGENT_LABEL } from '../types';
import { AgentBadge } from '../components/AgentBadge';
import Icon from '../components/Icon';
import AppShell from '../components/Layout';

const AGENTS: AgentId[] = ['claude', 'codex', 'dsh', 'pi'];

const KIND_LABEL: Record<SearchHit['kind'], string> = {
  text: '消息',
  thinking: '思考',
  tool_call: '工具',
  tool_result: '输出',
  diff: '改动',
  notice: '提示',
  approval: '审批',
  usage: '用量',
};

function hitLabel(h: SearchHit): string {
  if (h.kind === 'text') return h.role === 'user' ? '提问' : '回复';
  return KIND_LABEL[h.kind];
}

/** 全文搜索：直接扫所有会话文件，不建索引 */
export default function Search({ q: initial, agent }: { q: string; agent?: string }) {
  const [input, setInput] = useState(initial);
  const [data, setData] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => setInput(initial), [initial]);

  // 路由上的 q 才是"已提交的搜索"；输入框里的只是草稿
  useEffect(() => {
    if (!initial.trim()) {
      setData(null);
      return;
    }
    const ctrl = new AbortController();
    setBusy(true);
    setError('');
    api
      .search(initial, agent, ctrl.signal)
      .then(setData)
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : '搜索失败');
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setBusy(false);
      });
    return () => ctrl.abort();
  }, [initial, agent]);

  const submit = (nextAgent = agent) => {
    const q = input.trim();
    if (q) navigate(searchHref(q, nextAgent).slice(1));
  };

  return (
    <AppShell active="search" title="搜索">
      <header className="pagehead">
        <div className="pagehead__text">
          <h1 className="pagehead__title">全文搜索</h1>
          <p className="pagehead__sub">不建索引，每次直接扫描所有会话文件；只匹配看得到的内容：提问、回复、思考、命令、输出、改动。</p>
        </div>
      </header>

      <form
        className="bigsearch"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Icon name="search" size={18} />
        <input
          ref={field}
          placeholder="搜所有会话里的提问、回复、命令、输出、改动"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          autoFocus
        />
        <button className="btn btn--primary" type="submit" disabled={!input.trim() || busy}>
          搜索
        </button>
      </form>

      <div className="filters">
        <div className="segmented" role="tablist" aria-label="按 agent 筛选">
          {[undefined, ...AGENTS].map((a) => (
            <button
              key={a ?? 'all'}
              type="button"
              role="tab"
              aria-selected={agent === a}
              className={agent === a ? 'is-on' : ''}
              style={a ? ({ '--agent': `var(--${a})` } as React.CSSProperties) : undefined}
              onClick={() => {
                if (initial.trim()) navigate(searchHref(initial, a).slice(1));
              }}
              disabled={!initial.trim()}
            >
              {a ? <span className="segmented__dot" aria-hidden="true" /> : null}
              {a ? AGENT_LABEL[a] : '全部'}
            </button>
          ))}
        </div>
      </div>

      {busy ? (
        <div className="statusline">
          <Icon name="refresh" size={14} className="is-spinning" />
          正在扫描会话文件…
        </div>
      ) : null}
      {error ? <div className="empty empty--error">{error}</div> : null}
      {!busy && data ? (
        <div className="statusline num">
          {data.total ? `${data.total} 处命中，${data.results.length} 个会话` : '没有找到'}
          <span className="is-faint"> · {(data.ms / 1000).toFixed(1)}s</span>
          {data.truncated ? <span className="is-faint"> · 结果过多，只显示最近会话里的前 {data.total} 处</span> : null}
        </div>
      ) : null}

      {!busy &&
        data?.results.map(({ session, hits }) => (
          <section className="card group" key={session.id}>
            <div className="group__head">
              <AgentBadge agent={session.agent} size="sm" />
              <h2 className="group__name">
                <a href={sessionHref(session.id)}>{session.title}</a>
              </h2>
              <span className="group__path">
                {projectName(session.cwd)} · {timeAgo(session.updatedAt)}
              </span>
              <span className="group__count num">{hits.length}</span>
            </div>
            {hits.map((h) => (
              <a
                className="hit"
                key={`${h.offset}:${h.uid ?? ''}`}
                href={sessionHref(session.id, h.offset)}
                style={{ '--agent': `var(--${session.agent})` } as React.CSSProperties}
                title={homeShorten(session.cwd)}
              >
                <span className="hit__meta num">
                  <span className="hit__kind">{hitLabel(h)}</span>
                  {h.turn > 0 ? <span>第 {h.turn} 轮</span> : null}
                  <span>{clockTime(h.ts)}</span>
                </span>
                <span className="hit__text">
                  {h.before}
                  <mark>{h.match}</mark>
                  {h.after}
                </span>
              </a>
            ))}
          </section>
        ))}
    </AppShell>
  );
}
