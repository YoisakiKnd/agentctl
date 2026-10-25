import type { MediaRef, TruncInfo } from './events.ts';

/** 单条文本保留上限：再长的工具输出对阅读无益，且会把前端拖死 */
export const MAX_TEXT_CHARS = 4000;

export function clip(text: string, max = MAX_TEXT_CHARS): { text: string; truncated?: TruncInfo } {
  if (text.length <= max) return { text };
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return {
    text: `${text.slice(0, head)}\n\n… 已省略 ${text.length - max} 字符 …\n\n${text.slice(-tail)}`,
    truncated: { originalChars: text.length, keptHead: head, keptTail: tail },
  };
}

export function oneLine(text: string, max = 120): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

interface Flattened {
  texts: string[];
  media: MediaRef[];
}

/**
 * Anthropic 风格 content：string 或 block 数组。
 * 图片 base64 绝不进入事件体，只留一个 MediaRef（字节数 + 位置）。
 */
export function flattenContent(content: unknown, baseOffset = 0): Flattened {
  const texts: string[] = [];
  const media: MediaRef[] = [];
  if (typeof content === 'string') {
    if (content.trim()) texts.push(content);
    return { texts, media };
  }
  if (!Array.isArray(content)) return { texts, media };

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    const type = b.type;
    if (type === 'text' && typeof b.text === 'string') {
      if (b.text.trim()) texts.push(b.text);
    } else if (type === 'image') {
      const src = b.source as Record<string, unknown> | undefined;
      const data = typeof src?.data === 'string' ? src.data : '';
      media.push({
        kind: 'image',
        mime: typeof src?.media_type === 'string' ? src.media_type : undefined,
        bytes: Math.floor((data.length * 3) / 4),
        offset: baseOffset,
      });
    } else if (type === 'document') {
      media.push({ kind: 'file', bytes: 0, offset: baseOffset });
    }
  }
  return { texts, media };
}

/** 从工具入参里挑一条最能说明"它在干什么"的摘要 */
export function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const pick = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : undefined);
  // AskUserQuestion：摘要用第一个问题本身
  if (Array.isArray(i.questions)) {
    const q = i.questions[0] as { question?: unknown } | undefined;
    if (typeof q?.question === 'string') {
      const more = i.questions.length > 1 ? ` 等 ${i.questions.length} 个问题` : '';
      return oneLine(q.question, 160) + more;
    }
  }
  const candidate =
    pick('command') ??
    pick('file_path') ??
    pick('path') ??
    pick('pattern') ??
    pick('query') ??
    pick('url') ??
    pick('prompt');
  if (candidate) return oneLine(candidate, 160);
  const first = Object.values(i).find((v) => typeof v === 'string') as string | undefined;
  return first ? oneLine(first, 160) : name;
}
