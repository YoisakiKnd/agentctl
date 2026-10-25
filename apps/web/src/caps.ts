import { useEffect, useState } from 'react';
import { api } from './api';

let cache: Promise<boolean> | null = null;

/** 服务端是否允许网页端使用 bypassPermissions（config.yaml 的 allowBypassPermissions） */
export function useAllowBypass(): boolean {
  const [allow, setAllow] = useState(false);
  useEffect(() => {
    cache ??= api
      .health()
      .then((h) => h.allowBypass !== false)
      .catch(() => {
        cache = null;
        return false;
      });
    let alive = true;
    void cache.then((v) => alive && setAllow(v));
    return () => {
      alive = false;
    };
  }, []);
  return allow;
}
