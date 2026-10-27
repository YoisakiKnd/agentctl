import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import {
  flattenContent,
  oneLine,
  readLinesBefore,
  lineEndAt,
  readLinesFrom,
  safeJsonParse,
  searchLines,
  streamLines,
  type AgentAdapter,
  type EventWindow,
  type ModelInfo,
  type ReplayOptions,
  type SearchHit,
  type SearchQuery,
  type RunHandle,
  type RunRequest,
  type RunSink,
  type SessionSummary,
  type UnifiedEvent,
  type UsageBucket,
} from '@agentctl/core';
import { harvest, isHumanPrompt, parseLine, turnIndexOf, type Facts, type ParseCtx } from './parse.ts';
import { probeModels, startClaudeRun } from './live.ts';
import { claudeUsage, CostLedger, ratesFrom } from './usage.ts';

export class ClaudeAdapter implements AgentAdapter {
  id = 'claude' as const;
  meta = {
    name: 'Claude Code',
    binary: 'claude',
    dataDir: '~/.claude/projects',
    docs: 'https://docs.claude.com/en/docs/claude-code',
  };
  capabilities = {
    discover: true,
    replay: true,
    live: 'stream-json' as const,
    resume: true,
    fork: true,
    approvals: true,
    thinking: true,
    usage: true,
  };

  private readonly root: string;

  constructor(root = join(homedir(), '.claude', 'projects')) {
    this.root = root;
  }

  async discover(): Promise<SessionSummary[]> {
    let projects: string[];
    try {
      projects = await readdir(this.root);
    } catch {
      return [];
    }

    const summaries: SessionSummary[] = [];
    for (const project of projects) {
      const dir = join(this.root, project);
      let files: string[];
      try {
        files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const name of files) {
        const summary = await this.summarize(join(dir, name));
        if (summary) summaries.push(summary);
      }
    }
    return summaries.sort((a, b) => b.mtime - a.mtime);
  }

  /** 只读头 64KB + 尾 96KB，绝不整文件解析 */
  private async summarize(file: string): Promise<SessionSummary | null> {
    let size = 0;
    let mtime = 0;
    try {
      const st = await stat(file);
      if (!st.isFile() || st.size === 0) return null;
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      return null;
    }

    const facts: Facts = { turns: 0, unknown: {} };
    const head = await readLinesFrom(file, 0, 64 * 1024);
    for (const l of head.lines) {
      const d = safeJsonParse(l.text) as Record<string, unknown> | null;
      if (d) harvest(d, facts, true);
    }
    const tail = await readLinesBefore(file, size, 96 * 1024);
    for (const l of tail.lines) {
      const d = safeJsonParse(l.text) as Record<string, unknown> | null;
      if (d) harvest(d, facts, false);
    }

    const sessionId = facts.sessionId ?? file.split('/').pop()!.replace(/\.jsonl$/, '');
    if (facts.modelUsage) this.lastCostState.set(file, facts.modelUsage);
    const cwd = facts.cwd ?? '';
    const title =
      facts.title ||
      facts.preview ||
      `${sessionId.slice(0, 8)} · ${cwd.split('/').filter(Boolean).pop() ?? 'unknown'}`;

    return {
      id: `claude:${sessionId}`,
      agent: 'claude',
      sessionId,
      cwd,
      file,
      title,
      model: facts.model,
      turns: facts.turns,
      costUsd: facts.costUsd,
      sizeBytes: size,
      mtime,
      updatedAt: facts.lastTs ?? new Date(mtime).toISOString(),
      preview: facts.preview,
      unknownTypes: Object.keys(facts.unknown).length ? facts.unknown : undefined,
    };
  }

  async replay(session: SessionSummary, opts: ReplayOptions = {}): Promise<EventWindow> {
    const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
    const size = (await stat(session.file)).size;
    const end = opts.through !== undefined ? await lineEndAt(session.file, opts.through) : (opts.before ?? size);
    const win = await readLinesBefore(session.file, end, maxBytes);

    const ctx: ParseCtx = { file: session.file, sessionId: session.sessionId, turn: 0 };
    const events: UnifiedEvent[] = [];
    for (const line of win.lines) {
      const d = safeJsonParse(line.text) as Record<string, unknown> | null;
      if (!d) continue;
      const t = turnIndexOf(d);
      if (t !== undefined) ctx.turn = t;
      events.push(...parseLine(d, line.offset, ctx));
    }

    return {
      events,
      nextBefore: win.start > 0 ? win.start : null,
      hasMore: win.hasMore,
      window: { start: win.start, end: win.end },
    };
  }

  async replayAfter(session: SessionSummary, after: number, maxBytes = 4 * 1024 * 1024): Promise<EventWindow> {
    const win = await readLinesFrom(session.file, after, maxBytes);
    // 增量里拿不到 turnPosition 的行（system 等）沿用最近一次见到的轮号
    const ctx: ParseCtx = { file: session.file, sessionId: session.sessionId, turn: 0 };
    const events: UnifiedEvent[] = [];
    for (const line of win.lines) {
      const d = safeJsonParse(line.text) as Record<string, unknown> | null;
      if (!d) continue;
      const t = turnIndexOf(d);
      if (t !== undefined) ctx.turn = t;
      events.push(...parseLine(d, line.offset, ctx));
    }
    return { events, nextBefore: null, hasMore: win.hasMore, window: { start: win.start, end: win.end } };
  }

  private modelCache: { at: number; models: ModelInfo[] } | null = null;

  /** 问 CLI 自己要模型列表（initialize 握手，不发消息、不花钱），缓存 10 分钟 */
  async models(binary?: string): Promise<ModelInfo[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < 10 * 60_000) return this.modelCache.models;
    const models = await probeModels(binary);
    this.modelCache = { at: Date.now(), models };
    return models;
  }

  /**
   * 后台全量扫描：discover 只看头尾，轮次数和总花费会不准。
   * 这里流式过一遍文件，但只对包含关键字段的少量行做 JSON 解析，
   * 175MB 的文件约 0.6s，跑在后台不阻塞首屏。
   */
  async refine(session: SessionSummary): Promise<Partial<SessionSummary>> {
    let turns = 0;
    const ledger = new CostLedger();
    let preview = session.preview;

    for await (const line of streamLines(session.file)) {
      if (line.text.length > 8192) continue; // 巨型行不可能是我们要的元数据
      if (
        !preview &&
        (line.text.includes('"promptSource":"typed"') || line.text.includes('"promptSource":"sdk"'))
      ) {
        const d = safeJsonParse(line.text) as Record<string, unknown> | null;
        if (d && isHumanPrompt(d)) {
          const { texts } = flattenContent(
            (d.message as { content?: unknown } | undefined)?.content,
          );
          if (texts.length) preview = oneLine(texts.join(' '), 160);
        }
      }
      if (line.text.includes('"turnPosition"')) {
        const d = safeJsonParse(line.text) as Record<string, unknown> | null;
        if (d) {
          const t = turnIndexOf(d);
          if (t !== undefined) turns = Math.max(turns, t);
        }
      }
      if (line.text.startsWith('{"type":"cost-state"')) {
        const d = safeJsonParse(line.text) as Record<string, unknown> | null;
        if (d) ledger.feed(d);
      }
    }

    return { turns, costUsd: ledger.total || session.costUsd, preview };
  }

  /** discover 读尾部时拿到的各会话最后一次记账，给还没记账的回复估价用 */
  private readonly lastCostState = new Map<string, Record<string, Record<string, unknown>>>();

  usage(session: SessionSummary): Promise<UsageBucket[]> {
    return claudeUsage(session.file, () => ratesFrom(this.lastCostState.values()));
  }

  async search(session: SessionSummary, q: SearchQuery, limit: number): Promise<SearchHit[]> {
    const ctx: ParseCtx = { file: session.file, sessionId: session.sessionId, turn: 0 };
    return searchLines(
      streamLines(session.file),
      q,
      (l) => {
        const d = safeJsonParse(l.text) as Record<string, unknown> | null;
        return d ? parseLine(d, l.offset, ctx) : [];
      },
      {
        limit,
        // 轮号直接从行里摘，不必为了它解析每一行
        visit: (l) => {
          const m = /"turnIndex":(\d+)/.exec(l.text);
          if (m) ctx.turn = Number(m[1]);
        },
      },
    );
  }

  resumeArgs(session: SessionSummary): string[] {
    return ['--resume', session.sessionId];
  }

  run(req: RunRequest, sink: RunSink): RunHandle {
    return startClaudeRun(req, sink);
  }
}
