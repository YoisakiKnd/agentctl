import { useEffect, useState } from 'react';

export type Route =
  | { name: 'dashboard' }
  | { name: 'session'; id: string }
  | { name: 'shell'; id: string; kind: 'agent' | 'shell' }
  | { name: 'new'; cwd?: string; agent?: 'claude' | 'codex' | 'dsh' }
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
  if (path === '/login') return { name: 'login' };
  const sh = /^\/s\/(.+)\/shell$/.exec(path);
  if (sh) {
    const kind = new URLSearchParams(query).get('kind') === 'shell' ? 'shell' : 'agent';
    return { name: 'shell', id: decodeURIComponent(sh[1]), kind };
  }
  const m = /^\/s\/(.+)$/.exec(path);
  if (m) return { name: 'session', id: decodeURIComponent(m[1]) };
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

export function sessionHref(id: string): string {
  return `#/s/${encodeURIComponent(id)}`;
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
