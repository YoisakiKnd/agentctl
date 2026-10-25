import { open } from 'node:fs/promises';

/**
 * 按字节区间读取完整行，且保证区间边界对齐到行首。
 *
 * 这是整个系统性能的关键：本机单个 Claude 会话文件可达 175MB / 13KB 一行，
 * 整文件读入必然爆内存，所以一切读取都基于「字节游标 + 窗口」。
 */
export interface Line {
  text: string;
  /** 该行在文件中的起始字节偏移，可直接当稳定 id 用 */
  offset: number;
}

export interface LineWindow {
  lines: Line[];
  /** 本窗口第一条完整行的字节偏移 */
  start: number;
  /** 本窗口结束（不含）的字节偏移 */
  end: number;
  /** 游标之前还有内容 */
  hasMore: boolean;
}

const DEFAULT_CHUNK = 2 * 1024 * 1024; // 2MB
const MAX_CHUNK = 32 * 1024 * 1024; // 单行异常巨大时的上限

/**
 * 读取 [end - maxBytes, end) 区间内的完整行。
 * 若窗口左边界落在行中间，该残缺行会被丢弃，并把 start 右移到下一个行首，
 * 因此返回的 start 永远是可以安全作为下次游标的行边界。
 */
export async function readLinesBefore(
  file: string,
  end: number,
  maxBytes = DEFAULT_CHUNK,
): Promise<LineWindow> {
  const fh = await open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const stop = Math.min(Math.max(end, 0), size);
    let budget = Math.min(maxBytes, stop);

    for (;;) {
      const from = Math.max(0, stop - budget);
      const len = stop - from;
      const buf = Buffer.alloc(len);
      if (len > 0) await fh.read(buf, 0, len, from);

      let begin = 0;
      if (from > 0) {
        const nl = buf.indexOf(0x0a);
        if (nl === -1) {
          // 整段窗口里没有换行：说明单行比预算还大，扩大预算重试
          if (budget >= MAX_CHUNK || from === 0) {
            return { lines: [], start: stop, end: stop, hasMore: from > 0 };
          }
          budget = Math.min(budget * 4, MAX_CHUNK);
          continue;
        }
        begin = nl + 1;
      }

      const start = from + begin;
      const lines: Line[] = [];
      let p = begin;
      while (p < buf.length) {
        const nl = buf.indexOf(0x0a, p);
        // 末尾没换行的残行可能是 agent 正写到一半，不返回；end 也停在它前面，
        // 这样调用方拿 end 当增量游标时下次能把它完整读到
        if (nl === -1) break;
        if (nl > p) lines.push({ text: buf.toString('utf8', p, nl), offset: start + (p - begin) });
        p = nl + 1;
      }
      return { lines, start, end: from + p, hasMore: start > 0 };
    }
  } finally {
    await fh.close();
  }
}

/** 从 startOffset（必须是行边界）向前读取最多 maxBytes 的完整行，用于读文件头部 */
export async function readLinesFrom(
  file: string,
  startOffset = 0,
  maxBytes = 256 * 1024,
): Promise<LineWindow> {
  const fh = await open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const from = Math.min(startOffset, size);
    const len = Math.min(maxBytes, size - from);
    const buf = Buffer.alloc(len);
    if (len > 0) await fh.read(buf, 0, len, from);

    const lines: Line[] = [];
    let p = 0;
    let consumed = 0;
    while (p < buf.length) {
      const nl = buf.indexOf(0x0a, p);
      if (nl === -1) break; // 末尾残行不返回
      lines.push({ text: buf.toString('utf8', p, nl), offset: from + p });
      p = nl + 1;
      consumed = p;
    }
    return { lines, start: from, end: from + consumed, hasMore: from + consumed < size };
  } finally {
    await fh.close();
  }
}

/** 逐行流式扫描整个文件（后台索引用，内存恒定） */
export async function* streamLines(file: string): AsyncGenerator<Line> {
  const fh = await open(file, 'r');
  try {
    const stream = fh.createReadStream({ start: 0 });
    let buf: Buffer = Buffer.alloc(0);
    let offset = 0;
    for await (const chunk of stream) {
      buf = buf.length ? Buffer.concat([buf, chunk as Buffer]) : (chunk as Buffer);
      let p = 0;
      for (;;) {
        const nl = buf.indexOf(0x0a, p);
        if (nl === -1) break;
        yield { text: buf.toString('utf8', p, nl), offset: offset + p };
        p = nl + 1;
      }
      offset += p;
      buf = buf.subarray(p);
    }
    if (buf.length > 0) yield { text: buf.toString('utf8'), offset };
  } finally {
    await fh.close();
  }
}

export function safeJsonParse(text: string): unknown | null {
  const t = text.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}
