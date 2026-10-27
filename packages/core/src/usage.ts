import type { UnifiedEvent } from './events.ts';

/**
 * 一个会话在某一天、某个模型上的用量。按天聚合后体积很小，适合整块缓存。
 * token 口径与 usage 事件一致：inputTokens 是新输入（不含缓存命中），cacheRead / cacheWrite 另计。
 */
export interface UsageBucket {
  /** 服务器本地时区的日期 YYYY-MM-DD */
  day: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  /** agent 没记账（例如 Codex 订阅制）时为 undefined，不是 0 */
  costUsd?: number;
  /** 模型回复次数 */
  messages: number;
}

export type UsageDelta = Partial<Omit<UsageBucket, 'day' | 'model'>>;

const pad = (n: number) => String(n).padStart(2, '0');

/** ISO 时间 → 服务器本地日期；解析不了返回 undefined */
export function localDay(ts: string | number | undefined): string | undefined {
  if (ts === undefined) return undefined;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime()) || d.getTime() <= 0) return undefined;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 按 (day, model) 累加 */
export class UsageAcc {
  private readonly map = new Map<string, UsageBucket>();

  add(day: string, model: string | undefined, d: UsageDelta): void {
    const m = model || 'unknown';
    const key = `${day}\u0000${m}`;
    let b = this.map.get(key);
    if (!b) {
      b = { day, model: m, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
      this.map.set(key, b);
    }
    b.inputTokens += d.inputTokens ?? 0;
    b.outputTokens += d.outputTokens ?? 0;
    b.cacheRead += d.cacheRead ?? 0;
    b.cacheWrite += d.cacheWrite ?? 0;
    b.messages += d.messages ?? 0;
    if (d.costUsd !== undefined) b.costUsd = (b.costUsd ?? 0) + d.costUsd;
  }

  /** 把 usage 事件计进去（Codex / DSH / Pi 直接复用各自的行解析） */
  addEvents(events: Iterable<UnifiedEvent>): void {
    for (const e of events) {
      if (e.item.kind !== 'usage') continue;
      const day = localDay(e.ts);
      if (!day) continue;
      this.add(day, e.item.model, {
        inputTokens: e.item.inputTokens,
        outputTokens: e.item.outputTokens,
        cacheRead: e.item.cacheRead,
        cacheWrite: e.item.cacheWrite,
        costUsd: e.item.costUsd,
        messages: 1,
      });
    }
  }

  buckets(): UsageBucket[] {
    return [...this.map.values()].sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model));
  }
}
