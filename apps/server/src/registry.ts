import { access, constants, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter, EventWindow, ModelInfo, SessionSummary, UsageBucket } from '@agentctl/core';
import type { Annotation, IndexDb, RunPrefs } from './db.ts';

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

export interface SessionUsage {
  session: SessionSummary;
  buckets: UsageBucket[];
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
  private readonly notes: Map<string, Annotation>;
  private usageInflight: Promise<SessionUsage[]> | null = null;

  constructor(adapters: AgentAdapter[], db: IndexDb) {
    this.adapters = adapters;
    this.db = db;
    this.notes = db.annotations();
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
      const merged = all.map((s) => this.annotate(this.applyRefined(s)));
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
    opts: { before?: number; through?: number; maxBytes?: number } = {},
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

  /**
   * 这个会话该用的运行选项：网页上次用过的（存在索引库里）优先；
   * 没有的话，权限模式取 agent 自己在会话文件里记的最近一次（终端里切的也算）。
   */
  prefs(session: SessionSummary): RunPrefs {
    const saved = this.db.getPrefs(session.id) ?? {};
    return { permissionMode: session.permissionMode, ...saved };
  }

  savePrefs(id: string, patch: RunPrefs): void {
    this.db.patchPrefs(id, patch);
  }

  /** 运行中的进程自己报的模型列表（DSH 只有建立会话后才给）：记下来，进程不在时也能选 */
  rememberModels(agent: string, models: ModelInfo[]): void {
    if (models.length) this.db.setKv(`models:${agent}`, JSON.stringify(models));
  }

  cachedModels(agent: string): ModelInfo[] {
    try {
      return JSON.parse(this.db.getKv(`models:${agent}`) ?? '[]') as ModelInfo[];
    } catch {
      return [];
    }
  }

  annotation(id: string): Annotation {
    return this.notes.get(id) ?? { pinned: false, tags: [] };
  }

  /** 改注解：立刻反映到内存里的列表，不必等下次扫盘 */
  setAnnotation(id: string, a: Annotation): void {
    this.db.putAnnotation(id, a);
    if (a.pinned || a.tags.length || a.title) this.notes.set(id, a);
    else this.notes.delete(id);
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx >= 0) this.sessions[idx] = this.annotate(this.sessions[idx]);
  }

  /** 全部标签及使用次数 */
  tags(): { tag: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const a of this.notes.values()) for (const t of a.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /**
   * 每个会话按天 × 模型的用量。文件没变就用缓存；变了的整份重算（Claude 的花费要从头记账才对得上）。
   * 从旧到新算：正在跑的会话放最后，它还没记账的部分要参考别的会话的单价。
   */
  usage(): Promise<SessionUsage[]> {
    if (this.usageInflight) return this.usageInflight;
    this.usageInflight = (async () => {
      const sessions = [...(await this.list())].sort((a, b) => a.mtime - b.mtime);
      const out: SessionUsage[] = [];
      for (const session of sessions) {
        const adapter = this.adapters.find((a) => a.id === session.agent);
        if (!adapter?.usage || !session.file) continue;
        let buckets = this.db.getUsage(session.id, session.sizeBytes, session.mtime);
        if (!buckets) {
          try {
            buckets = await adapter.usage(session);
            this.db.putUsage(session.id, session.sizeBytes, session.mtime, buckets);
          } catch (err) {
            console.error(`[registry] usage ${session.id} 失败:`, (err as Error).message);
            continue;
          }
        }
        if (buckets.length) out.push({ session, buckets });
      }
      return out;
    })().finally(() => {
      this.usageInflight = null;
    });
    return this.usageInflight;
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

  private annotate(s: SessionSummary): SessionSummary {
    const a = this.notes.get(s.id);
    const original = s.originalTitle ?? s.title;
    const base = { ...s, pinned: undefined, tags: undefined, originalTitle: undefined, title: original };
    if (!a) return base;
    return {
      ...base,
      pinned: a.pinned || undefined,
      tags: a.tags.length ? a.tags : undefined,
      title: a.title ?? original,
      originalTitle: a.title ? original : undefined,
    };
  }

  private applyRefined(s: SessionSummary): SessionSummary {
    const row = this.db.getRefined(s.id, s.sizeBytes, s.mtime);
    if (!row) return s;
    // 过期的补全结果（文件后来又变长了）只当下限用：轮次、累计花费都只增不减
    const cost = row.fresh ? (row.costUsd ?? s.costUsd) : Math.max(row.costUsd ?? 0, s.costUsd ?? 0) || undefined;
    return {
      ...s,
      turns: Math.max(row.turns, s.turns),
      costUsd: cost,
      preview: row.preview ?? s.preview,
    };
  }

  /** 后台补全：串行执行，避免多个大文件同时扫盘把磁盘打满 */
  private scheduleRefine(sessions: SessionSummary[]): void {
    for (const s of sessions) {
      if (s.sizeBytes < REFINE_MIN_BYTES) continue;
      if (this.db.getRefined(s.id, s.sizeBytes, s.mtime)?.fresh) continue;
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
      if (idx >= 0) this.sessions[idx] = this.annotate(this.applyRefined(this.sessions[idx]));
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
