/**
 * Pi coding agent（~/.pi/agent/sessions/<cwd slug>/<iso>_<uuid>.jsonl，v3）。
 *
 * 会话是一棵树：每条记录带 id / parentId，回退重问会从中间长出新枝。界面上只显示"当前分支"——
 * 从最后写入的那条记录沿 parentId 回溯到根。Pi 的会话通常只有几十 KB，整文件读即可。
 * 本机没装 pi 命令行，只做回放。
 */
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import {
  clip,
  flattenContent,
  oneLine,
  safeJsonParse,
  searchLines,
  summarizeToolInput,
  type AgentAdapter,
  type EventWindow,
  type Item,
  type Line,
  type SearchHit,
  type SearchQuery,
  type SessionSummary,
  type UnifiedEvent,
} from '@agentctl/core';

type Rec = Record<string, unknown>;

interface Entry {
  rec: Rec;
  offset: number;
}

/** 读整个文件，返回当前分支上的记录（文件顺序）和会话头 */
async function mainChain(file: string): Promise<{ header?: Rec; chain: Entry[] }> {
  const text = await readFile(file, 'utf8');
  const byId = new Map<string, Entry>();
  let header: Rec | undefined;
  let last: Entry | undefined;
  let offset = 0;
  for (const raw of text.split('\n')) {
    const rec = safeJsonParse(raw) as Rec | null;
    if (rec) {
      const e = { rec, offset };
      if (rec.type === 'session') header = rec;
      else if (typeof rec.id === 'string') {
        byId.set(rec.id, e);
        last = e;
      }
    }
    offset += Buffer.byteLength(raw, 'utf8') + 1;
  }
  const chain: Entry[] = [];
  const seen = new Set<string>();
  for (let cur = last; cur; ) {
    const id = cur.rec.id as string;
    if (seen.has(id)) break; // 防环
    seen.add(id);
    chain.push(cur);
    const parent = cur.rec.parentId;
    cur = typeof parent === 'string' ? byId.get(parent) : undefined;
  }
  return { header, chain: chain.reverse() };
}

interface Ctx {
  file: string;
  sessionId: string;
  turn: number;
  model?: string;
}

function parseEntry({ rec, offset }: Entry, ctx: Ctx): UnifiedEvent[] {
  const out: UnifiedEvent[] = [];
  const ts = typeof rec.timestamp === 'string' ? rec.timestamp : new Date(0).toISOString();
  const push = (item: Item) =>
    out.push({
      agent: 'pi',
      sessionId: ctx.sessionId,
      turn: ctx.turn,
      seq: offset,
      ts,
      item,
      uid: `${String(rec.id)}:${out.length}`,
      raw: { file: ctx.file, offset, type: String(rec.type) },
    });

  if (rec.type === 'model_change') {
    const model = typeof rec.modelId === 'string' ? rec.modelId : undefined;
    // 第一条是会话开始时的初始选择，不算"切换"
    if (ctx.model && model && model !== ctx.model) {
      push({ kind: 'notice', level: 'info', code: 'model', text: `切换模型：${[rec.provider, model].filter(Boolean).join(' / ')}` });
    }
    ctx.model = model ?? ctx.model;
    return out;
  }
  if (rec.type === 'compaction') {
    push({ kind: 'notice', level: 'info', code: 'compact_boundary', text: '上下文已压缩' });
    return out;
  }
  if (rec.type !== 'message') return out;

  const msg = (rec.message ?? {}) as Rec;
  const content = Array.isArray(msg.content) ? (msg.content as Rec[]) : [];
  switch (msg.role) {
    case 'user': {
      ctx.turn += 1;
      const { texts, media } = flattenContent(content, offset);
      if (texts.length || media.length) push({ kind: 'text', role: 'user', text: texts.join('\n\n'), media: media.length ? media : undefined });
      return out;
    }
    case 'assistant': {
      for (const c of content) {
        if (c.type === 'thinking' && typeof c.thinking === 'string' && c.thinking.trim()) push({ kind: 'thinking', text: c.thinking });
        else if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) push({ kind: 'text', role: 'assistant', text: c.text });
        else if (c.type === 'toolCall') {
          const name = typeof c.name === 'string' ? c.name : 'tool';
          push({ kind: 'tool_call', callId: String(c.id ?? ''), name, input: c.arguments, summary: summarizeToolInput(name, c.arguments) });
        }
      }
      const u = (msg.usage ?? {}) as Rec;
      const num = (v: unknown) => (typeof v === 'number' ? v : 0);
      if (num(u.input) || num(u.output)) {
        push({
          kind: 'usage',
          model: typeof msg.model === 'string' ? msg.model : ctx.model,
          inputTokens: num(u.input),
          outputTokens: num(u.output),
          cacheRead: num(u.cacheRead) || undefined,
          cacheWrite: num(u.cacheWrite) || undefined,
          costUsd: num((u.cost as Rec | undefined)?.total) || undefined,
        });
      }
      return out;
    }
    case 'toolResult': {
      const { texts, media } = flattenContent(content, offset);
      const { text, truncated } = clip(texts.join('\n\n') || (media.length ? `[${media.length} 张图片]` : '（无输出）'));
      push({ kind: 'tool_result', callId: String(msg.toolCallId ?? ''), ok: msg.isError !== true, output: text, truncated });
      return out;
    }
    default:
      return out;
  }
}

function parseChain(chain: Entry[], ctx: Ctx): UnifiedEvent[] {
  return chain.flatMap((e) => parseEntry(e, ctx));
}

export class PiAdapter implements AgentAdapter {
  id = 'pi' as const;
  meta = { name: 'Pi', binary: 'pi', dataDir: '~/.pi/agent/sessions' };
  capabilities = {
    discover: true,
    replay: true,
    live: false as const,
    resume: false,
    fork: false,
    approvals: false,
    thinking: true,
    usage: true,
  };

  private readonly root: string;

  constructor(root = join(homedir(), '.pi', 'agent', 'sessions')) {
    this.root = root;
  }

  async discover(): Promise<SessionSummary[]> {
    let dirs: string[];
    try {
      dirs = await readdir(this.root);
    } catch {
      return [];
    }
    const out: SessionSummary[] = [];
    for (const dir of dirs) {
      let files: string[];
      try {
        files = (await readdir(join(this.root, dir))).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const name of files) {
        const s = await this.summarize(join(this.root, dir, name)).catch(() => null);
        if (s) out.push(s);
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  private async summarize(file: string): Promise<SessionSummary | null> {
    const st = await stat(file);
    if (!st.isFile() || st.size === 0) return null;
    const { header, chain } = await mainChain(file);
    const sessionId = typeof header?.id === 'string' ? header.id : basename(file, '.jsonl').split('_').pop() ?? basename(file);
    const cwd = typeof header?.cwd === 'string' ? header.cwd : '';
    const ctx: Ctx = { file, sessionId, turn: 0 };
    const events = parseChain(chain, ctx);
    const firstUser = events.find((e) => e.item.kind === 'text' && e.item.role === 'user');
    const preview = firstUser && firstUser.item.kind === 'text' ? oneLine(firstUser.item.text, 160) : undefined;
    const cost = events.reduce((sum, e) => sum + (e.item.kind === 'usage' ? (e.item.costUsd ?? 0) : 0), 0);
    if (!preview && ctx.turn === 0) return null;
    return {
      id: `pi:${sessionId}`,
      agent: 'pi',
      sessionId,
      cwd,
      file,
      title: preview ? oneLine(preview, 60) : `${sessionId.slice(0, 8)} · ${basename(cwd) || 'pi'}`,
      model: ctx.model,
      turns: ctx.turn,
      costUsd: cost || undefined,
      sizeBytes: st.size,
      mtime: st.mtimeMs,
      updatedAt: events.at(-1)?.ts ?? new Date(st.mtimeMs).toISOString(),
      preview,
    };
  }

  /** 会话很小，整条分支一次给出；through 跳转时也一样（命中行一定在里面） */
  async replay(session: SessionSummary): Promise<EventWindow> {
    const { chain } = await mainChain(session.file);
    const events = parseChain(chain, { file: session.file, sessionId: session.sessionId, turn: 0 });
    const size = (await stat(session.file)).size;
    return { events, nextBefore: null, hasMore: false, window: { start: 0, end: size } };
  }

  async replayAfter(session: SessionSummary, after: number): Promise<EventWindow> {
    const { chain } = await mainChain(session.file);
    const events = parseChain(chain, { file: session.file, sessionId: session.sessionId, turn: 0 }).filter((e) => e.seq >= after);
    const size = (await stat(session.file)).size;
    return { events, nextBefore: null, hasMore: false, window: { start: after, end: size } };
  }

  async search(session: SessionSummary, q: SearchQuery, limit: number): Promise<SearchHit[]> {
    const { chain } = await mainChain(session.file);
    const ctx: Ctx = { file: session.file, sessionId: session.sessionId, turn: 0 };
    // 用户消息推进轮次，所以每条记录都要过一遍解析；会话很小，无所谓
    const byOffset = new Map<number, UnifiedEvent[]>();
    for (const e of chain) byOffset.set(e.offset, parseEntry(e, ctx));
    const lines: Line[] = chain.map((e) => ({ text: JSON.stringify(e.rec), offset: e.offset }));
    return searchLines(lines, q, (l) => byOffset.get(l.offset) ?? [], { limit });
  }
}
