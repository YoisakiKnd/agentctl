import type { MediaRef, TruncInfo } from './events.ts';

/** 单条文本保留上限：再长的工具输出对阅读无益，且会把前端拖死 */
export const MAX_TEXT_CHARS = 4000;

/** 终端颜色 / 光标控制序列：网页里不渲染它们，只会显示成乱码 */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  return text.includes('\x1b') ? text.replace(ANSI, '') : text;
}

export function clip(raw: string, max = MAX_TEXT_CHARS): { text: string; truncated?: TruncInfo } {
  const text = stripAnsi(raw);
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
    pick('cmd') ??
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

/**
 * 两段文本的按行 diff（LCS），输出统一 diff 风格的行：' ' 上下文、'-' 删除、'+' 新增。
 * 只用于展示 agent 的 Edit 这类小片段；任一侧超过 400 行就退化为整段删 + 整段加，免得 O(n·m) 失控。
 */
export function lineDiff(before: string, after: string): { patch: string; added: number; removed: number } {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  const out: string[] = [];
  if (a.length > 400 || b.length > 400) {
    for (const l of a) out.push(`-${l}`);
    for (const l of b) out.push(`+${l}`);
    return { patch: out.join('\n'), added: b.length, removed: a.length };
  }
  // dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if (i < a.length && (j === b.length || dp[i + 1][j] >= dp[i][j + 1])) {
      // 同等长度时先删后加，和 git diff 的习惯一致
      out.push(`-${a[i]}`);
      i += 1;
      removed += 1;
    } else {
      out.push(`+${b[j]}`);
      j += 1;
      added += 1;
    }
  }
  return { patch: out.join('\n'), added, removed };
}
