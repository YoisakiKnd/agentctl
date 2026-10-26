import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface RefinedRow {
  turns: number;
  costUsd?: number;
  preview?: string;
}

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
    `);
  }

  /** 只有文件没变（size+mtime 一致）才复用上次扫描结果 */
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

  close(): void {
    this.db.close();
  }
}
