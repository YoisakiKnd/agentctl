import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { NotifyChannel, NotifyItem } from '../types';
import Icon from './Icon';

const SEEN_KEY = 'agentctl.notify-seen';
const POLL_MS = 30_000;
const TOAST_MS = 12_000;

function readSeen(): number | null {
  try {
    const v = localStorage.getItem(SEEN_KEY);
    return v === null ? null : Number(v) || 0;
  } catch {
    return null;
  }
}

function writeSeen(id: number): void {
  try {
    localStorage.setItem(SEEN_KEY, String(id));
  } catch {
    /* 存不了：下次打开会把最近的再提示一遍 */
  }
}

/** 浏览器通知只在 HTTPS 或 localhost 下可用（通过 Tailscale 的 http 地址打开时不行） */
export function browserNotifySupported(): boolean {
  return typeof Notification !== 'undefined' && window.isSecureContext;
}

const ICON: Record<NotifyItem['event'], 'refresh' | 'alert' | 'gauge' | 'check'> = {
  reset: 'refresh',
  warn: 'alert',
  low: 'alert',
  test: 'check',
};

/**
 * 网页里的提醒：服务端检测到套餐刷新 / 快用完 / 余额不足后记一条日志，
 * 这里定时去拿新的，右下角弹出；有开着的「浏览器通知」渠道且已授权时，再弹系统通知。
 * 第一次打开只记下当前位置，不把历史提醒全翻出来。
 */
export default function Notifier() {
  const [toasts, setToasts] = useState<NotifyItem[]>([]);
  const channels = useRef<NotifyChannel[]>([]);

  useEffect(() => {
    let alive = true;
    const loadChannels = () =>
      api
        .channels()
        .then((r) => (channels.current = r.channels))
        .catch(() => undefined);

    const poll = async () => {
      if (document.visibilityState !== 'visible' && !browserNotifySupported()) return;
      const seen = readSeen();
      let items: NotifyItem[];
      try {
        items = (await api.notifications(seen ?? 0)).items;
      } catch {
        return;
      }
      if (!alive) return;
      if (!items.length) {
        if (seen === null) writeSeen(0);
        return;
      }
      const max = Math.max(...items.map((i) => i.id));
      writeSeen(max);
      if (seen === null) return;
      const fresh = items.filter((i) => i.id > seen).sort((a, b) => a.id - b.id);
      setToasts((cur) => [...cur, ...fresh].slice(-4));
      for (const item of fresh) {
        const wanted = channels.current.some((c) => c.kind === 'browser' && c.enabled && (item.event === 'test' || c.events.includes(item.event)));
        if (wanted && browserNotifySupported() && Notification.permission === 'granted') {
          new Notification(item.title, { body: item.body, tag: `agentctl-${item.id}` });
        }
        setTimeout(() => alive && setToasts((cur) => cur.filter((t) => t.id !== item.id)), TOAST_MS);
      }
    };

    void loadChannels().then(poll);
    const timer = setInterval(() => void poll(), POLL_MS);
    const chTimer = setInterval(() => void loadChannels(), 5 * 60_000);
    const onVisible = () => document.visibilityState === 'visible' && void poll();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      clearInterval(chTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.event}`}>
          <Icon name={ICON[t.event] ?? 'gauge'} size={16} />
          <div className="toast__body">
            <div className="toast__title">{t.title}</div>
            <div className="toast__text">{t.body}</div>
          </div>
          <button type="button" className="iconbtn iconbtn--xs" onClick={() => setToasts((cur) => cur.filter((x) => x.id !== t.id))} aria-label="关闭">
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
