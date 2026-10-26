/**
 * DeepSeek Harness（session.v4.jsonl）记录 → UnifiedEvent。
 *
 * 每条记录 { type, seq, time(ms), data }；和轮次相关的记录都带 data.turn（绝对轮号），
 * seq 在会话内单调递增，直接拿来当 uid。
 *
 * user/message 里大部分是注入给模型的上下文（记忆、任务提醒、运行时快照、技能目录……），
 * 只有 source.kind === 'user' 才是人说的话；少数几类（后台任务完成、子代理消息、目标完成）
 * 对读者有信息量，渲染成提示。
 */
import { clip, oneLine, summarizeToolInput, type Item, type MediaRef, type UnifiedEvent } from '@agentctl/core';

type Rec = Record<string, unknown>;

export interface ParseCtx {
  file: string;
  sessionId: string;
  turn: number;
  model?: string;
  /** 本窗口里见过的 turn/start 时间，用来算本轮耗时 */
  turnStartedAt: Map<number, number>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

function contentOf(content: unknown): { text: string; media: MediaRef[]; reasoning: string } {
  const texts: string[] = [];
  const reasoning: string[] = [];
  const media: MediaRef[] = [];
  for (const c of Array.isArray(content) ? content : []) {
    if (!c || typeof c !== 'object') continue;
    const b = c as Rec;
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) texts.push(b.text);
    else if (b.type === 'reasoning' && typeof b.text === 'string' && b.text.trim()) reasoning.push(b.text);
    else if (b.type === 'image') {
      const data = str(b.data) ?? str((b.source as Rec | undefined)?.data) ?? '';
      media.push({ kind: 'image', mime: str(b.mimeType) ?? str(b.mediaType), bytes: Math.floor((data.length * 3) / 4) });
    }
  }
  return { text: texts.join('\n\n'), media, reasoning: reasoning.join('\n\n') };
}

/** 这几类注入消息对读者有用：后台任务结果、子代理来信、子代理结束、目标完成、计划模式 */
const NOTICE_SOURCES: Record<string, string> = {
  'tool-jobs': '后台任务',
  'agent-message': '子代理消息',
  'subagent-settled': '子代理结束',
  'tool-goal': '目标完成',
  'plan-mode': '计划模式',
};

export function sourceKind(data: Rec): string | undefined {
  const s = data.source;
  if (typeof s === 'string') return s;
  return s && typeof s === 'object' ? str((s as Rec).kind) : undefined;
}

export function parseLine(line: Rec, offset: number, ctx: ParseCtx): UnifiedEvent[] {
  const type = str(line.type) ?? '';
  const data = (line.data ?? {}) as Rec;
  const seq = num(line.seq);
  const time = num(line.time);
  const ts = time ? new Date(time).toISOString() : new Date(0).toISOString();
  if (typeof data.turn === 'number') ctx.turn = data.turn;

  const out: UnifiedEvent[] = [];
  const push = (item: Item) => {
    out.push({
      agent: 'dsh',
      sessionId: ctx.sessionId,
      turn: ctx.turn,
      seq: offset,
      ts,
      item,
      uid: `${seq ?? `@${offset}`}:${out.length}`,
      raw: { file: ctx.file, offset, type },
    });
  };
  const notice = (text: string, code = type, level: 'info' | 'warn' | 'error' = 'info') => {
    if (text.trim()) push({ kind: 'notice', level, code, text });
  };

  switch (type) {
    case 'turn/start':
      if (time) ctx.turnStartedAt.set(ctx.turn, time);
      return out;

    case 'turn/end': {
      const reason = str((data.reason as Rec | undefined)?.kind);
      const started = ctx.turnStartedAt.get(ctx.turn);
      if (reason === 'interrupted' || reason === 'cancelled' || reason === 'aborted') notice('已打断', 'interrupted');
      else if (reason && reason !== 'completed') notice(`本轮结束：${reason}`, 'turn_end', 'warn');
      else if (started && time) notice(`本轮耗时 ${((time - started) / 1000).toFixed(1)}s`, 'turn_duration');
      return out;
    }

    case 'user/message': {
      const kind = sourceKind(data);
      const { text, media } = contentOf(data.content);
      if (kind === 'user') {
        if (text || media.length) push({ kind: 'text', role: 'user', text, media: media.length ? media : undefined });
      } else if (kind && NOTICE_SOURCES[kind]) {
        notice(`${NOTICE_SOURCES[kind]}：${oneLine(text, 240)}`, kind);
      }
      return out;
    }

    case 'assistant/message': {
      const msg = (data.message ?? {}) as Rec;
      const { text, reasoning } = contentOf(msg.content);
      if (reasoning) push({ kind: 'thinking', text: reasoning });
      if (text) push({ kind: 'text', role: 'assistant', text });
      const u = data.usage as Rec | undefined;
      const input = num(u?.inputTokens) ?? 0;
      const output = num(u?.outputTokens) ?? 0;
      if (input || output) {
        const cacheRead = num(u?.cacheReadTokens) ?? num(u?.cachedInputTokens);
        push({ kind: 'usage', model: ctx.model, inputTokens: Math.max(0, input - (cacheRead ?? 0)), outputTokens: output, cacheRead });
      }
      return out;
    }

    case 'tool/call': {
      const name = str(data.name) ?? 'tool';
      let input: unknown = data.arguments;
      try {
        input = JSON.parse(String(data.arguments ?? '{}'));
      } catch {
        /* 参数不是 JSON，原样展示 */
      }
      push({ kind: 'tool_call', callId: str(data.callId) ?? '', name, input, summary: summarizeToolInput(name, input) });
      return out;
    }

    case 'tool/result': {
      const msg = (data.message ?? {}) as Rec;
      const { text, media } = contentOf(msg.content);
      const body = text || (media.length ? `[${media.length} 张图片]` : '');
      const err = str((data.error as Rec | undefined)?.message) ?? (typeof data.error === 'string' ? data.error : undefined);
      const { text: output, truncated } = clip(body || err || '（无输出）');
      push({ kind: 'tool_result', callId: str(msg.toolCallId) ?? '', ok: msg.isError !== true && !data.error, output, truncated });
      return out;
    }

    case 'compaction/start':
      notice('上下文已压缩', 'compact_boundary');
      return out;

    case 'model/selection':
    case 'request/context': {
      const model = str(data.model);
      if (type === 'model/selection' && model && model !== ctx.model) {
        notice(`切换模型：${[str(data.provider), model].filter(Boolean).join(' / ')}`, 'model');
      }
      if (model) ctx.model = model;
      return out;
    }

    case 'todo/write': {
      const todos = (Array.isArray(data.todos) ? data.todos : []) as Rec[];
      const done = todos.filter((t) => t.status === 'completed').length;
      const doing = todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status === 'pending');
      notice(`待办 ${done}/${todos.length}${doing ? ` · 当前：${oneLine(str(doing.content) ?? '', 120)}` : ''}`, 'todo');
      return out;
    }

    case 'deliverables/presented': {
      const files = (Array.isArray(data.files) ? data.files : []) as Rec[];
      notice(`交付：${files.map((f) => str(f.path)).filter(Boolean).join('、')}`, 'deliverables');
      return out;
    }

    case 'command/run':
      notice(`执行 /${str(data.name) ?? ''}${str(data.args)?.trim() ? ` ${oneLine(str(data.args) ?? '', 120)}` : ''}`, 'local_command');
      return out;

    case 'plan/mode':
      notice(data.active ? '进入计划模式' : '退出计划模式', 'plan_mode');
      return out;

    case 'subagent/catalog':
      notice(`启动子代理：${str(data.label) ?? str(data.childId) ?? ''}`, 'subagent');
      return out;

    case 'goal/change': {
      const goal = (data.goal ?? {}) as Rec;
      if (data.operation === 'create') notice(`设定目标：${oneLine(str(goal.objective) ?? '', 200)}`, 'goal');
      return out;
    }

    default:
      return out;
  }
}
