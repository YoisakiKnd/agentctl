import { useEffect, useState, type ReactNode } from 'react';
import { timeAgo } from '../format';
import { newSessionHref, searchHref, sessionHref, usageHref } from '../router';
import { useLiveIds, useSessions } from '../store';
import Icon, { type IconName } from './Icon';
import { QuotaPanel } from './Quota';

const DRAWER_EVENT = 'agentctl:drawer';

/** 窄屏下打开侧栏抽屉的按钮，给自带头部的页面用 */
export function DrawerButton() {
  return (
    <button type="button" className="iconbtn drawer-btn" onClick={() => window.dispatchEvent(new Event(DRAWER_EVENT))} aria-label="打开侧栏">
      <Icon name="menu" />
    </button>
  );
}

export type NavKey = 'sessions' | 'search' | 'usage' | 'settings' | 'new' | 'session';

/** 四个 agent 的身份色拼成的标志：这个工具管的就是它们 */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <rect x="1" y="1" width="8" height="8" rx="2.5" fill="var(--claude)" />
      <rect x="11" y="1" width="8" height="8" rx="2.5" fill="var(--codex)" />
      <rect x="1" y="11" width="8" height="8" rx="2.5" fill="var(--dsh)" />
      <rect x="11" y="11" width="8" height="8" rx="2.5" fill="var(--pi)" />
    </svg>
  );
}

const NAV: { key: NavKey; label: string; icon: IconName; href: string }[] = [
  { key: 'sessions', label: '会话', icon: 'chat', href: '#/' },
  { key: 'search', label: '搜索', icon: 'search', href: searchHref('') },
  { key: 'usage', label: '用量', icon: 'chart', href: usageHref() },
  { key: 'settings', label: '设置', icon: 'sliders', href: '#/settings' },
];

/** 侧栏默认内容：最近的会话，正在跑的带红点 */
export function RecentSessions({ currentId, limit = 40 }: { currentId?: string; limit?: number }) {
  const { data } = useSessions();
  const live = useLiveIds();
  const sessions = (data?.sessions ?? []).slice(0, limit);
  if (!sessions.length) return null;
  return (
    <div className="side__section">
      <div className="side__label">最近</div>
      <div className="recent">
        {sessions.map((s) => (
          <a
            key={s.id}
            href={sessionHref(s.id)}
            className={`recent__item${s.id === currentId ? ' is-active' : ''}${s.subagent ? ' is-sub' : ''}`}
            style={{ '--agent': `var(--${s.agent})` } as React.CSSProperties}
            title={s.title}
          >
            <span className="recent__dot" aria-hidden="true" />
            <span className="recent__title">{s.title}</span>
            {live.has(s.id) ? <span className="live-dot" aria-label="运行中" /> : <span className="recent__time num">{timeAgo(s.updatedAt)}</span>}
          </a>
        ))}
      </div>
    </div>
  );
}

/**
 * 除终端、登录外所有页面共用的外壳：左侧栏（导航、最近会话或页面自己的筛选、额度）+ 主区。
 * 窄屏时侧栏收成抽屉，顶上一条标题栏。
 */
export default function AppShell({
  active,
  title,
  actions,
  side,
  currentId,
  children,
  bare = false,
  topbar = true,
}: {
  active: NavKey;
  /** 窄屏顶栏里的标题 */
  title?: ReactNode;
  /** 窄屏顶栏右侧的按钮 */
  actions?: ReactNode;
  /** 替换侧栏中段（默认是最近会话） */
  side?: ReactNode;
  currentId?: string;
  children: ReactNode;
  /** 主区不加内边距与最大宽度（会话页自己管布局） */
  bare?: boolean;
  /** 窄屏也不要通用顶栏（会话页有自己的头部，里面放 DrawerButton） */
  topbar?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { data } = useSessions();

  // 换页就收起抽屉；页面自己的头部可以用 DrawerButton 打开它
  useEffect(() => {
    const close = () => setOpen(false);
    const show = () => setOpen(true);
    window.addEventListener('hashchange', close);
    window.addEventListener(DRAWER_EVENT, show);
    return () => {
      window.removeEventListener('hashchange', close);
      window.removeEventListener(DRAWER_EVENT, show);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className={`app${open ? ' is-drawer' : ''}`}>
      <aside className="side" aria-label="导航">
        <div className="side__top">
          <a className="side__brand" href="#/">
            <Logo />
            <span>agentctl</span>
          </a>
          <button type="button" className="iconbtn side__close" onClick={() => setOpen(false)} aria-label="收起侧栏">
            <Icon name="x" />
          </button>
        </div>
        <a className={`side__new${active === 'new' ? ' is-active' : ''}`} href={newSessionHref()}>
          <Icon name="plus" />
          新会话
        </a>
        <nav className="side__nav">
          {NAV.map((n) => (
            <a key={n.key} href={n.href} className={`navitem${active === n.key ? ' is-active' : ''}`} aria-current={active === n.key ? 'page' : undefined}>
              <Icon name={n.icon} />
              <span className="navitem__label">{n.label}</span>
              {n.key === 'sessions' && data ? <span className="navitem__count num">{data.sessions.length}</span> : null}
            </a>
          ))}
        </nav>
        <div className="side__body">{side ?? <RecentSessions currentId={currentId} />}</div>
        <QuotaPanel />
      </aside>
      <div className="side-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />

      <div className="main">
        {topbar ? (
        <header className="topbar">
          <button type="button" className="iconbtn" onClick={() => setOpen(true)} aria-label="打开侧栏">
            <Icon name="menu" />
          </button>
          <div className="topbar__title">{title}</div>
          <div className="topbar__actions">{actions}</div>
        </header>
        ) : null}
        {bare ? children : <div className="page">{children}</div>}
      </div>
    </div>
  );
}
