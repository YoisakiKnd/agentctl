import { useEffect, useState } from 'react';

export type Route =
  | { name: 'dashboard' }
  | { name: 'session'; id: string; at?: number }
  | { name: 'search'; q: string; agent?: string }
  | { name: 'shell'; id: string; kind: 'agent' | 'shell' }
  | { name: 'new'; cwd?: string; agent?: 'claude' | 'codex' | 'dsh' }
  | { name: 'usage'; days: number; agent?: string }
  | { name: 'settings' }
  | { name: 'login' };

export function parseHash(hash: string): Route {
  const [path, query = ''] = (hash.replace(/^#/, '') || '/').split('?');
  if (path === '/' || path === '') return { name: 'dashboard' };
  if (path === '/new') {
    const q = new URLSearchParams(query);
    const agent = q.get('agent');
    return { name: 'new', cwd: q.get('cwd') ?? undefined, agent: agent === 'codex' || agent === 'claude' || agent === 'dsh' ? agent : undefined };
  }
  if (path === '/settings') return { name: 'settings' };
  if (path === '/usage') {
    const q = new URLSearchParams(query);
    const days = Number(q.get('days') ?? 30);
    return { name: 'usage', days: Number.isInteger(days) && days >= 0 ? days : 30, agent: q.get('agent') ?? undefined };
  }
  if (path === '/login') return { name: 'login' };
  const sh = /^\/s\/(.+)\/shell$/.exec(path);
  if (sh) {
    const kind = new URLSearchParams(query).get('kind') === 'shell' ? 'shell' : 'agent';
    return { name: 'shell', id: decodeURIComponent(sh[1]), kind };
  }
  if (path === '/search') {
    const q = new URLSearchParams(query);
    return { name: 'search', q: q.get('q') ?? '', agent: q.get('agent') ?? undefined };
  }
  const m = /^\/s\/(.+)$/.exec(path);
  if (m) {
    const at = Number(new URLSearchParams(query).get('at'));
    return { name: 'session', id: decodeURIComponent(m[1]), at: Number.isInteger(at) && at >= 0 && query.includes('at=') ? at : undefined };
  }
  return { name: 'dashboard' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(to: string): void {
  location.hash = to;
}

export function sessionHref(id: string, at?: number): string {
  return `#/s/${encodeURIComponent(id)}${at !== undefined ? `?at=${at}` : ''}`;
}

export function searchHref(q: string, agent?: string): string {
  const p = new URLSearchParams({ q });
  if (agent) p.set('agent', agent);
  return `#/search?${p}`;
}

export function newSessionHref(cwd?: string, agent?: string): string {
  const q = new URLSearchParams();
  if (cwd) q.set('cwd', cwd);
  if (agent) q.set('agent', agent);
  const qs = q.toString();
  return qs ? `#/new?${qs}` : '#/new';
}

export function shellHref(id: string, kind: 'agent' | 'shell' = 'agent'): string {
  return `#/s/${encodeURIComponent(id)}/shell${kind === 'shell' ? '?kind=shell' : ''}`;
}

export function usageHref(days = 30, agent?: string): string {
  const p = new URLSearchParams({ days: String(days) });
  if (agent) p.set('agent', agent);
  return `#/usage?${p}`;
}
