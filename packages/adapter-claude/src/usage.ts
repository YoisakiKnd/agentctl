import { localDay, safeJsonParse, streamLines, UsageAcc, type UsageBucket } from '@agentctl/core';

type Rec = Record<string, unknown>;

interface ModelTotals {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

interface Pending {
  day: string;
  model: string;
  weight: number;
}

const TS_RE = /"timestamp":"([^"]+)"/;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * 各类 token 的相对价格（Anthropic 各模型一致：缓存写 1.25×、缓存读 0.1×、输出 5× 输入）。
 * 只用来把一段花费按比例摊到这段时间里的各条回复上，不用来算绝对价格。
 */
function weightOf(t: Omit<ModelTotals, 'cost'>): number {
  return t.inputTokens + 5 * t.outputTokens + 1.25 * t.cacheWrite + 0.1 * t.cacheRead;
}

export type Rates = Map<string, { cost: number; weight: number }>;

/** 由若干会话最后的 cost-state（discover 读尾部时顺手拿到）算各模型的参考单价 */
export function ratesFrom(snapshots: Iterable<Record<string, Rec>>): Rates {
  const rates: Rates = new Map();
  for (const snap of snapshots) {
    for (const [model, u] of Object.entries(snap)) {
      if (!u || typeof u !== 'object') continue;
      const t = totalsOf(u);
      const weight = weightOf(t);
      if (!(t.cost > 0 && weight > 0)) continue;
      const r = rates.get(model) ?? { cost: 0, weight: 0 };
      r.cost += t.cost;
      r.weight += weight;
      rates.set(model, r);
    }
  }
  return rates;
}

function totalsOf(u: Rec): ModelTotals {
  return {
    cost: num(u.costUSD),
    inputTokens: num(u.inputTokens),
    outputTokens: num(u.outputTokens),
    cacheRead: num(u.cacheReadInputTokens),
    cacheWrite: num(u.cacheCreationInputTokens),
  };
}

export interface CostDelta {
  model: string;
  delta: number;
  totals: ModelTotals;
  prev?: ModelTotals;
}

/**
 * cost-state 记账：一个会话文件可能被几个进程先后甚至同时写（网页和终端各续接一次），
 * 它们的累计值各自从 0 起，用 startTime 区分；同一进程的累计值变小是从旧快照恢复的，
 * 不算花费，以新值为基准继续。只取最后一行 cost-state 会少算前面那些进程花的钱。
 */
export class CostLedger {
  total = 0;
  private readonly prev = new Map<string, Map<string, ModelTotals>>();

  /** 喂一行 cost-state，返回这一行带来的各模型新增花费 */
  feed(d: Rec): CostDelta[] {
    const key = String(d.startTime ?? '');
    const mine = this.prev.get(key) ?? new Map<string, ModelTotals>();
    this.prev.set(key, mine);
    const out: CostDelta[] = [];
    for (const [model, u] of Object.entries((d.modelUsage ?? {}) as Record<string, Rec>)) {
      if (!u || typeof u !== 'object') continue;
      const totals = totalsOf(u);
      const prev = mine.get(model);
      mine.set(model, totals);
      if (prev && totals.cost < prev.cost) continue;
      const delta = totals.cost - (prev?.cost ?? 0);
      if (delta <= 0) continue;
      this.total += delta;
      out.push({ model, delta, totals, prev });
    }
    return out;
  }
}

/**
 * Claude 的用量。
 *
 * token：每条 assistant 回复自带 usage 和时间戳，按 message.id 去重（一条回复会拆成多行）。
 * 花费：文件里没有单条回复的价格，只有 Claude Code 自己记账的 `cost-state` 行——按模型的累计值，
 * 没有时间戳、写得很稀疏（几十轮才一行）。做法是把每次新增的花费（见 CostLedger）
 * 按尚未结算的各条回复的加权 token 摊到它们各自的日期上，这样总数与 Claude 自己的账一致，
 * 跨天的区间也能分得开。
 *
 * 最后一行 cost-state 之后的回复（进程还在跑、还没记账）按本会话该模型的实际单价估算；
 * 本会话没有可参考的单价时用 `rates()`（其他会话的累计），再没有就只计 token。
 */
export async function claudeUsage(file: string, rates: () => Rates): Promise<UsageBucket[]> {
  const acc = new UsageAcc();
  const seen = new Set<string>();
  /** 主会话里出现过回复的模型；其余模型（子代理、生成标题）的 token 只能从累计值里拿 */
  const replied = new Set<string>();
  let pending: Pending[] = [];
  const ledger = new CostLedger();
  let lastDay: string | undefined;
  const local: Rates = new Map();

  for await (const line of streamLines(file)) {
    const text = line.text;
    if (text.startsWith('{"type":"cost-state"')) {
      const d = safeJsonParse(text) as Rec | null;
      if (!d) continue;
      for (const { model, delta, totals: t, prev: p } of ledger.feed(d)) {
        const due = pending.filter((e) => e.model === model);
        const weight = due.reduce((sum, e) => sum + e.weight, 0);
        if (weight > 0) {
          for (const e of due) acc.add(e.day, model, { costUsd: (delta * e.weight) / weight });
          pending = pending.filter((e) => e.model !== model);
          const r = local.get(model) ?? { cost: 0, weight: 0 };
          r.cost += delta;
          r.weight += weight;
          local.set(model, r);
        } else if (lastDay) {
          const extra = replied.has(model)
            ? {}
            : {
                inputTokens: t.inputTokens - (p?.inputTokens ?? 0),
                outputTokens: t.outputTokens - (p?.outputTokens ?? 0),
                cacheRead: t.cacheRead - (p?.cacheRead ?? 0),
                cacheWrite: t.cacheWrite - (p?.cacheWrite ?? 0),
              };
          acc.add(lastDay, model, { costUsd: delta, ...extra });
        }
      }
      continue;
    }

    if (!text.includes('"type":"assistant"')) {
      // timestamp 在 message 之后，大行（工具输出）里一般在尾部
      const m = TS_RE.exec(text.length > 8192 ? text.slice(-4096) : text) ?? (text.length > 8192 ? TS_RE.exec(text.slice(0, 4096)) : null);
      const day = m ? localDay(m[1]) : undefined;
      if (day) lastDay = day;
      continue;
    }
    const d = safeJsonParse(text) as Rec | null;
    if (!d || d.type !== 'assistant') continue;
    const day = localDay(typeof d.timestamp === 'string' ? d.timestamp : undefined);
    if (!day) continue;
    lastDay = day;
    const msg = (d.message ?? {}) as Rec;
    const model = typeof msg.model === 'string' ? msg.model : 'unknown';
    if (model === '<synthetic>') continue;
    const id = typeof msg.id === 'string' ? msg.id : undefined;
    if (id ? seen.has(id) : d.apiBlockIndex !== undefined && d.apiBlockIndex !== 0) continue;
    if (id) seen.add(id);
    const u = msg.usage as Rec | undefined;
    if (!u) continue;
    const t = {
      inputTokens: num(u.input_tokens),
      outputTokens: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
    };
    replied.add(model);
    acc.add(day, model, { ...t, messages: 1 });
    pending.push({ day, model, weight: weightOf(t) });
  }

  const fallback = pending.some((e) => !local.has(e.model)) ? rates() : undefined;
  for (const e of pending) {
    const r = local.get(e.model) ?? fallback?.get(e.model);
    if (r && r.weight > 0) acc.add(e.day, e.model, { costUsd: (r.cost / r.weight) * e.weight });
  }
  return acc.buckets();
}
