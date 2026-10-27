import { localDay, type AgentId, type UsageBucket } from '@agentctl/core';
import type { SessionUsage } from './registry.ts';

interface Totals {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  /** 没有任何一条记录带花费时为 undefined（例如 Codex），前端显示"不记账"而不是 $0 */
  costUsd?: number;
  messages: number;
}

export interface UsageReport {
  /** 区间内的每一天（含没有用量的日子），图表横轴用 */
  days: string[];
  from: string | null;
  to: string;
  daily: ({ day: string; agent: AgentId } & Totals)[];
  agents: ({ agent: AgentId; sessions: number } & Totals)[];
  models: ({ agent: AgentId; model: string } & Totals)[];
  /** 区间内花费（不记账的按 token）最多的会话 */
  sessions: ({ id: string; agent: AgentId; title: string; cwd: string; updatedAt: string } & Totals)[];
  totals: Totals & { sessions: number };
}

const zero = (): Totals => ({ inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, messages: 0 });

function add(t: Totals, b: UsageBucket | Totals): void {
  t.inputTokens += b.inputTokens;
  t.outputTokens += b.outputTokens;
  t.cacheRead += b.cacheRead;
  t.cacheWrite += b.cacheWrite;
  t.messages += b.messages;
  if (b.costUsd !== undefined) t.costUsd = (t.costUsd ?? 0) + b.costUsd;
}

const tokens = (t: Totals) => t.inputTokens + t.outputTokens + t.cacheRead + t.cacheWrite;

function dayList(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`).getTime();
  // 按本地日历日推进（setDate 处理夏令时），最多两年，防止异常数据撑爆
  while (d.getTime() <= end && out.length < 731) {
    out.push(localDay(d.getTime())!);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** days：最近 N 天（含今天）；0 表示全部 */
export function usageReport(all: SessionUsage[], days: number, agent?: string): UsageReport {
  const to = localDay(Date.now())!;
  let from: string | null = null;
  if (days > 0) {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1));
    from = localDay(d.getTime())!;
  }

  const daily = new Map<string, { day: string; agent: AgentId } & Totals>();
  const agents = new Map<AgentId, { agent: AgentId; sessions: number } & Totals>();
  const models = new Map<string, { agent: AgentId; model: string } & Totals>();
  const sessions: UsageReport['sessions'] = [];
  const totals = { ...zero(), sessions: 0 };
  let earliest: string | undefined;

  for (const { session, buckets } of all) {
    if (agent && session.agent !== agent) continue;
    const mine = zero();
    for (const b of buckets) {
      if (from && b.day < from) continue;
      if (b.day > to) continue; // 时钟错乱的未来日期
      if (!earliest || b.day < earliest) earliest = b.day;
      add(mine, b);

      const dk = `${b.day}|${session.agent}`;
      const d = daily.get(dk) ?? { day: b.day, agent: session.agent, ...zero() };
      add(d, b);
      daily.set(dk, d);

      const mk = `${session.agent}|${b.model}`;
      const m = models.get(mk) ?? { agent: session.agent, model: b.model, ...zero() };
      add(m, b);
      models.set(mk, m);
    }
    if (!mine.messages && !tokens(mine)) continue;
    const a = agents.get(session.agent) ?? { agent: session.agent, sessions: 0, ...zero() };
    add(a, mine);
    a.sessions += 1;
    agents.set(session.agent, a);
    add(totals, mine);
    totals.sessions += 1;
    sessions.push({
      id: session.id,
      agent: session.agent,
      title: session.title,
      cwd: session.cwd,
      updatedAt: session.updatedAt,
      ...mine,
    });
  }

  // 记账的按花费排，不记账的按 token 排在后面
  const rank = (a: Totals, b: Totals) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || tokens(b) - tokens(a);
  sessions.sort(rank);

  const start = from ?? earliest ?? to;
  return {
    days: dayList(start, to),
    from,
    to,
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
    agents: [...agents.values()].sort(rank),
    models: [...models.values()].sort(rank),
    sessions: sessions.slice(0, 20),
    totals,
  };
}
