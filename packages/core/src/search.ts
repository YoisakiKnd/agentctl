import type { Item, UnifiedEvent } from './events.ts';
import type { Line } from './lines.ts';

/**
 * 全文搜索：不建索引，直接扫会话文件。
 *
 * 两段式：先用"JSON 转义后的关键词"在原始行上粗筛（行里的引号、换行都是转义过的），
 * 命中的行才解析成事件，再在人能读到的文字里精确匹配。这样不会命中 base64 图片、
 * 请求体、元数据这类读者看不到的东西。
 */

export interface SearchHit {
  /** 事件所在行的偏移（与 replay 的 seq 同一坐标），用来跳转 */
  offset: number;
  uid?: string;
  turn: number;
  ts: string;
  kind: Item['kind'];
  role?: 'user' | 'assistant';
  /** 命中处前后各一段，match 是命中的原文 */
  before: string;
  match: string;
  after: string;
}

export interface SearchQuery {
  /** 在原始 JSON 行上粗筛 */
  raw: RegExp;
  /** 在事件文本上精确匹配 */
  plain: RegExp;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function searchQuery(q: string): SearchQuery {
  return {
    raw: new RegExp(escapeRe(JSON.stringify(q).slice(1, -1)), 'i'),
    plain: new RegExp(escapeRe(q), 'i'),
  };
}

/** 事件里给人看的文字 */
export function eventText(item: Item): string {
  switch (item.kind) {
    case 'text':
    case 'thinking':
    case 'notice':
      return item.text;
    case 'tool_call':
      return `${item.name} ${item.summary ?? ''}`;
    case 'tool_result':
      return item.output;
    case 'diff':
      return item.files.map((f) => `${f.path}\n${f.patch ?? ''}`).join('\n');
    case 'approval':
      return `${item.tool} ${item.detail}`;
    default:
      return '';
  }
}

const CONTEXT = 60;

export function hitOf(ev: UnifiedEvent, q: SearchQuery): SearchHit | null {
  const text = eventText(ev.item);
  const m = q.plain.exec(text);
  if (!m) return null;
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  const start = Math.max(0, m.index - CONTEXT);
  const end = Math.min(text.length, m.index + m[0].length + CONTEXT);
  return {
    offset: ev.seq,
    uid: ev.uid,
    turn: ev.turn,
    ts: ev.ts,
    kind: ev.item.kind,
    role: ev.item.kind === 'text' ? ev.item.role : undefined,
    before: (start > 0 ? '…' : '') + flat(text.slice(start, m.index)).trimStart(),
    match: m[0],
    after: flat(text.slice(m.index + m[0].length, end)).trimEnd() + (end < text.length ? '…' : ''),
  };
}

/**
 * 扫一串行：粗筛 → 解析 → 精确匹配。parse 由适配器提供（它知道怎么维护轮次等上下文），
 * visit 让适配器在每一行（包括没命中的）上更新自己的状态，比如从行里摘出轮号。
 */
export async function searchLines(
  lines: AsyncIterable<Line> | Iterable<Line>,
  q: SearchQuery,
  parse: (line: Line) => UnifiedEvent[],
  opts: { limit: number; visit?: (line: Line) => void },
): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  for await (const line of lines) {
    opts.visit?.(line);
    if (!q.raw.test(line.text)) continue;
    for (const ev of parse(line)) {
      if (ev.item.kind === 'usage') continue;
      const hit = hitOf(ev, q);
      if (hit) hits.push(hit);
      if (hits.length >= opts.limit) return hits;
    }
  }
  return hits;
}
