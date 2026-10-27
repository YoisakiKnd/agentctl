import { useState } from 'react';
import { useQuota } from '../store';
import type { AgentId, QuotaEntry, QuotaWindow } from '../types';
import Icon from './Icon';

export type QuotaLevel = 'ok' | 'warn' | 'critical';

/** 用到提醒线算 warn；95% 以上或已被限流算 critical */
export function levelOf(percent: number, warn: number, blocked = false): QuotaLevel {
  if (blocked || percent >= 95) return 'critical';
  if (percent >= warn) return 'warn';
  return 'ok';
}

const PLAN_LABEL: Record<string, string> = { pro: 'Pro', max: 'Max', plus: 'Plus', team: 'Team', free: 'Free', enterprise: 'Enterprise' };

export function planLabel(plan?: string): string {
  if (!plan) return '';
  return PLAN_LABEL[plan.toLowerCase()] ?? plan;
}

/** 「2 小时 5 分后重置」；超过一天显示星期与时间 */
export function resetText(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = t - Date.now();
  if (diff <= 0) return '即将重置';
  const min = Math.round(diff / 60_000);
  if (min < 60) return `${min} 分钟后重置`;
  if (min < 24 * 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${h} 小时${m ? ` ${m} 分` : ''}后重置`;
  }
  const d = new Date(t);
  const wd = '日一二三四五六'[d.getDay()];
  return `周${wd} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 重置`;
}

function Meter({ w, warn, blocked, compact }: { w: QuotaWindow; warn: number; blocked?: boolean; compact?: boolean }) {
  const level = levelOf(w.usedPercent, warn, blocked && w.usedPercent >= 100);
  const pct = Math.max(0, Math.min(100, w.usedPercent));
  return (
    <div className={`meter meter--${level}${compact ? ' meter--compact' : ''}`}>
      <div className="meter__head">
        <span className="meter__label">{w.label || '额度'}</span>
        <span className="meter__value num">
          {level !== 'ok' ? <Icon name="alert" size={12} /> : null}
          {Math.round(w.usedPercent)}%
        </span>
      </div>
      <div
        className="meter__track"
        role="meter"
        aria-label={`${w.label}额度已用`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(w.usedPercent)}
      >
        <div className="meter__fill" style={{ width: `${pct}%` }} />
      </div>
      {w.resetsAt ? <div className="meter__reset num">{resetText(w.resetsAt)}</div> : null}
    </div>
  );
}

function ago(iso?: string): string {
  if (!iso) return '';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return '刚刚更新';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前更新`;
  return `${Math.floor(s / 3600)} 小时前更新`;
}

export function QuotaAgent({ q, warn, compact }: { q: QuotaEntry; warn: number; compact?: boolean }) {
  return (
    <div className="quota" style={{ '--agent': q.agent ? `var(--${q.agent})` : 'var(--text-3)' } as React.CSSProperties}>
      <div className="quota__head">
        <span className="quota__dot" aria-hidden="true" />
        <span className="quota__name">{q.name}</span>
        {q.plan ? <span className="quota__plan">{planLabel(q.plan)}</span> : null}
        {q.blocked ? <span className="quota__blocked">已限流</span> : null}
      </div>
      {q.windows?.length ? (
        q.windows.map((w) => <Meter key={w.id} w={w} warn={warn} blocked={q.blocked} compact={compact} />)
      ) : q.balance ? (
        <div className={`balance${q.balance.lowBelow !== undefined && q.balance.amount < q.balance.lowBelow ? ' is-low' : ''}`}>
          <span className="balance__label">余额</span>
          <span className="balance__value num">
            {q.balance.lowBelow !== undefined && q.balance.amount < q.balance.lowBelow ? <Icon name="alert" size={12} /> : null}
            {q.balance.amount.toLocaleString()} {q.balance.unit ?? ''}
          </span>
        </div>
      ) : (
        <div className="quota__empty">{q.error ? `取不到：${q.error}` : q.enabled ? '正在查询…' : '已停用'}</div>
      )}
      {q.error && (q.windows?.length || q.balance) ? <div className="quota__empty">最近一次失败：{q.error}</div> : null}
      {q.credits?.enabled ? (
        <div className="quota__credits num">
          额外额度{q.credits.unlimited ? '：不限' : q.credits.balance ? `余额 ${q.credits.balance}` : q.credits.usedPercent !== undefined ? `已用 ${Math.round(q.credits.usedPercent)}%` : '已开启'}
        </div>
      ) : null}
    </div>
  );
}

const PANEL_KEY = 'agentctl.quota-panel';

/** 侧栏底部：各 agent 的 5 小时 / 每周额度；收起时标题行仍显示最紧张的那个窗口 */
export function QuotaPanel() {
  const { data, loading, refresh } = useQuota();
  // 记住展开状态；没记过时窄屏默认收起（抽屉里地方小，给最近会话让位）
  const [open, setOpenState] = useState(() => {
    try {
      const v = localStorage.getItem(PANEL_KEY);
      if (v) return v === '1';
    } catch {
      /* 读不到就用默认 */
    }
    return !matchMedia('(max-width: 900px)').matches;
  });
  const setOpen = (fn: (v: boolean) => boolean) =>
    setOpenState((cur) => {
      const next = fn(cur);
      try {
        localStorage.setItem(PANEL_KEY, next ? '1' : '0');
      } catch {
        /* 存不了只影响下次默认值 */
      }
      return next;
    });
  const sources = data?.agents.filter((q) => q.enabled) ?? [];
  if (!data || !sources.length) return null;
  const warn = data.warnPercent;
  const worst = sources.flatMap((q) => (q.windows ?? []).map((w) => levelOf(w.usedPercent, warn, q.blocked)));
  const alert = worst.includes('critical') ? 'critical' : worst.includes('warn') ? 'warn' : 'ok';
  const fetched = sources.map((q) => q.fetchedAt).filter(Boolean).sort()[0];
  const top = Math.max(0, ...sources.flatMap((q) => (q.windows ?? []).map((w) => w.usedPercent)));
  const peak = `最高 ${Math.round(top)}%`;
  return (
    <section className={`side-quota side-quota--${alert}`}>
      <button type="button" className="side-quota__toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon name="gauge" size={14} />
        <span>套餐额度</span>
        {alert !== 'ok' ? <span className="side-quota__flag">{alert === 'critical' ? '快用完' : '注意'}</span> : null}
        {!open ? <span className="side-quota__peak num">{peak}</span> : null}
        <Icon name={open ? 'chevronDown' : 'chevron'} size={14} className="side-quota__chev" />
      </button>
      {open ? (
        <>
          {sources.map((q) => (
            <QuotaAgent key={q.id} q={q} warn={warn} compact />
          ))}
          <div className="side-quota__foot">
            <span>{ago(fetched)}</span>
            <button type="button" className="iconbtn iconbtn--xs" onClick={() => void refresh({ force: true })} disabled={loading} title="立即刷新">
              <Icon name="refresh" size={13} className={loading ? 'is-spinning' : undefined} />
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

const DISMISS_KEY = 'agentctl.quota-dismissed';

function dismissed(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(DISMISS_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/**
 * 额度提醒条：任一窗口到了提醒线就出现。可以关掉，但只在这个窗口这一档内有效——
 * 重置之后再到提醒线、或者从「注意」升到「快用完」，会重新出现。
 */
export function QuotaAlert({ agent }: { agent?: AgentId }) {
  const { data } = useQuota();
  const [, force] = useState(0);
  if (!data) return null;
  const warn = data.warnPercent;
  const hits = data.agents
    .filter((q) => q.enabled && (!agent || q.agent === agent))
    .flatMap((q) =>
      (q.windows ?? [])
        .map((w) => ({ q, w, level: levelOf(w.usedPercent, warn, q.blocked && w.usedPercent >= 100) }))
        .filter((h) => h.level !== 'ok'),
    );
  const gone = dismissed();
  const keyOf = (h: (typeof hits)[number]) => `${h.q.id}:${h.w.id}:${h.w.resetsAt ?? ''}:${h.level}`;
  const shown = hits.filter((h) => !gone.has(keyOf(h)));
  if (!shown.length) return null;
  const critical = shown.some((h) => h.level === 'critical');
  const close = () => {
    const next = dismissed();
    for (const h of shown) next.add(keyOf(h));
    try {
      sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...next]));
    } catch {
      /* 存不了就只关这一次渲染 */
    }
    force((n) => n + 1);
  };
  return (
    <div className={`alert alert--${critical ? 'critical' : 'warn'}`} role="status">
      <Icon name="alert" size={16} />
      <div className="alert__body">
        {shown.map((h) => (
          <div key={keyOf(h)}>
            <strong>
              {h.q.name} {h.w.label}额度已用 {Math.round(h.w.usedPercent)}%
            </strong>
            <span className="alert__sub">{h.w.resetsAt ? ` · ${resetText(h.w.resetsAt)}` : ''}</span>
          </div>
        ))}
      </div>
      <button type="button" className="iconbtn iconbtn--xs" onClick={close} aria-label="关闭提醒">
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
