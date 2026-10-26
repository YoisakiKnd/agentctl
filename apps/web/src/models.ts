import { useEffect, useState } from 'react';
import { api } from './api';
import type { AgentId, ModelInfo } from './types';

/** 拿不到 CLI 列表时（旧版本、命令行不可用）的兜底 */
const FALLBACK: ModelInfo[] = [
  { value: 'default', displayName: 'Default' },
  { value: 'opus', displayName: 'Opus' },
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'haiku', displayName: 'Haiku' },
];

const DEFAULT_ONLY: ModelInfo[] = [{ value: 'default', displayName: 'Default' }];

const cache = new Map<string, Promise<ModelInfo[]>>();

/** 模型列表直接来自各 agent 的命令行（Claude 的 initialize、Codex 的 model/list），与终端里看到的一致 */
export function useModels(agent: AgentId = 'claude'): ModelInfo[] {
  const fallback = agent === 'claude' ? FALLBACK : DEFAULT_ONLY;
  const [models, setModels] = useState<ModelInfo[]>(fallback);
  useEffect(() => {
    let p = cache.get(agent);
    if (!p) {
      p = api
        .models(agent)
        .then((r) => (r.models.length ? r.models : fallback))
        .catch(() => {
          cache.delete(agent); // 下次再试
          return fallback;
        });
      cache.set(agent, p);
    }
    let alive = true;
    void p.then((m) => alive && setModels(m));
    return () => {
      alive = false;
    };
  }, [agent, fallback]);
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
  ultra: '极限',
};
