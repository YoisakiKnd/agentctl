import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { open, readdir, stat } from 'node:fs/promises';
import {
  bufferLineEndAt,
  bufferLines,
  bufferLinesBefore,
  bufferLinesFrom,
  oneLine,
  safeJsonParse,
  searchLines,
  zstdDecompressFrames,
  type AgentAdapter,
  type EventWindow,
  type Line,
  type ReplayOptions,
  type RunHandle,
  type RunRequest,
  type RunSink,
  type SearchHit,
  type SearchQuery,
  type SessionSummary,
  type UnifiedEvent,
} from '@agentctl/core';
import { startDshRun } from './live.ts';
import { parseLine, sourceKind, type ParseCtx } from './parse.ts';

type Rec = Record<string, unknown>;

const SESSION_FILE = 'session.v4.jsonl.zstd';
/** 解压后的会话内容缓存上限：只缓存最近打开的会话，单个大会话解压后能有 25MB */
const BUFFER_CACHE_BYTES = 128 * 1024 * 1024;

interface Decoded {
  size: number;
  mtime: number;
  /** 已完整解出的压缩字节数；文件追加后从这里继续解 */
  consumed: number;
  data: Buffer;
}

/** 列表摘要所需的事实，跟着增量解压逐步累积 */
interface Facts {
  size: number;
  mtime: number;
  consumed: number;
  /** 上次解压结尾没换行的残行 */
  partial: string;
  sessionId?: string;
  cwd?: string;
  title?: string;
  titleFromLlm: boolean;
  subagent?: string;
  model?: string;
  turns: number;
  preview?: string;
  lastTime?: number;
}

async function readFrom(file: string, from: number, to: number): Promise<Buffer> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, to - from));
    if (buf.length) await fh.read(buf, 0, buf.length, from);
    return buf;
  } finally {
    await fh.close();
  }
}

export class DshAdapter implements AgentAdapter {
  id = 'dsh' as const;
  meta = {
    name: 'DeepSeek Harness',
    binary: 'dsh',
    dataDir: '~/.dsh/sessions',
  };
  capabilities = {
    discover: true,
    replay: true,
    live: 'acp' as const,
    resume: true,
    fork: false,
    approvals: true,
    thinking: true,
    usage: true,
  };

  private readonly root: string;
  private readonly facts = new Map<string, Facts>();
  private readonly buffers = new Map<string, Decoded>();

  constructor(root = join(homedir(), '.dsh', 'sessions')) {
    this.root = root;
  }

  async discover(): Promise<SessionSummary[]> {
    let projects: string[];
    try {
      projects = await readdir(this.root);
    } catch {
      return [];
    }
    const out: SessionSummary[] = [];
    for (const project of projects) {
      let dirs: string[];
      try {
        dirs = await readdir(join(this.root, project));
      } catch {
        continue;
      }
      for (const dir of dirs) {
        const file = join(this.root, project, dir, SESSION_FILE);
        const s = await this.summarize(file).catch(() => null);
        if (s) out.push(s);
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  /**
   * 首次要把整个文件解一遍（全部会话约 150MB 原文，一秒左右），之后文件没变直接用缓存，
   * 追加了就只解新增的帧。只留摘要，不留原文。
   */
  private async summarize(file: string): Promise<SessionSummary | null> {
    const st = await stat(file);
    if (!st.isFile() || st.size === 0) return null;

    let f = this.facts.get(file);
    if (!f || st.size < f.consumed) {
      f = { size: 0, mtime: 0, consumed: 0, partial: '', titleFromLlm: false, turns: 0 };
    }
    if (f.size !== st.size || f.mtime !== st.mtimeMs) {
      const chunk = await readFrom(file, f.consumed, st.size);
      const { data, consumed } = zstdDecompressFrames(chunk);
      const text = f.partial + data.toString('utf8');
      const cut = text.lastIndexOf('\n');
      for (const raw of text.slice(0, cut + 1).split('\n')) this.harvest(f, raw);
      f.partial = text.slice(cut + 1);
      f.consumed += consumed;
      f.size = st.size;
      f.mtime = st.mtimeMs;
      this.facts.set(file, f);
    }
    // 打开过但一句话都没说的空会话（只有头记录和权限设置）不进列表
    if (!f.sessionId || (f.turns === 0 && !f.preview)) return null;

    const cwd = f.cwd ?? '';
    // DSH 的 fallback 标题只是把首句截到十几个字；没有正式标题时，首条提问更好读
    const title =
      (f.titleFromLlm && f.title) ||
      (f.preview && oneLine(f.preview, 60)) ||
      f.title ||
      `${f.sessionId.replace(/^session-/, '').slice(0, 8)} · ${basename(cwd) || 'dsh'}`;
    return {
      id: `dsh:${f.sessionId}`,
      agent: 'dsh',
      sessionId: f.sessionId,
      cwd,
      file,
      title,
      model: f.model,
      turns: f.turns,
      sizeBytes: st.size,
      mtime: st.mtimeMs,
      updatedAt: new Date(f.lastTime ?? st.mtimeMs).toISOString(),
      preview: f.preview,
      subagent: f.subagent,
    };
  }

  private harvest(f: Facts, raw: string): void {
    if (!raw) return;
    // 绝大部分行是工具输出、模型请求体；先用便宜的字符串判断筛掉
    const head = raw.slice(0, 64);
    const interesting =
      head.includes('"type":"session"') ||
      head.includes('"session/title"') ||
      head.includes('"turn/start"') ||
      head.includes('"user/message"') ||
      head.includes('"model/selection"') ||
      head.includes('"request/context"') ||
      head.includes('"subagent/descriptor"');
    const time = /"time":(\d{10,})/.exec(head)?.[1];
    if (time) f.lastTime = Number(time);
    if (!interesting) return;

    const d = safeJsonParse(raw) as Rec | null;
    if (!d) return;
    const data = (d.data ?? {}) as Rec;
    switch (d.type) {
      case 'session':
        f.sessionId = typeof d.id === 'string' ? d.id : f.sessionId;
        f.cwd = typeof d.cwd === 'string' ? d.cwd : f.cwd;
        if (d.origin === 'subagent') f.subagent ??= 'subagent';
        break;
      case 'subagent/descriptor':
        f.subagent = 'subagent';
        // 子代理的 label 是派它出去时写的任务名，比首句截断的 fallback 标题好
        if (typeof data.label === 'string' && data.label.trim()) {
          f.title = data.label.trim();
          f.titleFromLlm = true;
        }
        break;
      case 'session/title': {
        // 先有一个首句截断的 fallback 标题，随后模型生成正式标题；正式标题优先
        const llm = sourceKind(data) !== 'fallback';
        if (typeof data.title === 'string' && data.title.trim() && (llm || !f.titleFromLlm)) {
          f.title = data.title.trim();
          f.titleFromLlm = llm;
        }
        break;
      }
      case 'turn/start':
        if (typeof data.turn === 'number') f.turns = Math.max(f.turns, data.turn);
        break;
      case 'user/message':
        if (!f.preview && sourceKind(data) === 'user') {
          const text = (Array.isArray(data.content) ? data.content : [])
            .map((c) => (c && typeof c === 'object' && typeof (c as Rec).text === 'string' ? (c as Rec).text : ''))
            .join(' ');
          if (text.trim()) f.preview = oneLine(text, 160);
        }
        break;
      case 'model/selection':
      case 'request/context':
        if (typeof data.model === 'string') f.model = data.model;
        break;
    }
  }

  /** 解压后的会话内容；LRU 缓存，文件追加时只解新帧 */
  private async decoded(file: string): Promise<Buffer> {
    const st = await stat(file);
    let d = this.buffers.get(file);
    if (d && d.size === st.size && d.mtime === st.mtimeMs) {
      this.buffers.delete(file);
      this.buffers.set(file, d); // 刷新 LRU 次序
      return d.data;
    }
    if (d && st.size >= d.consumed) {
      const { data, consumed } = zstdDecompressFrames(await readFrom(file, d.consumed, st.size));
      d = { size: st.size, mtime: st.mtimeMs, consumed: d.consumed + consumed, data: data.length ? Buffer.concat([d.data, data]) : d.data };
    } else {
      const { data, consumed } = zstdDecompressFrames(await readFrom(file, 0, st.size));
      d = { size: st.size, mtime: st.mtimeMs, consumed, data };
    }
    this.buffers.delete(file);
    this.buffers.set(file, d);
    let total = 0;
    for (const v of this.buffers.values()) total += v.data.length;
    for (const [k, v] of this.buffers) {
      if (total <= BUFFER_CACHE_BYTES || k === file) break;
      this.buffers.delete(k);
      total -= v.data.length;
    }
    return d.data;
  }

  private parseWindow(session: SessionSummary, lines: Line[]): UnifiedEvent[] {
    const ctx: ParseCtx = { file: session.file, sessionId: session.sessionId, turn: 0, model: session.model, turnStartedAt: new Map() };
    const events: UnifiedEvent[] = [];
    for (const l of lines) {
      const d = safeJsonParse(l.text) as Rec | null;
      if (d) events.push(...parseLine(d, l.offset, ctx));
    }
    return events;
  }

  async replay(session: SessionSummary, opts: ReplayOptions = {}): Promise<EventWindow> {
    const data = await this.decoded(session.file);
    const end = opts.through !== undefined ? bufferLineEndAt(data, opts.through) : (opts.before ?? data.length);
    const win = bufferLinesBefore(data, end, opts.maxBytes ?? 2 * 1024 * 1024);
    return {
      events: this.parseWindow(session, win.lines),
      nextBefore: win.start > 0 ? win.start : null,
      hasMore: win.hasMore,
      window: { start: win.start, end: win.end },
    };
  }

  async replayAfter(session: SessionSummary, after: number, maxBytes = 4 * 1024 * 1024): Promise<EventWindow> {
    const data = await this.decoded(session.file);
    const win = bufferLinesFrom(data, after, maxBytes);
    return { events: this.parseWindow(session, win.lines), nextBefore: null, hasMore: win.hasMore, window: { start: win.start, end: win.end } };
  }

  async search(session: SessionSummary, q: SearchQuery, limit: number): Promise<SearchHit[]> {
    const data = await this.decoded(session.file);
    const ctx: ParseCtx = { file: session.file, sessionId: session.sessionId, turn: 0, model: session.model, turnStartedAt: new Map() };
    return searchLines(
      bufferLines(data),
      q,
      (l) => {
        const d = safeJsonParse(l.text) as Rec | null;
        return d ? parseLine(d, l.offset, ctx) : [];
      },
      {
        limit,
        // 轮号在 data 开头附近，只看行首一小段
        visit: (l) => {
          const m = /"turn":(\d+)/.exec(l.text.slice(0, 160));
          if (m) ctx.turn = Number(m[1]);
        },
      },
    );
  }

  run(req: RunRequest, sink: RunSink): RunHandle {
    return startDshRun(req, sink);
  }

  /** 游标是解压后的偏移，和压缩文件的大小没法比，增量追尾时用这个长度 */
  async contentLength(session: SessionSummary): Promise<number> {
    return (await this.decoded(session.file)).length;
  }
}

