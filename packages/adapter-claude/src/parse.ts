/**
 * Claude Code 行格式 → UnifiedEvent。
 * 磁盘上的 jsonl 与 `claude -p --output-format stream-json` 吐出的 user/assistant 行同构，
 * 回放和实时运行共用这里的解析，保证两边事件长得一样、uid 一致。
 */
import { clip, flattenContent, lineDiff, oneLine, summarizeToolInput, type Item, type UnifiedEvent } from '@agentctl/core';

/** 这些行是 Claude Code 的内部记账，对阅读时间线没有价值 */
export const NOISE = new Set([
  'mode',
  'permission-mode',
  'atis-latch',
  'file-history-snapshot',
  'file-history-delta',
  'api-request',
  'api-request-shape',
  'api-request-blob',
  'attachment',
  'last-prompt',
  'queue-operation',
]);

export interface Facts {
  sessionId?: string;
  cwd?: string;
  title?: string;
  model?: string;
  turns: number;
  costUsd?: number;
  /** 最后一行 cost-state 的按模型累计（用量估价参考单价用） */
  modelUsage?: Record<string, Record<string, unknown>>;
  lastTs?: string;
  preview?: string;
  unknown: Record<string, number>;
}

export function note(facts: Facts, type: string | undefined) {
  if (!type) return;
  facts.unknown[type] = (facts.unknown[type] ?? 0) + 1;
}

/** 从任意一行里抽取对「摘要」有用的信息 */
export function harvest(line: Record<string, unknown>, facts: Facts, head: boolean) {
  const type = typeof line.type === 'string' ? line.type : undefined;
  if (type === 'ai-title' && typeof line.aiTitle === 'string') {
    facts.title ??= line.aiTitle.trim();
  }
  if (typeof line.sessionId === 'string') facts.sessionId ??= line.sessionId;
  if (typeof line.cwd === 'string') facts.cwd ??= line.cwd;

  const ts = typeof line.timestamp === 'string' ? line.timestamp : undefined;
  if (ts) {
    // 头尾两段扫描：保留"更大"的那个时间戳
    if (!facts.lastTs || ts > facts.lastTs) facts.lastTs = ts;
  }

  const turnPos = line.turnPosition as { turnIndex?: unknown } | undefined;
  if (turnPos && typeof turnPos.turnIndex === 'number') {
    facts.turns = Math.max(facts.turns, turnPos.turnIndex);
  }

  if (type === 'assistant') {
    const msg = line.message as { model?: unknown } | undefined;
    if (typeof msg?.model === 'string') facts.model = msg.model;
  }

  if (type === 'cost-state' && typeof line.totalCostUSD === 'number') {
    facts.costUsd = line.totalCostUSD;
    if (line.modelUsage && typeof line.modelUsage === 'object') {
      facts.modelUsage = line.modelUsage as Record<string, Record<string, unknown>>;
    }
  }

  if (type === 'user' && head && !facts.preview && isHumanPrompt(line)) {
    const { texts } = flattenContent((line.message as { content?: unknown } | undefined)?.content);
    if (texts.length) facts.preview = oneLine(texts.join(' '), 160);
  }
}

export function isHumanPrompt(line: Record<string, unknown>): boolean {
  const origin = line.origin as { kind?: unknown } | undefined;
  if (origin?.kind === 'human') return true;
  // typed = 终端里敲的；sdk = 通过 -p/stream-json 发进来的（包括 agentctl 自己发的）
  if (line.promptSource === 'typed' || line.promptSource === 'sdk') return true;
  if (line.turnOrigin === 'human') return true;
  return false;
}

export function turnIndexOf(line: Record<string, unknown>): number | undefined {
  const tp = line.turnPosition as { turnIndex?: unknown } | undefined;
  return tp && typeof tp.turnIndex === 'number' ? tp.turnIndex : undefined;
}

function usageItem(msg: Record<string, unknown>): Item | null {
  const u = msg.usage as Record<string, unknown> | undefined;
  if (!u) return null;
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (!input && !output) return null;
  return {
    kind: 'usage',
    model: typeof msg.model === 'string' ? msg.model : undefined,
    inputTokens: input,
    outputTokens: output,
    cacheRead: num(u.cache_read_input_tokens) || undefined,
    cacheWrite: num(u.cache_creation_input_tokens) || undefined,
  };
}

export interface ParseCtx {
  file: string;
  sessionId: string;
  turn: number;
}

export function parseLine(
  line: Record<string, unknown>,
  offset: number,
  ctx: ParseCtx,
): UnifiedEvent[] {
  const type = typeof line.type === 'string' ? line.type : '';
  if (NOISE.has(type) || type === 'ai-title' || type === 'cost-state') return [];

  const ts = typeof line.timestamp === 'string' ? line.timestamp : new Date(0).toISOString();
  const turn = turnIndexOf(line) ?? ctx.turn;
  const out: UnifiedEvent[] = [];
  // 行 uuid 在磁盘与实时流里一致；同一行拆出的多个事件靠块序号区分
  const base = typeof line.uuid === 'string' ? line.uuid : `@${offset}`;
  const push = (item: Item) => {
    out.push({
      agent: 'claude',
      sessionId: ctx.sessionId,
      turn,
      seq: offset,
      ts,
      item,
      uid: `${base}:${out.length}`,
      raw: { file: ctx.file, offset, type },
    });
  };

  if (type === 'user') {
    const content = (line.message as { content?: unknown } | undefined)?.content;
    const blocks = Array.isArray(content) ? content : [];
    const toolResults = blocks.filter(
      (b): b is Record<string, unknown> =>
        !!b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_result',
    );

    if (toolResults.length > 0) {
      for (const b of toolResults) {
        const { texts, media } = flattenContent(b.content, offset);
        const raw = texts.join('\n\n') || (media.length ? `[${media.length} 个附件]` : '');
        const { text, truncated } = clip(raw);
        push({
          kind: 'tool_result',
          callId: typeof b.tool_use_id === 'string' ? b.tool_use_id : '',
          ok: b.is_error !== true,
          output: text,
          truncated,
        });
      }
      return out;
    }

    const { texts, media } = flattenContent(content, offset);
    const joined = texts.join('\n\n');

    // Claude Code 会把后台任务完成通知、系统提醒当成 user 消息塞进来，
    // 它们不是人说的话，渲染成 notice 才不误导读者。
    if (/^\s*<task-notification>/.test(joined)) {
      const summary = /<summary>([\s\S]*?)<\/summary>/.exec(joined)?.[1];
      push({
        kind: 'notice',
        level: 'info',
        code: 'task-notification',
        text: summary ? oneLine(summary, 200) : '后台任务通知',
      });
      return out;
    }
    // 斜杠命令（终端里敲的 /model 等，或网页里切模型）的回执也是以 user 身份写进来的
    if (/^\s*<(command-name|command-message|local-command-stdout|local-command-stderr)>/.test(joined)) {
      const text = systemText('local_command', joined.replace(/`/g, ''));
      if (text) push({ kind: 'notice', level: 'info', code: 'local_command', text });
      return out;
    }
    // 用户按 Esc / 网页点"打断"后 CLI 写入的占位消息
    if (/^\s*\[Request interrupted by user[^\]]*\]\s*$/.test(joined)) {
      push({ kind: 'notice', level: 'info', code: 'interrupted', text: '已打断' });
      return out;
    }
    // 给模型看的提示（"下面这条是用户跑的本地命令"），对人没有信息量
    if (/^\s*<local-command-caveat>/.test(joined)) return out;
    if (line.isMeta === true) {
      push({ kind: 'notice', level: 'info', code: 'meta', text: oneLine(joined, 200) });
      return out;
    }

    if (texts.length || media.length) {
      push({
        kind: 'text',
        role: 'user',
        text: joined,
        media: media.length ? media : undefined,
      });
    }
    return out;
  }

  if (type === 'assistant') {
    const msg = (line.message ?? {}) as Record<string, unknown>;
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    for (const raw of blocks) {
      if (!raw || typeof raw !== 'object') continue;
      const b = raw as Record<string, unknown>;
      switch (b.type) {
        case 'text': {
          if (typeof b.text === 'string' && b.text.trim()) {
            push({ kind: 'text', role: 'assistant', text: b.text });
          }
          break;
        }
        case 'thinking': {
          if (typeof b.thinking === 'string' && b.thinking.trim()) {
            push({
              kind: 'thinking',
              text: b.thinking,
              durationMs:
                typeof line.thinkingDurationMs === 'number' ? line.thinkingDurationMs : undefined,
            });
          }
          break;
        }
        case 'tool_use': {
          const name = typeof b.name === 'string' ? b.name : 'tool';
          const diff = editDiff(name, b.input);
          if (diff) {
            push(diff);
            break;
          }
          push({
            kind: 'tool_call',
            callId: typeof b.id === 'string' ? b.id : '',
            name,
            input: b.input,
            summary: summarizeToolInput(name, b.input),
          });
          break;
        }
        default:
          break;
      }
    }
    // 同一条 assistant 消息可能被拆成多行（apiBlockIndex 不同），只在首块记一次用量
    const blockIndex = line.apiBlockIndex;
    if (blockIndex === undefined || blockIndex === 0) {
      const usage = usageItem(msg);
      if (usage) push(usage);
    }
    return out;
  }

  if (type === 'system') {
    const subtype = typeof line.subtype === 'string' ? line.subtype : 'system';
    if (subtype === 'turn_duration') {
      const ms = typeof line.durationMs === 'number' ? line.durationMs : undefined;
      push({
        kind: 'notice',
        level: 'info',
        code: subtype,
        text: ms ? `本轮耗时 ${(ms / 1000).toFixed(1)}s` : '本轮结束',
      });
    } else if (subtype === 'compact_boundary') {
      push({ kind: 'notice', level: 'info', code: subtype, text: '上下文已压缩' });
    } else {
      // away_summary / informational / local_command 等都带一段给人看的 content；
      // 没有 content 的（thinking_tokens 之类）是内部计数，不上时间线
      const text = typeof line.content === 'string' ? systemText(subtype, line.content) : '';
      if (text) {
        const level = line.level === 'warning' || line.level === 'error' ? 'warn' : 'info';
        push({ kind: 'notice', level, code: subtype, text });
      }
    }
    return out;
  }

  return out;
}

/** 把 system 行里的标记文本收成一行人话 */
function systemText(subtype: string, content: string): string {
  const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(content)?.[1]?.trim();
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(content)?.[1]?.trim();
    return `执行 ${command}${args ? ` ${args}` : ''}`;
  }
  const stdout = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(content)?.[1];
  const text = oneLine((stdout ?? content).replace(/<[^>]+>/g, ' '), 240);
  if (!text) return '';
  return subtype === 'away_summary' ? `离开期间小结：${text}` : text;
}

/**
 * 改文件的工具直接显示成 diff，比一大段 JSON 入参好读：
 * Edit / MultiEdit 用 old_string → new_string 求行级 diff，Write 显示为整文件新增。
 */
function editDiff(name: string, input: unknown): Item | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  const path = typeof i.file_path === 'string' ? i.file_path : undefined;
  if (!path) return null;

  const pairs: [string, string][] = [];
  if (name === 'Edit' && typeof i.old_string === 'string' && typeof i.new_string === 'string') {
    pairs.push([i.old_string, i.new_string]);
  } else if (name === 'MultiEdit' && Array.isArray(i.edits)) {
    for (const e of i.edits) {
      const r = (e ?? {}) as Record<string, unknown>;
      if (typeof r.old_string === 'string' && typeof r.new_string === 'string') pairs.push([r.old_string, r.new_string]);
    }
  } else if (name === 'Write' && typeof i.content === 'string') {
    pairs.push(['', i.content]);
  } else {
    return null;
  }
  if (pairs.length === 0) return null;

  let added = 0;
  let removed = 0;
  const hunks = pairs.map(([before, after]) => {
    const d = lineDiff(before, after);
    added += d.added;
    removed += d.removed;
    return d.patch;
  });
  return { kind: 'diff', files: [{ path, added, removed, patch: clip(hunks.join('\n@@\n'), 8000).text }] };
}
