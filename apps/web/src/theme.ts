import { useEffect, useState } from 'react';

export type ThemePref = 'system' | 'dark' | 'light';

const KEY = 'agentctl.theme';
const listeners = new Set<() => void>();

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' ? v : 'system';
  } catch {
    return 'system';
  }
}

const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;

/** 实际生效的主题；跟随系统时看系统设置 */
export function resolvedTheme(pref = read()): 'dark' | 'light' {
  if (pref !== 'system') return pref;
  return media?.matches ? 'light' : 'dark';
}

/** 把主题落到 <html data-theme>，并同步浏览器顶栏颜色 */
export function applyTheme(): void {
  const theme = resolvedTheme();
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', theme === 'light' ? '#f6f5f2' : '#0e1015');
  for (const fn of listeners) fn();
}

media?.addEventListener('change', () => {
  if (read() === 'system') applyTheme();
});

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* 隐私模式写不进去：只对本页生效 */
  }
  applyTheme();
}

export function useTheme(): { pref: ThemePref; theme: 'dark' | 'light' } {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return { pref: read(), theme: resolvedTheme() };
}
