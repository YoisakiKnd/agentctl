import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { UsageBucket } from '@agentctl/core';

export interface RefinedRow {
  turns: number;
  costUsd?: number;
  preview?: string;
}

export type RowTable = 'quota_source' | 'notify_channel';

export interface StoredRow {
  id: string;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  /** 只有提醒渠道有：订阅了哪些事件 */
  events?: string[];
  enabled: boolean;
}

export interface NotifyLog {
  id: number;
  at: number;
  event: string;
  source?: string;
  title: string;
  body: string;
  deliveries?: { channel: string; ok: boolean; error?: string }[];
}

function parseObj(raw: unknown): Record<string, unknown> {
  try {
    const v = JSON.parse(String(raw ?? '{}')) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 会话上次用的运行选项：刷新、换设备、进程退出后再发消息都沿用它 */
export interface RunPrefs {
  model?: string;
  effort?: string;
  permissionMode?: string;
}

export interface Annotation {
  pinned: boolean;
  tags: string[];
  /** 用户起的标题，覆盖 agent 自己的 */
  title?: string;
}

/**
 * 补全 / 用量的算法变了就加一：旧缓存整表作废，下次重新扫。
 * 2：Claude 花费改为按进程累加 cost-state（0.6.0）
 */
const SCAN_VERSION = 2;

/**
 * 索引缓存。原则：这个库随时可以删，删了只是要重新扫一遍，
 * 会话的真相永远在 agent 自己的文件里。
 */
export class IndexDb {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS session_meta (
        id        TEXT PRIMARY KEY,
        size      INTEGER NOT NULL,
        mtime     INTEGER NOT NULL,
        turns     INTEGER NOT NULL DEFAULT 0,
        cost_usd  REAL,
        preview   TEXT,
        refined_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS annotation (
        id     TEXT PRIMARY KEY,
        pinned INTEGER NOT NULL DEFAULT 0,
        tags   TEXT,
        note   TEXT,
        title_override TEXT
      );
      CREATE TABLE IF NOT EXISTS usage_cache (
        id      TEXT PRIMARY KEY,
        size    INTEGER NOT NULL,
        mtime   INTEGER NOT NULL,
        buckets TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_prefs (
        id    TEXT PRIMARY KEY,
        prefs TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quota_source (
        id      TEXT PRIMARY KEY,
        kind    TEXT NOT NULL,
        name    TEXT NOT NULL,
        config  TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notify_channel (
        id      TEXT PRIMARY KEY,
        kind    TEXT NOT NULL,
        name    TEXT NOT NULL,
        config  TEXT NOT NULL,
        events  TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notify_log (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        at     INTEGER NOT NULL,
        event  TEXT NOT NULL,
        source TEXT,
        title  TEXT NOT NULL,
        body   TEXT NOT NULL,
        deliveries TEXT
      );
      CREATE TABLE IF NOT EXISTS kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const row = this.db.prepare("SELECT value FROM kv WHERE key = 'scan_version'").get() as { value: string } | undefined;
    if (Number(row?.value) !== SCAN_VERSION) {
      this.db.exec('DELETE FROM session_meta; DELETE FROM usage_cache;');
      this.db
        .prepare("INSERT INTO kv (key, value) VALUES ('scan_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(SCAN_VERSION));
    }
  }

  /**
   * fresh：文件没变（size+mtime 一致），结果就是准的；
   * 否则如果文件只是变长了（会话文件只追加），旧结果仍可作为下限使用，但需要重新补全。
   */
  getRefined(id: string, size: number, mtime: number): (RefinedRow & { fresh: boolean }) | null {
    const row = this.db
      .prepare('SELECT turns, cost_usd, preview, size, mtime FROM session_meta WHERE id = ?')
      .get(id) as
      | { turns: number; cost_usd: number | null; preview: string | null; size: number; mtime: number }
      | undefined;
    if (!row || size < row.size) return null;
    return {
      turns: row.turns,
      costUsd: row.cost_usd ?? undefined,
      preview: row.preview ?? undefined,
      fresh: row.size === size && row.mtime === mtime,
    };
  }

  putRefined(id: string, size: number, mtime: number, row: RefinedRow): void {
    this.db
      .prepare(
        `INSERT INTO session_meta (id, size, mtime, turns, cost_usd, preview, refined_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           size=excluded.size, mtime=excluded.mtime, turns=excluded.turns,
           cost_usd=excluded.cost_usd, preview=excluded.preview, refined_at=excluded.refined_at`,
      )
      .run(id, size, mtime, row.turns, row.costUsd ?? null, row.preview ?? null, Date.now());
  }

  /** 文件没变（size+mtime 一致）才复用；用量是全量结果，变长了也要重算 */
  getUsage(id: string, size: number, mtime: number): UsageBucket[] | null {
    const row = this.db.prepare('SELECT size, mtime, buckets FROM usage_cache WHERE id = ?').get(id) as
      | { size: number; mtime: number; buckets: string }
      | undefined;
    if (!row || row.size !== size || row.mtime !== mtime) return null;
    try {
      return JSON.parse(row.buckets) as UsageBucket[];
    } catch {
      return null;
    }
  }

  putUsage(id: string, size: number, mtime: number, buckets: UsageBucket[]): void {
    this.db
      .prepare(
        `INSERT INTO usage_cache (id, size, mtime, buckets) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, buckets=excluded.buckets`,
      )
      .run(id, size, mtime, JSON.stringify(buckets));
  }

  annotations(): Map<string, Annotation> {
    const rows = this.db.prepare('SELECT id, pinned, tags, title_override FROM annotation').all() as {
      id: string;
      pinned: number;
      tags: string | null;
      title_override: string | null;
    }[];
    const out = new Map<string, Annotation>();
    for (const r of rows) {
      let tags: string[] = [];
      try {
        const parsed = r.tags ? (JSON.parse(r.tags) as unknown) : [];
        if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
      } catch {
        /* 坏数据当没有标签 */
      }
      out.set(r.id, { pinned: r.pinned === 1, tags, title: r.title_override ?? undefined });
    }
    return out;
  }

  /** 什么都没标的行直接删掉，表里只留有意义的注解 */
  putAnnotation(id: string, a: Annotation): void {
    if (!a.pinned && !a.tags.length && !a.title) {
      this.db.prepare('DELETE FROM annotation WHERE id = ?').run(id);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO annotation (id, pinned, tags, title_override) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET pinned=excluded.pinned, tags=excluded.tags, title_override=excluded.title_override`,
      )
      .run(id, a.pinned ? 1 : 0, JSON.stringify(a.tags), a.title ?? null);
  }

  getPrefs(id: string): RunPrefs | null {
    const row = this.db.prepare('SELECT prefs FROM session_prefs WHERE id = ?').get(id) as { prefs: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.prefs) as RunPrefs;
    } catch {
      return null;
    }
  }

  /** 合并写入：只改传进来的字段；值为 undefined 的字段表示"回到默认"，从记录里删掉 */
  patchPrefs(id: string, patch: RunPrefs): void {
    const next: Record<string, unknown> = { ...(this.getPrefs(id) ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    this.db
      .prepare(
        `INSERT INTO session_prefs (id, prefs, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET prefs=excluded.prefs, updated_at=excluded.updated_at`,
      )
      .run(id, JSON.stringify(next), Date.now());
  }

  getKv(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setKv(key: string, value: string): void {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  getJson<T>(key: string, fallback: T): T {
    const raw = this.getKv(key);
    if (raw === undefined) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  setJson(key: string, value: unknown): void {
    this.setKv(key, JSON.stringify(value));
  }

  /* ── 订阅源 / 提醒渠道：同一种"带 JSON 配置的行" ───────────── */

  listRows(table: RowTable): StoredRow[] {
    const rows = this.db.prepare(`SELECT * FROM ${table} ORDER BY created_at`).all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind),
      name: String(r.name),
      config: parseObj(r.config),
      events: r.events === undefined ? undefined : (parseObj(r.events) as unknown as string[]),
      enabled: r.enabled === 1,
    }));
  }

  putRow(table: RowTable, row: StoredRow): void {
    const cols = table === 'notify_channel' ? ', events' : '';
    const vals = table === 'notify_channel' ? ', ?' : '';
    const args: (string | number)[] = [row.id, row.kind, row.name, JSON.stringify(row.config), row.enabled ? 1 : 0, Date.now()];
    if (table === 'notify_channel') args.push(JSON.stringify(row.events ?? []));
    this.db
      .prepare(
        `INSERT INTO ${table} (id, kind, name, config, enabled, created_at${cols}) VALUES (?, ?, ?, ?, ?, ?${vals})
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, name=excluded.name, config=excluded.config, enabled=excluded.enabled${
           table === 'notify_channel' ? ', events=excluded.events' : ''
         }`,
      )
      .run(...args);
  }

  deleteRow(table: RowTable, id: string): void {
    this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  }

  addLog(entry: Omit<NotifyLog, 'id'>): number {
    const r = this.db
      .prepare('INSERT INTO notify_log (at, event, source, title, body, deliveries) VALUES (?, ?, ?, ?, ?, ?)')
      .run(entry.at, entry.event, entry.source ?? null, entry.title, entry.body, JSON.stringify(entry.deliveries ?? []));
    // 只留最近 500 条
    this.db.prepare('DELETE FROM notify_log WHERE id <= ?').run(Number(r.lastInsertRowid) - 500);
    return Number(r.lastInsertRowid);
  }

  updateLogDeliveries(id: number, deliveries: NotifyLog['deliveries']): void {
    this.db.prepare('UPDATE notify_log SET deliveries = ? WHERE id = ?').run(JSON.stringify(deliveries ?? []), id);
  }

  listLog(after = 0, limit = 50): NotifyLog[] {
    const rows = this.db
      .prepare('SELECT * FROM notify_log WHERE id > ? ORDER BY id DESC LIMIT ?')
      .all(after, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      at: Number(r.at),
      event: String(r.event),
      source: r.source === null ? undefined : String(r.source),
      title: String(r.title),
      body: String(r.body),
      deliveries: (() => {
        try {
          return JSON.parse(String(r.deliveries ?? '[]')) as NotifyLog['deliveries'];
        } catch {
          return [];
        }
      })(),
    }));
  }

  close(): void {
    this.db.close();
  }
}
