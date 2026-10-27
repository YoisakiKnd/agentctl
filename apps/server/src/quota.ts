import { randomUUID } from 'node:crypto';
import type { AgentId, QuotaSnapshot, QuotaWindow } from '@agentctl/core';
import type { IndexDb, StoredRow } from './db.ts';
import type { Message, NotifyService } from './notify.ts';
import type { Registry } from './registry.ts';
import { cleanSourceConfig, fetchSource, maskSourceConfig, type SourceSnapshot } from './sources.ts';

export interface QuotaEntry extends Partial<SourceSnapshot> {
  /** claude / codex / custom:<uuid> */
  id: string;
  /** 内置订阅源对应的 agent（前端拿它配身份色） */
  agent?: AgentId;
  kind: 'cli' | 'json' | 'deepseek';
  name: string;
  enabled: boolean;
  /** 最近一次成功取到的时间 */
  fetchedAt?: string;
  /** 最近一次失败的原因（保留上一次成功的数据） */
  error?: string;
  /** 自定义订阅源的配置（密钥已打码），给设置页编辑用 */
  config?: Record<string, unknown>;
}

export interface NotifySettings {
  /** 窗口刷新前至少用到这么多才提醒；没怎么用的窗口（例如 Codex 0%）滚动重置不打扰 */
  resetMinUsed: number;
  /** 关掉监控的订阅源 id（内置的 claude / codex 也能关） */
  disabled: string[];
}

const DEFAULT_SETTINGS: NotifySettings = { resetMinUsed: 10, disabled: [] };

/** 内置订阅源多久问一次；每次是起一个 CLI 进程握手，不调用模型、不花钱 */
const CLI_POLL_MIN = 10;
/** 手动刷新 / 一轮结束后刷新的最短间隔 */
const MIN_REFRESH_MS = 30_000;
/** 到了重置时间再晚一点去确认，服务端那边有时延 */
const RESET_GRACE_MS = 45_000;

interface WindowState {
  usedPercent: number;
  resetsAt?: string;
}

interface SourceState {
  windows: Record<string, WindowState>;
  balance?: number;
}

const BUILTIN: { id: AgentId; name: string }[] = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
];

function clock(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 订阅额度：内置的 Claude（5 小时 / 每周）、Codex（5 小时 / 每周），加上设置里添加的自定义订阅源。
 * 每次取到新数据都和上一次比，发现「刷新了」「快用完了」「余额不足」就交给 NotifyService。
 * 上一次的状态存在索引库里，服务重启期间发生的刷新，重启后第一次查询也能发现。
 */
export class QuotaService {
  private readonly entries = new Map<string, QuotaEntry>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly lastTry = new Map<string, number>();
  private readonly resetTimers = new Map<string, NodeJS.Timeout>();
  private timer: NodeJS.Timeout | undefined;
  private readonly registry: Registry;
  private readonly db: IndexDb;
  private readonly notify: NotifyService;
  private readonly warnPercent: () => number;

  constructor(opts: { registry: Registry; db: IndexDb; notify: NotifyService; warnPercent: () => number }) {
    this.registry = opts.registry;
    this.db = opts.db;
    this.notify = opts.notify;
    this.warnPercent = opts.warnPercent;
  }

  start(): void {
    // 每分钟看一眼哪些订阅源到了该问的时候（各自的间隔不同）
    const tick = () => void this.refreshDue();
    setTimeout(tick, 5_000).unref();
    this.timer = setInterval(tick, 60_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    for (const t of this.resetTimers.values()) clearTimeout(t);
  }

  settings(): NotifySettings {
    return { ...DEFAULT_SETTINGS, ...this.db.getJson<Partial<NotifySettings>>('notify:settings', {}) };
  }

  saveSettings(patch: Partial<NotifySettings>): NotifySettings {
    const next = { ...this.settings() };
    if (patch.resetMinUsed !== undefined) {
      const n = Number(patch.resetMinUsed);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('resetMinUsed 必须在 0–100 之间');
      next.resetMinUsed = n;
    }
    if (patch.disabled !== undefined) {
      if (!Array.isArray(patch.disabled)) throw new Error('disabled 必须是数组');
      next.disabled = patch.disabled.filter((x): x is string => typeof x === 'string').slice(0, 100);
    }
    this.db.setJson('notify:settings', next);
    return next;
  }

  /** 所有订阅源（含关掉的），带最近一次数据 */
  async list(refresh = false): Promise<QuotaEntry[]> {
    const sources = this.sources();
    const missing = sources.some((s) => s.enabled && !this.entries.has(s.id));
    if (refresh || missing) await Promise.all(sources.filter((s) => s.enabled).map((s) => this.refresh(s.id, refresh)));
    return this.sources().map((s) => ({ ...s, ...(this.entries.get(s.id) ?? {}), enabled: s.enabled, name: s.name, config: s.config }));
  }

  /** 网页里一轮跑完：额度刚变过，稍后刷新这个 agent */
  touch(agent: AgentId): void {
    setTimeout(() => void this.refresh(agent, false), 3_000).unref();
  }

  /* ── 自定义订阅源 ─────────────────────────────────────── */

  saveSource(input: { id?: string; kind?: string; name?: string; config?: Record<string, unknown>; enabled?: boolean }): StoredRow {
    const rows = this.db.listRows('quota_source');
    const prev = input.id ? rows.find((r) => `custom:${r.id}` === input.id || r.id === input.id) : undefined;
    if (input.id && !prev) throw new Error('订阅源不存在');
    const kind = prev?.kind ?? String(input.kind ?? '');
    const name = String(input.name ?? prev?.name ?? '').trim().slice(0, 60);
    if (!name) throw new Error('请填写名称');
    const row: StoredRow = {
      id: prev?.id ?? randomUUID(),
      kind,
      name,
      config: input.config ? cleanSourceConfig(kind, input.config, prev?.config) : (prev?.config ?? {}),
      enabled: input.enabled ?? prev?.enabled ?? true,
    };
    this.db.putRow('quota_source', row);
    // 配置变了：旧数据作废，马上按新配置问一次
    this.entries.delete(`custom:${row.id}`);
    this.lastTry.delete(`custom:${row.id}`);
    void this.refresh(`custom:${row.id}`, true);
    return row;
  }

  deleteSource(id: string): void {
    const raw = id.replace(/^custom:/, '');
    this.db.deleteRow('quota_source', raw);
    this.entries.delete(`custom:${raw}`);
    clearTimeout(this.resetTimers.get(`custom:${raw}`));
    const state = this.db.getJson<Record<string, SourceState>>('quota:last', {});
    delete state[`custom:${raw}`];
    this.db.setJson('quota:last', state);
  }

  /** 「测试」：按这份配置拉一次，不保存；返回解析结果和接口原样返回的内容（截断） */
  async testSource(input: { id?: string; kind: string; config: Record<string, unknown> }) {
    const prev = input.id ? this.db.listRows('quota_source').find((r) => `custom:${r.id}` === input.id) : undefined;
    const row: StoredRow = { id: 'test', kind: input.kind, name: 'test', config: cleanSourceConfig(input.kind, input.config, prev?.config), enabled: true };
    const { snapshot, raw } = await fetchSource(row);
    return { snapshot, raw: JSON.stringify(raw, null, 2).slice(0, 4000) };
  }

  /* ── 内部 ─────────────────────────────────────────────── */

  private sources(): QuotaEntry[] {
    const disabled = new Set(this.settings().disabled);
    const out: QuotaEntry[] = [];
    for (const b of BUILTIN) {
      const adapter = this.registry.adapter(b.id);
      if (adapter?.quota) out.push({ id: b.id, agent: b.id, kind: 'cli', name: adapter.meta.name, enabled: !disabled.has(b.id) });
    }
    for (const r of this.db.listRows('quota_source')) {
      out.push({
        id: `custom:${r.id}`,
        kind: r.kind as QuotaEntry['kind'],
        name: r.name,
        enabled: r.enabled && !disabled.has(`custom:${r.id}`),
        config: { ...maskSourceConfig(r.config), kind: r.kind },
      });
    }
    return out;
  }

  private intervalMs(id: string): number {
    if (!id.startsWith('custom:')) return CLI_POLL_MIN * 60_000;
    const row = this.db.listRows('quota_source').find((r) => `custom:${r.id}` === id);
    const min = Number(row?.config.intervalMin);
    return (Number.isFinite(min) && min > 0 ? min : CLI_POLL_MIN) * 60_000;
  }

  private async refreshDue(): Promise<void> {
    const now = Date.now();
    const due = this.sources().filter((s) => s.enabled && now - (this.lastTry.get(s.id) ?? 0) >= this.intervalMs(s.id) - 5_000);
    await Promise.all(due.map((s) => this.refresh(s.id, true)));
  }

  private refresh(id: string, force: boolean): Promise<void> {
    const running = this.inflight.get(id);
    if (running) return running;
    if (!force && Date.now() - (this.lastTry.get(id) ?? 0) < MIN_REFRESH_MS) return Promise.resolve();
    const source = this.sources().find((s) => s.id === id);
    if (!source?.enabled) return Promise.resolve();
    this.lastTry.set(id, Date.now());
    const job = (async () => {
      try {
        const snap = await this.fetch(source);
        const entry: QuotaEntry = { ...source, ...snap, fetchedAt: new Date().toISOString(), error: undefined };
        this.entries.set(id, entry);
        await this.compare(entry);
      } catch (err) {
        const prev = this.entries.get(id) ?? source;
        this.entries.set(id, { ...prev, error: (err as Error).message });
      }
    })().finally(() => this.inflight.delete(id));
    this.inflight.set(id, job);
    return job;
  }

  private async fetch(source: QuotaEntry): Promise<SourceSnapshot | QuotaSnapshot> {
    if (source.kind === 'cli') {
      const adapter = this.registry.adapter(source.id);
      if (!adapter?.quota) throw new Error('该 agent 不支持查询额度');
      const binary = await this.registry.binaryOf(adapter);
      if (!binary) throw new Error(`找不到 ${adapter.meta.binary} 命令`);
      return adapter.quota(binary);
    }
    const row = this.db.listRows('quota_source').find((r) => `custom:${r.id}` === source.id);
    if (!row) throw new Error('订阅源不存在');
    return (await fetchSource(row)).snapshot;
  }

  /** 和上一次比：刷新、过提醒线、余额跌破提醒线 */
  private async compare(entry: QuotaEntry): Promise<void> {
    const all = this.db.getJson<Record<string, SourceState>>('quota:last', {});
    const prev = all[entry.id];
    const next: SourceState = { windows: {} };
    const { resetMinUsed } = this.settings();
    const warn = this.warnPercent();
    const messages: Message[] = [];
    const now = Date.now();

    for (const w of entry.windows ?? []) {
      next.windows[w.id] = { usedPercent: w.usedPercent, resetsAt: w.resetsAt };
      const what = `${entry.name} ${w.label}额度`;
      const p = prev?.windows[w.id];
      if (!p) continue;
      const dropped = w.usedPercent < p.usedPercent - 0.5;
      const moved = !!(w.resetsAt && p.resetsAt && Date.parse(w.resetsAt) > Date.parse(p.resetsAt) + 60_000);
      const passed = !!(p.resetsAt && Date.parse(p.resetsAt) <= now + 60_000);
      // 没有重置时间的自定义源：用量一下掉了 10 个点以上才算刷新
      const reset = dropped && (moved || passed || (!w.resetsAt && p.usedPercent - w.usedPercent >= 10));
      if (reset && p.usedPercent >= resetMinUsed) {
        messages.push({
          event: 'reset',
          source: entry.id,
          title: `${what}已刷新`,
          body: `刷新前用到 ${Math.round(p.usedPercent)}%，现在 ${Math.round(w.usedPercent)}%。${w.resetsAt ? `下次刷新 ${clock(w.resetsAt)}。` : ''}`,
          extra: { window: w.id, before: p.usedPercent, usedPercent: w.usedPercent, resetsAt: w.resetsAt },
        });
      } else if (p.usedPercent < warn && w.usedPercent >= warn) {
        messages.push({
          event: 'warn',
          source: entry.id,
          title: `${what}已用 ${Math.round(w.usedPercent)}%`,
          body: w.resetsAt ? `${clock(w.resetsAt)} 刷新。` : '注意用量。',
          extra: { window: w.id, usedPercent: w.usedPercent, resetsAt: w.resetsAt },
        });
      }
    }

    const b = entry.balance;
    if (b) {
      next.balance = b.amount;
      const pb = prev?.balance;
      const unit = b.unit ? ` ${b.unit}` : '';
      if (pb !== undefined && b.lowBelow !== undefined && pb >= b.lowBelow && b.amount < b.lowBelow) {
        messages.push({ event: 'low', source: entry.id, title: `${entry.name} 余额不足`, body: `剩余 ${b.amount}${unit}，低于提醒线 ${b.lowBelow}${unit}。`, extra: { amount: b.amount } });
      } else if (pb !== undefined && b.amount > pb && b.amount - pb >= Math.max(0.01, pb * 0.01)) {
        // 余额型：到账 / 按月发放也算「刷新」
        messages.push({ event: 'reset', source: entry.id, title: `${entry.name} 余额已到账`, body: `${pb}${unit} → ${b.amount}${unit}。`, extra: { before: pb, amount: b.amount } });
      }
    }

    all[entry.id] = next;
    this.db.setJson('quota:last', all);
    this.scheduleReset(entry);
    for (const m of messages) await this.notify.send(m);
  }

  /** 用过的窗口到了重置时间就去确认一次：刷新提醒不必等下一轮轮询（最长 10 分钟） */
  private scheduleReset(entry: QuotaEntry): void {
    clearTimeout(this.resetTimers.get(entry.id));
    const { resetMinUsed } = this.settings();
    const times = (entry.windows ?? [])
      .filter((w: QuotaWindow) => w.resetsAt && w.usedPercent >= resetMinUsed)
      .map((w) => Date.parse(w.resetsAt!))
      .filter((t) => Number.isFinite(t) && t > Date.now());
    if (!times.length) return;
    const delay = Math.min(...times) - Date.now() + RESET_GRACE_MS;
    if (delay > 8 * 24 * 3600_000) return;
    const t = setTimeout(() => void this.refresh(entry.id, true), delay);
    t.unref();
    this.resetTimers.set(entry.id, t);
  }
}
