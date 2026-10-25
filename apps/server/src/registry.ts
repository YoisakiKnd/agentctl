import { access, constants, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter, EventWindow, SessionSummary } from '@agentctl/core';
import type { IndexDb } from './db.ts';

export interface AgentInfo {
  id: string;
  name: string;
  dataDir: string;
  binary?: string;
  binaryPath?: string;
  available: boolean;
  capabilities: AgentAdapter['capabilities'];
  sessionCount: number;
}

export interface Stats {
  sessions: number;
  agents: number;
  totalCostUsd: number;
  totalBytes: number;
  latestAt: string | null;
}

const REFRESH_TTL_MS = 15_000;
/** 小于这个体积的会话头尾扫描已经足够准，不值得再全量扫一遍 */
const REFINE_MIN_BYTES = 256 * 1024;

export class Registry {
  private readonly adapters: AgentAdapter[];
  private readonly db: IndexDb;
  private sessions: SessionSummary[] = [];
  private lastRefresh = 0;
  private inflight: Promise<SessionSummary[]> | null = null;
  private readonly refineQueue: SessionSummary[] = [];
  private readonly refining = new Set<string>();
  private readonly binaryCache = new Map<string, string | null>();

  constructor(adapters: AgentAdapter[], db: IndexDb) {
    this.adapters = adapters;
    this.db = db;
  }

  async list(force = false): Promise<SessionSummary[]> {
    const fresh = Date.now() - this.lastRefresh < REFRESH_TTL_MS;
    if (!force && fresh && this.sessions.length) return this.sessions;
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      const all: SessionSummary[] = [];
      for (const adapter of this.adapters) {
        try {
          all.push(...(await adapter.discover()));
        } catch (err) {
          console.error(`[registry] ${adapter.id} discover 失败:`, (err as Error).message);
        }
      }
      const merged = all.map((s) => this.applyRefined(s));
      merged.sort((a, b) => b.mtime - a.mtime);
      this.sessions = merged;
      this.lastRefresh = Date.now();
      this.scheduleRefine(merged);
      return merged;
    })().finally(() => {
      this.inflight = null;
    });

    return this.inflight;
  }

  async get(id: string): Promise<SessionSummary | undefined> {
    const sessions = await this.list();
    const hit = sessions.find((s) => s.id === id);
    if (hit) {
      // 单个会话页会反复问它的摘要：文件长了就别拿 15 秒前的缓存（轮次、花费会对不上）
      const size = await stat(hit.file).then((st) => st.size).catch(() => hit.sizeBytes);
      if (size === hit.sizeBytes) return hit;
      return (await this.list(true)).find((s) => s.id === id) ?? hit;
    }
    // 可能是刚创建、缓存还没刷新的会话
    const again = await this.list(true);
    return again.find((s) => s.id === id);
  }

  async events(
    id: string,
    opts: { before?: number; maxBytes?: number } = {},
  ): Promise<EventWindow | null> {
    const session = await this.get(id);
    if (!session) return null;
    const adapter = this.adapters.find((a) => a.id === session.agent);
    if (!adapter) return null;
    return adapter.replay(session, opts);
  }

  async agents(): Promise<AgentInfo[]> {
    const sessions = await this.list();
    const out: AgentInfo[] = [];
    for (const adapter of this.adapters) {
      const binaryPath = adapter.meta.binary ? await this.which(adapter.meta.binary) : null;
      out.push({
        id: adapter.id,
        name: adapter.meta.name,
        dataDir: adapter.meta.dataDir,
        binary: adapter.meta.binary,
        binaryPath: binaryPath ?? undefined,
        available: !!binaryPath,
        capabilities: adapter.capabilities,
        sessionCount: sessions.filter((s) => s.agent === adapter.id).length,
      });
    }
    return out;
  }

  adapter(id: string): AgentAdapter | undefined {
    return this.adapters.find((a) => a.id === id);
  }

  /** 实时运行要用可执行文件的绝对路径 */
  async binaryOf(adapter: AgentAdapter): Promise<string | undefined> {
    return adapter.meta.binary ? ((await this.which(adapter.meta.binary)) ?? undefined) : undefined;
  }

  /** 会话文件刚被 agent 写过（运行结束、新会话落盘），下次 list 必须重扫 */
  invalidate(): void {
    this.lastRefresh = 0;
  }

  stats(): Stats {
    return {
      sessions: this.sessions.length,
      agents: new Set(this.sessions.map((s) => s.agent)).size,
      totalCostUsd: this.sessions.reduce((sum, s) => sum + (s.costUsd ?? 0), 0),
      totalBytes: this.sessions.reduce((sum, s) => sum + s.sizeBytes, 0),
      latestAt: this.sessions[0]?.updatedAt ?? null,
    };
  }

  private applyRefined(s: SessionSummary): SessionSummary {
    const row = this.db.getRefined(s.id, s.sizeBytes, s.mtime);
    if (!row) return s;
    return {
      ...s,
      turns: Math.max(row.turns, s.turns),
      costUsd: row.costUsd ?? s.costUsd,
      preview: row.preview ?? s.preview,
    };
  }

  /** 后台补全：串行执行，避免多个大文件同时扫盘把磁盘打满 */
  private scheduleRefine(sessions: SessionSummary[]): void {
    for (const s of sessions) {
      if (s.sizeBytes < REFINE_MIN_BYTES) continue;
      if (this.db.getRefined(s.id, s.sizeBytes, s.mtime)) continue;
      if (this.refining.has(s.id)) continue;
      if (!this.refineQueue.some((q) => q.id === s.id)) this.refineQueue.push(s);
    }
    void this.drainRefine();
  }

  private async drainRefine(): Promise<void> {
    if (this.refining.size > 0) return;
    const next = this.refineQueue.shift();
    if (!next) return;
    const adapter = this.adapters.find((a) => a.id === next.agent);
    if (!adapter?.refine) return;

    this.refining.add(next.id);
    try {
      const patch = await adapter.refine(next);
      this.db.putRefined(next.id, next.sizeBytes, next.mtime, {
        turns: patch.turns ?? next.turns,
        costUsd: patch.costUsd ?? next.costUsd,
        preview: patch.preview ?? next.preview,
      });
      const idx = this.sessions.findIndex((s) => s.id === next.id);
      if (idx >= 0) this.sessions[idx] = this.applyRefined(this.sessions[idx]);
    } catch (err) {
      console.error(`[registry] refine ${next.id} 失败:`, (err as Error).message);
    } finally {
      this.refining.delete(next.id);
      setImmediate(() => void this.drainRefine());
    }
  }

  /**
   * 探测可执行文件。不能只靠 `which`：服务进程的 PATH 往往比交互 shell 短，
   * 而这几个 agent 常装在 ~/.local/bin 或 ~/.bun/bin 里。
   */
  private async which(bin: string): Promise<string | null> {
    if (this.binaryCache.has(bin)) return this.binaryCache.get(bin) ?? null;
    const home = homedir();
    const dirs = [
      ...(process.env.PATH ?? '').split(':'),
      join(home, '.local', 'bin'),
      join(home, '.bun', 'bin'),
      join(home, '.npm-global', 'bin'),
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/usr/bin',
    ].filter(Boolean);

    let found: string | null = null;
    for (const dir of dirs) {
      const candidate = join(dir, bin);
      try {
        await access(candidate, constants.X_OK);
        found = candidate;
        break;
      } catch {
        // 继续找下一个
      }
    }
    this.binaryCache.set(bin, found);
    return found;
  }
}
