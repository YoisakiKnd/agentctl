import { Fragment } from 'react';
import CodeBlock from './CodeBlock';

/**
 * 极简 Markdown：只覆盖 agent 回复里真正会出现的语法（标题、围栏代码、
 * 列表、引用、表格、分隔线、行内代码、粗斜体、链接）。全部用 React 元素拼装，不碰
 * innerHTML，所以会话内容里的 HTML 永远不会被执行。
 */

type Block =
  | { t: 'p'; lines: string[] }
  | { t: 'h'; level: number; text: string }
  | { t: 'code'; lang: string; text: string }
  | { t: 'list'; ordered: boolean; items: string[] }
  | { t: 'quote'; lines: string[] }
  | { t: 'table'; align: Align[]; head: string[]; rows: string[][] }
  | { t: 'hr' };

type Align = 'left' | 'center' | 'right' | undefined;

const FENCE = /^\s*```(\S*)\s*$/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*(\d{1,3})[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$|^[^|`]*\|[^|]*/;
const TABLE_DELIM = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** 按未转义的 | 切单元格；行首尾的 | 可有可无 */
function cells(row: string): string[] {
  const parts = row.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/);
  return parts.map((c) => c.trim().replace(/\\\|/g, '|'));
}

function isTableStart(lines: string[], i: number): boolean {
  if (!TABLE_ROW.test(lines[i]) || i + 1 >= lines.length || !TABLE_DELIM.test(lines[i + 1])) return false;
  // 「一行带 | 的普通文字 + 下面一条 ---」是分隔线，不是表格
  return lines[i + 1].includes('|') || lines[i].trim().startsWith('|');
}

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

    if (isTableStart(lines, i)) {
      const head = cells(line);
      const align: Align[] = cells(lines[i + 1]).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : undefined,
      );
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(cells(lines[i]));
        i += 1;
      }
      blocks.push({ t: 'table', align, head, rows });
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ t: 'hr' });
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
        isTableStart(lines, i) ||
        HR.test(cur) ||
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
              <CodeBlock key={key} text={b.text} lang={b.lang} />
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
          case 'hr':
            return <hr key={key} />;
          case 'table':
            return (
              <div className="md-table" key={key}>
                <table>
                  <thead>
                    <tr>
                      {b.head.map((c, j) => (
                        <th key={j} style={{ textAlign: b.align[j] }}>
                          {inline(c, `${key}-h${j}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={ri}>
                        {b.head.map((_, j) => (
                          <td key={j} style={{ textAlign: b.align[j] }}>
                            {inline(r[j] ?? '', `${key}-${ri}-${j}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return <p key={key}>{inline(b.lines.join('\n'), key)}</p>;
        }
      })}
    </div>
  );
}
