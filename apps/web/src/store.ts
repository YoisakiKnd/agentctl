import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { api } from './api';
import type { QuotaReport, RunInfo, SessionSummary, Stats } from './types';

/**
 * 几个页面共用的轮询数据（会话列表、套餐额度）：有人订阅才轮询，页面在后台时不问，
 * 回到前台立刻补一次。多个组件订阅同一份数据只发一次请求。
 */
interface Snapshot<T> {
  data: T | null;
  error: string;
  loading: boolean;
}

function createPoller<T, A = void>(fetcher: (arg?: A) => Promise<T>, intervalMs: number) {
  let snap: Snapshot<T> = { data: null, error: '', loading: false };
  const listeners = new Set<() => void>();
  let timer: number | undefined;
  let inflight: Promise<void> | null = null;

  const set = (next: Partial<Snapshot<T>>) => {
    snap = { ...snap, ...next };
    for (const fn of listeners) fn();
  };

  const refresh = (arg?: A): Promise<void> => {
    if (inflight && arg === undefined) return inflight;
    set({ loading: true });
    inflight = fetcher(arg)
      .then((data) => set({ data, error: '', loading: false }))
      .catch((err: unknown) => set({ error: err instanceof Error ? err.message : '加载失败', loading: false }))
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  const onVisible = () => {
    if (document.visibilityState === 'visible') void refresh();
  };

  const subscribe = (fn: () => void) => {
    listeners.add(fn);
    if (listeners.size === 1) {
      void refresh();
      timer = window.setInterval(() => {
        if (document.visibilityState === 'visible') void refresh();
      }, intervalMs);
      document.addEventListener('visibilitychange', onVisible);
    }
    return () => {
      listeners.delete(fn);
      if (listeners.size === 0) {
        clearInterval(timer);
        document.removeEventListener('visibilitychange', onVisible);
      }
    };
  };

  /** 本地改了数据（例如置顶）后直接替换，不必等下一次轮询 */
  const mutate = (fn: (cur: T) => T) => {
    if (snap.data) set({ data: fn(snap.data) });
  };

  return { subscribe, getSnapshot: () => snap, refresh, mutate };
}

type Poller<T, A> = ReturnType<typeof createPoller<T, A>>;

function usePoller<T, A>(p: Poller<T, A>) {
  const snap = useSyncExternalStore(p.subscribe, p.getSnapshot);
  const refresh = useCallback((arg?: A) => p.refresh(arg), [p]);
  return { ...snap, refresh };
}

export interface SessionsData {
  sessions: SessionSummary[];
  stats: Stats;
  runs: RunInfo[];
}

export const sessionsStore = createPoller<SessionsData, { rescan: boolean }>((arg) => api.sessions({ refresh: arg?.rescan }), 15_000);
export const quotaStore = createPoller<QuotaReport, { force: boolean }>((arg) => api.quota(arg?.force), 60_000);

export const useSessions = () => usePoller(sessionsStore);
export const useQuota = () => usePoller(quotaStore);

/** 某个会话的注解改了：同步到共享列表 */
export function patchSession(next: SessionSummary): void {
  sessionsStore.mutate((cur) => ({ ...cur, sessions: cur.sessions.map((s) => (s.id === next.id ? next : s)) }));
}

/** 正在运行的会话 id（网页里起的进程） */
export function useLiveIds(): Set<string> {
  const { data } = useSessions();
  const key = (data?.runs ?? [])
    .filter((r) => r.state !== 'exited' && r.sessionKey)
    .map((r) => r.sessionKey)
    .join('|');
  return useMemo(() => new Set(key ? key.split('|') : []), [key]);
}
