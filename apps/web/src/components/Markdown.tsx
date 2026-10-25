import { Fragment } from 'react';

/**
 * 极简 Markdown：只覆盖 agent 回复里真正会出现的语法（标题、围栏代码、
 * 列表、引用、行内代码、粗斜体、链接）。全部用 React 元素拼装，不碰
 * innerHTML，所以会话内容里的 HTML 永远不会被执行。
 */

type Block =
  | { t: 'p'; lines: string[] }
  | { t: 'h'; level: number; text: string }
  | { t: 'code'; lang: string; text: string }
  | { t: 'list'; ordered: boolean; items: string[] }
  | { t: 'quote'; lines: string[] };

const FENCE = /^\s*```(\S*)\s*$/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      const lang = fence[1] ?? '';
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过收尾围栏
      blocks.push({ t: 'code', lang, text: body.join('\n') });
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ t: 'h', level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(QUOTE.exec(lines[i])![1]);
        i += 1;
      }
      blocks.push({ t: 'quote', lines: body });
      continue;
    }

    if (UL.test(line) || OL.test(line)) {
      const ordered = !UL.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        const m = ordered ? OL.exec(cur) : UL.exec(cur);
        if (m) {
          items.push(ordered ? m[2] : m[1]);
          i += 1;
          continue;
        }
        // 列表项的续行（缩进对齐）
        if (cur.trim() && /^\s{2,}\S/.test(cur) && items.length > 0) {
          items[items.length - 1] += ` ${cur.trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ t: 'list', ordered, items });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length) {
      const cur = lines[i];
      if (
        !cur.trim() ||
        FENCE.test(cur) ||
        HEADING.test(cur) ||
        QUOTE.test(cur) ||
        UL.test(cur) ||
        OL.test(cur)
      ) {
        break;
      }
      para.push(cur);
      i += 1;
    }
    blocks.push({ t: 'p', lines: para });
  }

  return blocks;
}

// 注意：每次调用都要新建正则实例。共用一个 /g 正则会因为递归调用
// 重置 lastIndex 而陷入死循环（内层解析完，外层的游标被打回 0）。
const INLINE_SRC =
  '(`[^`\\n]+`|\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__|\\*[^*\\n]+\\*|\\[[^\\]\\n]+\\]\\([^)\\s]+\\))';

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(INLINE_SRC, 'g');

  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${keyPrefix}-${m.index}`;

    if (token.startsWith('`')) {
      out.push(
        <code className="md-code" key={key}>
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**') || token.startsWith('__')) {
      out.push(<strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>);
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (link && /^(https?:|mailto:)/.test(link[2])) {
        out.push(
          <a key={key} href={link[2]} target="_blank" rel="noreferrer noopener">
            {link[1]}
          </a>,
        );
      } else {
        out.push(token);
      }
    } else {
      out.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    }
    last = m.index + token.length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

function inline(text: string, keyPrefix: string): React.ReactNode {
  return renderInline(text, keyPrefix).map((node, i) => (
    <Fragment key={`${keyPrefix}-f${i}`}>{node}</Fragment>
  ));
}

export default function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.t) {
          case 'h': {
            const Tag = (`h${Math.min(4, b.level + 2)}`) as 'h3' | 'h4' | 'h5' | 'h6';
            return <Tag key={key}>{inline(b.text, key)}</Tag>;
          }
          case 'code':
            return (
              <pre className="code" key={key} data-lang={b.lang || undefined}>
                {b.text}
              </pre>
            );
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul';
            return (
              <Tag key={key}>
                {b.items.map((item, j) => (
                  <li key={`${key}-${j}`}>{inline(item, `${key}-${j}`)}</li>
                ))}
              </Tag>
            );
          }
          case 'quote':
            return <blockquote key={key}>{inline(b.lines.join('\n'), key)}</blockquote>;
          default:
            return <p key={key}>{inline(b.lines.join('\n'), key)}</p>;
        }
      })}
    </div>
  );
}
