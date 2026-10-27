import type { AgentId, QuotaSnapshot } from '@agentctl/core';
import type { Registry } from './registry.ts';

export interface QuotaEntry extends Partial<QuotaSnapshot> {
  agent: AgentId;
  name: string;
  /** 最近一次成功取到的时间 */
  fetchedAt?: string;
  /** 最近一次失败的原因（保留上一次成功的数据） */
  error?: string;
}

/** 后台多久问一次；每次是起一个 CLI 进程握手，不调用模型、不花钱 */
const POLL_MS = 10 * 60_000;
/** 手动刷新 / 一轮结束后刷新的最短间隔 */
const MIN_REFRESH_MS = 30_000;

/**
 * 订阅套餐额度（Claude 的 5 小时 / 每周、Codex 的 5 小时 / 每周）。
 * 数据只在内存里：重启后第一次请求时重新去问。
 */
export class QuotaService {
  private readonly entries = new Map<AgentId, QuotaEntry>();
  private readonly inflight = new Map<AgentId, Promise<void>>();
  private readonly lastTry = new Map<AgentId, number>();
  private timer: NodeJS.Timeout | undefined;
  private readonly registry: Registry;

  constructor(registry: Registry) {
    this.registry = registry;
  }

  start(): void {
    const tick = () => void this.refreshAll(true);
    setTimeout(tick, 5_000).unref();
    this.timer = setInterval(tick, POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** force=false：只在从没取过或超过 MIN_REFRESH_MS 时才去问 */
  async list(refresh = false): Promise<QuotaEntry[]> {
    const fresh = [...this.supported()].some(({ id }) => !this.entries.has(id));
    if (refresh || fresh) await this.refreshAll(false);
    return [...this.supported()].map(({ id, name }) => this.entries.get(id) ?? { agent: id, name });
  }

  /** 网页里一轮跑完：额度刚变过，稍后刷新这个 agent */
  touch(agent: AgentId): void {
    setTimeout(() => void this.refresh(agent, false), 3_000).unref();
  }

  private *supported(): Iterable<{ id: AgentId; name: string }> {
    for (const id of ['claude', 'codex'] as AgentId[]) {
      const adapter = this.registry.adapter(id);
      if (adapter?.quota) yield { id, name: adapter.meta.name };
    }
  }

  private async refreshAll(force: boolean): Promise<void> {
    await Promise.all([...this.supported()].map(({ id }) => this.refresh(id, force)));
  }

  private refresh(agent: AgentId, force: boolean): Promise<void> {
    const running = this.inflight.get(agent);
    if (running) return running;
    if (!force && Date.now() - (this.lastTry.get(agent) ?? 0) < MIN_REFRESH_MS) return Promise.resolve();
    this.lastTry.set(agent, Date.now());
    const adapter = this.registry.adapter(agent);
    if (!adapter?.quota) return Promise.resolve();
    const name = adapter.meta.name;
    const job = (async () => {
      const binary = await this.registry.binaryOf(adapter);
      if (!binary) {
        this.entries.set(agent, { agent, name, error: `找不到 ${adapter.meta.binary} 命令` });
        return;
      }
      try {
        const snap = await adapter.quota!(binary);
        this.entries.set(agent, { agent, name, ...snap, fetchedAt: new Date().toISOString() });
      } catch (err) {
        const prev = this.entries.get(agent) ?? { agent, name };
        this.entries.set(agent, { ...prev, error: (err as Error).message });
      }
    })().finally(() => this.inflight.delete(agent));
    this.inflight.set(agent, job);
    return job;
  }
}
