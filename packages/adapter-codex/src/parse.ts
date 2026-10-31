/**
 * Codex rollout 行格式 → UnifiedEvent。
 *
 * Codex 有两代格式，靠"行上有没有 ordinal"逐行区分：
 *
 * - 新版（0.16x 起，每行带 ordinal）：除了喂给模型的 response_item，还会写一份高层的
 *   event_msg/item_completed —— CommandExecution 是真实执行的命令，FileChange 带统一 diff，
 *   比 response_item 里的 JS 编排代码好读得多。所以新版只取 item_completed，跳过 response_item。
 * - 旧版（0.13x 及以前）：只有 response_item + event_msg，按它们拼时间线；
 *   event_msg/agent_message、agent_reasoning 与 response_item 重复，跳过。
 */
import { clip, flattenContent, oneLine, summarizeToolInput, type FilePatch, type Item, type MediaRef, type UnifiedEvent } from '@agentctl/core';

export interface ParseCtx {
  file: string;
  sessionId: string;
  turn: number;
  model?: string;
}

type Rec = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** 统一 diff → 增删行数 */
function countDiff(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

/** apply_patch 格式（*** Begin Patch / *** Update File: x）→ 每个文件的增删行 */
export function parseApplyPatch(patch: string): FilePatch[] {
  const files: FilePatch[] = [];
  let cur: FilePatch | null = null;
  const lines: string[] = [];
  const flush = () => {
    if (cur) {
      cur.patch = clip(lines.join('\n'), 8000).text;
      files.push(cur);
    }
    lines.length = 0;
  };
  for (const line of patch.split('\n')) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) {
      flush();
      cur = { path: m[2].trim(), added: 0, removed: 0 };
      continue;
    }
    if (!cur || line.startsWith('*** ')) continue;
    lines.push(line);
    if (line.startsWith('+')) cur.added += 1;
    else if (line.startsWith('-')) cur.removed += 1;
  }
  flush();
  return files;
}

/** ["/bin/bash","-lc","真正的命令"] → "真正的命令" */
function commandText(command: unknown): string {
  if (typeof command === 'string') {
    // app-server 给的是拼好的字符串：/bin/bash -lc 'echo hi'
    const m = /^\S*\b(?:ba|z)?sh\s+-l?c\s+'([\s\S]*)'$/.exec(command);
    return m ? m[1].replace(/'\\''/g, "'") : command;
  }
  if (!Array.isArray(command)) return '';
  const parts = command.filter((c): c is string => typeof c === 'string');
  const i = parts.findIndex((p) => p === '-lc' || p === '-c');
  return i >= 0 && parts[i + 1] ? parts[i + 1] : parts.join(' ');
}

/** 新版 UserMessage / AgentMessage 的 content：[{type:"text"|"Text", text}] + 图片 */
function contentText(content: unknown): { text: string; media: MediaRef[] } {
  const texts: string[] = [];
  const media: MediaRef[] = [];
  if (Array.isArray(content)) {
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      const b = c as Rec;
      const t = str(b.type)?.toLowerCase();
      if ((t === 'text' || t === 'input_text' || t === 'output_text') && typeof b.text === 'string') {
        if (b.text.trim()) texts.push(b.text);
      } else if (t && t.includes('image')) {
        const url = str(b.image_url) ?? str(b.url) ?? '';
        media.push({ kind: 'image', bytes: Math.floor((url.length * 3) / 4) });
      }
    }
  } else if (typeof content === 'string' && content.trim()) {
    texts.push(content);
  }
  return { text: texts.join('\n\n'), media };
}

function usageOf(u: unknown, model?: string): Item | null {
  if (!u || typeof u !== 'object') return null;
  const r = u as Rec;
  const input = num(r.input_tokens);
  const output = num(r.output_tokens);
  if (!input && !output) return null;
  const cached = num(r.cached_input_tokens);
  // Codex 的 input_tokens 含缓存命中部分；统一成"新输入 + 缓存读"两栏，和 Claude 的口径一致
  return {
    kind: 'usage',
    model,
    inputTokens: Math.max(0, input - cached),
    outputTokens: output,
    cacheRead: cached || undefined,
    cacheWrite: num(r.cache_write_input_tokens) || undefined,
  };
}

export function parseLine(line: Rec, offset: number, ctx: ParseCtx): UnifiedEvent[] {
  const type = str(line.type) ?? '';
  const payload = (line.payload ?? {}) as Rec;
  const sub = str(payload.type) ?? '';
  const ts = str(line.timestamp) ?? new Date(0).toISOString();
  const modern = typeof line.ordinal === 'number';

  if (type === 'turn_context') {
    ctx.model = str(payload.model) ?? ctx.model;
    return [];
  }

  const out: UnifiedEvent[] = [];
  const push = (item: Item, stableId?: string) => {
    out.push({
      agent: 'codex',
      sessionId: ctx.sessionId,
      turn: ctx.turn,
      seq: offset,
      ts,
      item,
      uid: `${stableId ?? `@${offset}`}:${out.length}`,
      raw: { file: ctx.file, offset, type: sub ? `${type}/${sub}` : type },
    });
  };

  // ── 两代共有 ──────────────────────────────────────────────
  if (type === 'event_msg') {
    switch (sub) {
      case 'task_complete': {
        const ms = num(payload.duration_ms);
        if (ms) push({ kind: 'notice', level: 'info', code: 'turn_duration', text: `本轮耗时 ${(ms / 1000).toFixed(1)}s` });
        return out;
      }
      case 'turn_aborted':
        push({ kind: 'notice', level: 'info', code: 'interrupted', text: payload.reason === 'interrupted' ? '已打断' : `本轮中止：${String(payload.reason ?? '')}` });
        return out;
      case 'error':
        push({ kind: 'notice', level: 'error', code: 'error', text: oneLine(str(payload.message) ?? '出错了', 300) });
        return out;
      default:
        break;
    }
  }
  if (type === 'compacted') {
    push({ kind: 'notice', level: 'info', code: 'compact_boundary', text: '上下文已压缩' });
    return out;
  }

  // ── 新版：只认 item_completed 与 token_usage_record ─────────
  if (modern) {
    if (type === 'token_usage_record') {
      const u = usageOf(payload.usage, ctx.model);
      if (u) push(u, str(payload.response_id));
      return out;
    }
    if (type !== 'event_msg' || sub !== 'item_completed') return out;
    const item = (payload.item ?? {}) as Rec;
    const id = str(item.id);
    switch (item.type) {
      case 'UserMessage': {
        const { text, media } = contentText(item.content);
        if (text || media.length) push({ kind: 'text', role: 'user', text, media: media.length ? media : undefined }, id);
        break;
      }
      case 'AgentMessage': {
        const { text } = contentText(item.content);
        if (text) push({ kind: 'text', role: 'assistant', text }, id);
        break;
      }
      case 'Plan': {
        // Plan 协作模式的最终方案（模型输出里的 <proposed_plan>）；它不会再另有一条 AgentMessage
        const text = str(item.text)?.trim();
        if (text) push({ kind: 'text', role: 'assistant', text: `**方案**\n\n${text}` }, id);
        break;
      }
      case 'Reasoning': {
        const parts = Array.isArray(item.summary_text) ? item.summary_text.filter((t): t is string => typeof t === 'string') : [];
        const text = parts.join('\n\n').trim();
        if (text) push({ kind: 'thinking', text }, id);
        break;
      }
      case 'CommandExecution': {
        const cmd = commandText(item.command);
        const callId = id ?? `@${offset}`;
        push({ kind: 'tool_call', callId, name: 'exec', input: { command: cmd, cwd: str(item.cwd)?.replace(/^file:\/\//, '') }, summary: oneLine(cmd, 160) }, id);
        const exit = typeof item.exit_code === 'number' ? item.exit_code : undefined;
        const raw = str(item.aggregated_output) ?? '';
        const { text, truncated } = clip(raw || (exit !== undefined ? `（退出码 ${exit}，无输出）` : '（无输出）'));
        push({ kind: 'tool_result', callId, ok: item.status !== 'failed' && (exit === undefined || exit === 0), output: text, truncated }, id);
        break;
      }
      case 'FileChange': {
        const changes = (item.changes ?? {}) as Record<string, Rec>;
        const files: FilePatch[] = Object.entries(changes).map(([path, ch]) => {
          const diff = str(ch.unified_diff) ?? '';
          return { path: str(ch.move_path) ?? path, ...countDiff(diff), patch: clip(diff, 8000).text };
        });
        if (files.length) push({ kind: 'diff', files }, id);
        break;
      }
      case 'Extension': {
        const kind = str(item.kind) ?? 'extension';
        const query = str(item.query) ?? '';
        push({ kind: 'tool_call', callId: id ?? `@${offset}`, name: kind === 'web.search' ? 'web_search' : kind, input: { query }, summary: oneLine(query, 160) }, id);
        break;
      }
      case 'ContextCompaction':
        push({ kind: 'notice', level: 'info', code: 'compact_boundary', text: '上下文已压缩' }, id);
        break;
      default:
        break;
    }
    return out;
  }

  // ── 旧版：response_item + event_msg ─────────────────────────
  if (type === 'event_msg') {
    if (sub === 'user_message') {
      const text = str(payload.message) ?? '';
      const images = [...(Array.isArray(payload.images) ? payload.images : []), ...(Array.isArray(payload.local_images) ? payload.local_images : [])];
      const media: MediaRef[] = images.map(() => ({ kind: 'image', bytes: 0 }));
      if (text.trim() || media.length) push({ kind: 'text', role: 'user', text, media: media.length ? media : undefined });
    } else if (sub === 'token_count') {
      const info = payload.info as Rec | null | undefined;
      const u = usageOf(info?.last_token_usage, ctx.model);
      // 同一次响应会连写多条相同的 token_count，只认累计总量变了的那条
      if (u && info && totalChanged(ctx, info.total_token_usage)) push(u);
    }
    return out;
  }

  if (type !== 'response_item') return out;
  switch (sub) {
    case 'message': {
      // user / developer 角色是注入的环境与权限说明；真正的人类输入走 event_msg/user_message
      if (payload.role !== 'assistant') break;
      const { texts } = flattenContent(
        (Array.isArray(payload.content) ? payload.content : []).map((c) =>
          c && typeof c === 'object' ? { ...(c as Rec), type: 'text' } : c,
        ),
      );
      const text = texts.join('\n\n');
      if (text) push({ kind: 'text', role: 'assistant', text });
      break;
    }
    case 'reasoning': {
      const summary = Array.isArray(payload.summary) ? payload.summary : [];
      const text = summary
        .map((s) => (s && typeof s === 'object' ? str((s as Rec).text) : undefined))
        .filter(Boolean)
        .join('\n\n')
        .trim();
      if (text) push({ kind: 'thinking', text });
      break;
    }
    case 'function_call': {
      const name = str(payload.name) ?? 'tool';
      let input: unknown = payload.arguments;
      try {
        input = JSON.parse(String(payload.arguments ?? '{}'));
      } catch {
        /* 参数不是 JSON，原样展示 */
      }
      push({ kind: 'tool_call', callId: str(payload.call_id) ?? '', name, input, summary: summarizeToolInput(name, input) }, str(payload.call_id));
      break;
    }
    case 'custom_tool_call': {
      const name = str(payload.name) ?? 'tool';
      const input = str(payload.input) ?? '';
      if (name === 'apply_patch') {
        const files = parseApplyPatch(input);
        if (files.length) {
          push({ kind: 'diff', files }, str(payload.call_id));
          break;
        }
      }
      push({ kind: 'tool_call', callId: str(payload.call_id) ?? '', name, input, summary: oneLine(input, 160) }, str(payload.call_id));
      break;
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      let output = str(payload.output) ?? '';
      let ok = !/exited with code [1-9]/.test(output);
      // custom 工具的输出是 {"output": "...", "metadata": {"exit_code": n}}
      if (sub === 'custom_tool_call_output') {
        try {
          const o = JSON.parse(output) as { output?: unknown; metadata?: { exit_code?: unknown } };
          if (typeof o.output === 'string') output = o.output;
          if (typeof o.metadata?.exit_code === 'number') ok = o.metadata.exit_code === 0;
        } catch {
          /* 不是 JSON，原样展示 */
        }
      }
      const { text, truncated } = clip(output || '（无输出）');
      push({ kind: 'tool_result', callId: str(payload.call_id) ?? '', ok, output: text, truncated }, str(payload.call_id) ? `${str(payload.call_id)}:out` : undefined);
      break;
    }
    case 'web_search_call': {
      const action = (payload.action ?? {}) as Rec;
      const queries = Array.isArray(action.queries) ? action.queries.filter((q): q is string => typeof q === 'string') : [];
      const query = str(action.query) ?? queries.join(' · ');
      push({ kind: 'tool_call', callId: `@${offset}`, name: 'web_search', input: action, summary: oneLine(query, 160) });
      break;
    }
    default:
      break;
  }
  return out;
}

/** 旧版 token_count 会对同一次响应连写两三条；total 没变的那几条是重复的 */
const lastTotals = new WeakMap<ParseCtx, number>();
function totalChanged(ctx: ParseCtx, total: unknown): boolean {
  const t = num((total as Rec | undefined)?.total_tokens);
  if (!t || lastTotals.get(ctx) === t) return false;
  lastTotals.set(ctx, t);
  return true;
}

/** 首条人类提问（列表预览用），两代格式都认 */
export function humanPrompt(line: Rec): string | undefined {
  const payload = (line.payload ?? {}) as Rec;
  if (line.type !== 'event_msg') return undefined;
  if (payload.type === 'user_message') return str(payload.message)?.trim() || undefined;
  if (payload.type === 'item_completed') {
    const item = (payload.item ?? {}) as Rec;
    if (item.type === 'UserMessage') return contentText(item.content).text.trim() || undefined;
  }
  return undefined;
}

export function isTurnStart(line: Rec): boolean {
  return line.type === 'event_msg' && (line.payload as Rec | undefined)?.type === 'task_started';
}

/**
 * app-server 推送的 ThreadItem（驼峰字段）→ rollout 文件里 item_completed 的形状。
 * 两边 id 相同，归一后走同一个 parseLine，实时事件和磁盘回放的 uid 就天然一致。
 */
export function normalizeLiveItem(item: Rec): Rec | null {
  const id = str(item.id);
  switch (item.type) {
    case 'userMessage':
      return { type: 'UserMessage', id, content: item.content };
    case 'agentMessage':
      return { type: 'AgentMessage', id, content: [{ type: 'Text', text: str(item.text) ?? '' }], phase: item.phase };
    case 'reasoning':
      return { type: 'Reasoning', id, summary_text: Array.isArray(item.summary) ? item.summary : [] };
    case 'plan':
      return { type: 'Plan', id, text: item.text };
    case 'commandExecution':
      return {
        type: 'CommandExecution',
        id,
        command: item.command,
        cwd: item.cwd,
        status: item.status,
        exit_code: item.exitCode,
        aggregated_output: item.aggregatedOutput,
      };
    case 'fileChange': {
      const changes: Record<string, Rec> = {};
      for (const c of Array.isArray(item.changes) ? item.changes : []) {
        if (!c || typeof c !== 'object') continue;
        const ch = c as Rec;
        const kind = (ch.kind ?? {}) as Rec;
        if (typeof ch.path === 'string') changes[ch.path] = { type: kind.type, unified_diff: ch.diff, move_path: kind.move_path ?? null };
      }
      return { type: 'FileChange', id, changes, status: item.status };
    }
    case 'webSearch':
      return { type: 'Extension', kind: 'web.search', id, query: item.query };
    case 'contextCompaction':
      return { type: 'ContextCompaction', id };
    default:
      return null;
  }
}
