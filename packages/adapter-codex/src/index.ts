import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import {
  lineEndAt,
  oneLine,
  readLinesBefore,
  readLinesFrom,
  safeJsonParse,
  searchLines,
  streamLines,
  type AgentAdapter,
  type EventWindow,
  type Line,
  type ModelInfo,
  type ReplayOptions,
  type RunHandle,
  type RunRequest,
  type RunSink,
  type SearchHit,
  type SearchQuery,
  type SessionSummary,
  type UnifiedEvent,
} from '@agentctl/core';
import { probeCodexModels, startCodexRun } from './live.ts';
import { humanPrompt, isTurnStart, parseLine, type ParseCtx } from './parse.ts';

type Rec = Record<string, unknown>;

/** 只有这么大以内的文件，discover 直接读全文（Codex 的 rollout 普遍只有几百 KB） */
const WHOLE_FILE_BYTES = 512 * 1024;
const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 128 * 1024;

interface TurnIndex {
  size: number;
  mtime: number;
  /** 每一轮 task_started 行的字节偏移，升序 */
  starts: number[];
}

/** 列出 sessions/YYYY/MM/DD/ 下所有 rollout 文件 */
async function walk(dir: string, depth = 0): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory() && depth < 4) out.push(...(await walk(p, depth + 1)));
    else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function parseLines(lines: Line[]): { line: Rec; offset: number }[] {
  const out: { line: Rec; offset: number }[] = [];
  for (const l of lines) {
    const d = safeJsonParse(l.text) as Rec | null;
    if (d) out.push({ line: d, offset: l.offset });
  }
  return out;
}

export class CodexAdapter implements AgentAdapter {
  id = 'codex' as const;
  meta = {
    name: 'Codex',
    binary: 'codex',
    dataDir: '~/.codex/sessions',
    docs: 'https://github.com/openai/codex',
  };
  capabilities = {
    discover: true,
    replay: true,
    live: 'rpc' as const,
    resume: true,
    fork: true,
    approvals: true,
    thinking: true,
    usage: true,
  };

  private readonly root: string;
  private readonly turnIndex = new Map<string, TurnIndex>();

  constructor(root = join(homedir(), '.codex')) {
    this.root = root;
  }

  /** session_index.jsonl：id → 最新的 thread_name（追加写，同一 id 可能出现多次，取最后一条） */
  private async threadNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    let text = '';
    try {
      text = await readFile(join(this.root, 'session_index.jsonl'), 'utf8');
    } catch {
      return names;
    }
    for (const raw of text.split('\n')) {
      const d = safeJsonParse(raw) as Rec | null;
      if (d && typeof d.id === 'string' && typeof d.thread_name === 'string' && d.thread_name.trim()) {
        names.set(d.id, d.thread_name.trim());
      }
    }
    return names;
  }

  async discover(): Promise<SessionSummary[]> {
    const [files, names] = await Promise.all([walk(join(this.root, 'sessions')), this.threadNames()]);
    const out: SessionSummary[] = [];
    for (const file of files) {
      const s = await this.summarize(file, names).catch(() => null);
      if (s) out.push(s);
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  private async summarize(file: string, names: Map<string, string>): Promise<SessionSummary | null> {
    const st = await stat(file);
    if (!st.isFile() || st.size === 0) return null;

    const whole = st.size <= WHOLE_FILE_BYTES;
    const head = parseLines((await readLinesFrom(file, 0, whole ? st.size : HEAD_BYTES)).lines);
    const tail = whole ? [] : parseLines((await readLinesBefore(file, st.size, TAIL_BYTES)).lines);

    let sessionId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(file)?.[1] ?? '';
    let cwd = '';
    let subagent: string | undefined;
    let preview: string | undefined;
    let model: string | undefined;
    let lastTs: string | undefined;
    let turns = 0;

    for (const { line } of [...head, ...tail]) {
      const payload = (line.payload ?? {}) as Rec;
      if (line.type === 'session_meta') {
        if (typeof payload.id === 'string') sessionId = payload.id;
        if (typeof payload.cwd === 'string') cwd = payload.cwd;
        const source = payload.source as Rec | string | undefined;
        const sub = typeof source === 'object' ? (source.subagent as Rec | string | undefined) : undefined;
        if (sub) subagent = typeof sub === 'string' ? sub : String(Object.values(sub)[0] ?? 'subagent');
      }
      if (line.type === 'turn_context') {
        if (typeof payload.model === 'string') model = payload.model;
        if (!cwd && typeof payload.cwd === 'string') cwd = payload.cwd;
      }
      if (!preview) {
        const p = humanPrompt(line);
        if (p) preview = oneLine(p, 160);
      }
      if (typeof line.timestamp === 'string' && (!lastTs || line.timestamp > lastTs)) lastTs = line.timestamp;
    }
    // 读了全文才能数准轮次；大文件交给 refine
    if (whole) turns = head.filter(({ line }) => isTurnStart(line)).length;

    const name = names.get(sessionId);
    const title = name || preview || `${sessionId.slice(0, 8)} · ${cwd.split('/').filter(Boolean).pop() ?? 'codex'}`;
    return {
      id: `codex:${sessionId}`,
      agent: 'codex',
      sessionId,
      cwd,
      file,
      title,
      model,
      turns,
      sizeBytes: st.size,
      mtime: st.mtimeMs,
      updatedAt: lastTs ?? new Date(st.mtimeMs).toISOString(),
      preview,
      subagent,
    };
  }

  /**
   * Codex 的行上没有轮次号，只有每轮开头一条 task_started。
   * 记下它们的字节偏移，任意窗口里的行都能二分出自己属于第几轮；按 size+mtime 缓存。
   */
  private async turnStarts(session: SessionSummary): Promise<number[]> {
    const st = await stat(session.file);
    const cached = this.turnIndex.get(session.file);
    if (cached && cached.size === st.size && cached.mtime === st.mtimeMs) return cached.starts;

    let starts: number[] = [];
    let from = 0;
    // 文件只会追加：在旧索引基础上只扫新增部分
    if (cached && st.size > cached.size) {
      starts = [...cached.starts];
      from = cached.size;
    }
    const win = await readLinesFrom(session.file, from, st.size - from);
    for (const l of win.lines) {
      if (l.text.includes('"type":"task_started"') && isTurnStart((safeJsonParse(l.text) as Rec | null) ?? {})) {
        starts.push(l.offset);
      }
    }
    this.turnIndex.set(session.file, { size: win.end, mtime: st.mtimeMs, starts });
    return starts;
  }

  private parseWindow(session: SessionSummary, lines: Line[], starts: number[]): UnifiedEvent[] {
    const ctx: ParseCtx = { file: session.file, sessionId: session.sessionId, turn: 0, model: session.model };
    const events: UnifiedEvent[] = [];
    let i = 0;
    for (const { line, offset } of parseLines(lines)) {
      while (i < starts.length && starts[i] <= offset) i += 1;
      ctx.turn = i;
      events.push(...parseLine(line, offset, ctx));
    }
    return events;
  }

  async replay(session: SessionSummary, opts: ReplayOptions = {}): Promise<EventWindow> {
    const size = (await stat(session.file)).size;
    const end = opts.through !== undefined ? await lineEndAt(session.file, opts.through) : (opts.before ?? size);
    const win = await readLinesBefore(session.file, end, opts.maxBytes ?? 2 * 1024 * 1024);
    const starts = await this.turnStarts(session);
    return {
      events: this.parseWindow(session, win.lines, starts),
      nextBefore: win.start > 0 ? win.start : null,
      hasMore: win.hasMore,
      window: { start: win.start, end: win.end },
    };
  }

  async replayAfter(session: SessionSummary, after: number, maxBytes = 4 * 1024 * 1024): Promise<EventWindow> {
    const win = await readLinesFrom(session.file, after, maxBytes);
    const starts = await this.turnStarts(session);
    return {
      events: this.parseWindow(session, win.lines, starts),
      nextBefore: null,
      hasMore: win.hasMore,
      window: { start: win.start, end: win.end },
    };
  }

  async search(session: SessionSummary, q: SearchQuery, limit: number): Promise<SearchHit[]> {
    const starts = await this.turnStarts(session);
    const ctx: ParseCtx = { file: session.file, sessionId: session.sessionId, turn: 0, model: session.model };
    let i = 0;
    return searchLines(
      streamLines(session.file),
      q,
      (l) => {
        const d = safeJsonParse(l.text) as Rec | null;
        return d ? parseLine(d, l.offset, ctx) : [];
      },
      {
        limit,
        visit: (l) => {
          while (i < starts.length && starts[i] <= l.offset) i += 1;
          ctx.turn = i;
        },
      },
    );
  }

  run(req: RunRequest, sink: RunSink): RunHandle {
    return startCodexRun(req, sink);
  }

  private modelCache: { at: number; models: ModelInfo[] } | null = null;

  /** 问 app-server 要模型列表（只握手，不花钱），缓存 10 分钟 */
  async models(binary?: string): Promise<ModelInfo[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < 10 * 60_000) return this.modelCache.models;
    const models = await probeCodexModels(binary);
    this.modelCache = { at: Date.now(), models };
    return models;
  }

  resumeArgs(session: SessionSummary): string[] {
    return ['resume', session.sessionId];
  }

  /** 大文件的轮次数与首条提问（discover 只读了头尾） */
  async refine(session: SessionSummary): Promise<Partial<SessionSummary>> {
    let turns = 0;
    let preview = session.preview;
    for await (const l of streamLines(session.file)) {
      if (l.text.includes('"type":"task_started"')) turns += 1;
      if (!preview && (l.text.includes('"user_message"') || l.text.includes('"UserMessage"'))) {
        const p = humanPrompt((safeJsonParse(l.text) as Rec | null) ?? {});
        if (p) preview = oneLine(p, 160);
      }
    }
    return { turns, preview };
  }
}
