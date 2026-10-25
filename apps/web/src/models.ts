import { useEffect, useState } from 'react';
import { api } from './api';
import type { ModelInfo } from './types';

/** 拿不到 CLI 列表时（旧版本、命令行不可用）的兜底 */
const FALLBACK: ModelInfo[] = [
  { value: 'default', displayName: 'Default' },
  { value: 'opus', displayName: 'Opus' },
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'haiku', displayName: 'Haiku' },
];

let cache: Promise<ModelInfo[]> | null = null;

/** 模型列表直接来自 CLI 的 initialize 握手，与终端里 /model 看到的一致 */
export function useModels(): ModelInfo[] {
  const [models, setModels] = useState<ModelInfo[]>(FALLBACK);
  useEffect(() => {
    cache ??= api
      .models('claude')
      .then((r) => (r.models.length ? r.models : FALLBACK))
      .catch(() => {
        cache = null; // 下次再试
        return FALLBACK;
      });
    let alive = true;
    void cache.then((m) => alive && setModels(m));
    return () => {
      alive = false;
    };
  }, []);
  return models;
}

/** 别名（default / opus / sonnet…）放「常用」，带日期或版本号的完整 id 放「指定版本」 */
export function isAlias(m: ModelInfo): boolean {
  return !m.value.startsWith('claude-');
}

export function modelLabel(m: ModelInfo, all: ModelInfo[]): string {
  if (m.value !== 'default') return m.displayName;
  const target = all.find((x) => x.value !== 'default' && x.resolvedModel && x.resolvedModel === m.resolvedModel);
  return target ? `默认（${target.displayName}）` : '默认模型';
}

export const EFFORT_LABEL: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
};
