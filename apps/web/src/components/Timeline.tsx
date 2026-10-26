import { Fragment, useState } from 'react';
import type { ApprovalDecision, Item, UnifiedEvent } from '../types';
import type { Draft } from '../live';
import { clockTime, formatTokens } from '../format';
import Markdown from './Markdown';

function firstLine(text: string, max = 140): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  const s = line.trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function MediaChips({ item }: { item: Extract<Item, { kind: 'text' }> }) {
  if (!item.media?.length) return null;
  return (
    <div className="chips">
      {item.media.map((m, i) => (
        <span className="chip" key={i}>
          {m.kind === 'image' ? '图片' : '附件'} {Math.max(1, Math.round(m.bytes / 1024))}KB
        </span>
      ))}
    </div>
  );
}

interface TurnUsage {
  model?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 一轮里可能有多条用量事件，聚合成一行挂在轮次分隔线上，避免刷屏 */
function collectUsage(events: UnifiedEvent[]): Map<number, TurnUsage> {
  const out = new Map<number, TurnUsage>();
  for (const ev of events) {
    if (ev.item.kind !== 'usage') continue;
    const u = out.get(ev.turn) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    u.input += ev.item.inputTokens;
    u.output += ev.item.outputTokens;
    u.cacheRead += ev.item.cacheRead ?? 0;
    u.cacheWrite += ev.item.cacheWrite ?? 0;
    if (ev.item.model) u.model = ev.item.model;
    out.set(ev.turn, u);
  }
  return out;
}

function UsageLine({ u }: { u: TurnUsage }) {
  return (
    <span className="turn__usage num">
      {u.model ? <span className="turn__model">{u.model}</span> : null}
      {u.input > 0 ? <span>入 {formatTokens(u.input)}</span> : null}
      <span>出 {formatTokens(u.output)}</span>
      {u.cacheRead > 0 ? <span>缓存 {formatTokens(u.cacheRead)}</span> : null}
    </span>
  );
}

export type DecideFn = (
  requestId: string,
  decision: ApprovalDecision,
  answers?: Record<string, string>,
) => Promise<void>;

interface Question {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

function questionsOf(input: unknown): Question[] {
  const raw = (input as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q): q is Record<string, unknown> => !!q && typeof q === 'object' && typeof q.question === 'string')
    .map((q) => ({
      question: q.question as string,
      header: typeof q.header === 'string' ? q.header : undefined,
      multiSelect: q.multiSelect === true,
      options: (Array.isArray(q.options) ? q.options : [])
        .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && typeof o.label === 'string')
        .map((o) => ({ label: o.label as string, description: typeof o.description === 'string' ? o.description : undefined })),
    }));
}

/** AskUserQuestion：agent 在等你回答问题。每题可选给定选项，也可以自己写 */
function QuestionForm({
  item,
  onDecide,
}: {
  item: Extract<Item, { kind: 'approval' }>;
  onDecide?: DecideFn;
}) {
  const questions = questionsOf(item.input);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = item.state === 'pending';

  const answerOf = (q: Question) => {
    const chosen = [...(picked[q.question] ?? [])];
    const free = other[q.question]?.trim();
    if (free) chosen.push(free);
    return chosen.join(', ');
  };
  const complete = questions.every((q) => answerOf(q));

  const toggle = (q: Question, label: string) =>
    setPicked((cur) => {
      const list = cur[q.question] ?? [];
      if (!q.multiSelect) return { ...cur, [q.question]: [label] };
      return { ...cur, [q.question]: list.includes(label) ? list.filter((l) => l !== label) : [...list, label] };
    });

  const submit = async (decision: ApprovalDecision) => {
    if (!onDecide) return;
    setBusy(true);
    setError('');
    try {
      const answers = decision === 'deny' ? undefined : Object.fromEntries(questions.map((q) => [q.question, answerOf(q)]));
      await onDecide(item.requestId, decision, answers);
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败');
      setBusy(false);
    }
  };

  return (
    <div className={`approval approval--${item.state}`}>
      <div className="approval__head">
        <span className="tool__name">提问</span>
        <span className="approval__state">{pending ? '等你回答' : item.state === 'approved' ? '已回答' : '已跳过'}</span>
      </div>
      {questions.map((q) => (
        <fieldset className="question" key={q.question} disabled={!pending || busy || !onDecide}>
          <legend className="question__title">
            {q.header ? <span className="question__header">{q.header}</span> : null}
            {q.question}
            {q.multiSelect ? <span className="question__hint">可多选</span> : null}
          </legend>
          {q.options.map((o) => {
            const on = (picked[q.question] ?? []).includes(o.label);
            return (
              <label className={`question__opt${on ? ' is-on' : ''}`} key={o.label}>
                <input
                  type={q.multiSelect ? 'checkbox' : 'radio'}
                  name={`${item.requestId}:${q.question}`}
                  checked={on}
                  onChange={() => toggle(q, o.label)}
                />
                <span className="question__label">{o.label}</span>
                {o.description && o.description !== o.label ? (
                  <span className="question__desc">{o.description}</span>
                ) : null}
              </label>
            );
          })}
          <input
            className="input question__other"
            placeholder={q.multiSelect ? '补充其他答案（可选）' : '或者自己写'}
            value={other[q.question] ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              setOther((cur) => ({ ...cur, [q.question]: v }));
              // 单选题自己写了答案就取消已选项，避免两个答案混在一起
              if (!q.multiSelect && v.trim()) setPicked((cur) => ({ ...cur, [q.question]: [] }));
            }}
          />
        </fieldset>
      ))}
      {pending && onDecide ? (
        <div className="approval__actions">
          <button className="btn btn--sm btn--primary" disabled={busy || !complete} onClick={() => void submit('allow')}>
            提交回答
          </button>
          <button className="btn btn--sm" disabled={busy} onClick={() => void submit('deny')}>
            不回答
          </button>
          {error ? <span className="approval__error">{error}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

const APPROVAL_STATE: Record<Extract<Item, { kind: 'approval' }>['state'], string> = {
  pending: '等待审批',
  approved: '已允许',
  denied: '已拒绝',
};

/** 审批卡：把工具要做的事原样摊开（命令 / 路径 / 入参），再给三个选择 */
function Approval({ item, onDecide }: { item: Extract<Item, { kind: 'approval' }>; onDecide?: DecideFn }) {
  if (item.tool === 'AskUserQuestion' && questionsOf(item.input).length) {
    return <QuestionForm item={item} onDecide={onDecide} />;
  }
  return <ToolApproval item={item} onDecide={onDecide} />;
}

function ToolApproval({ item, onDecide }: { item: Extract<Item, { kind: 'approval' }>; onDecide?: DecideFn }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = item.state === 'pending';
  const input = (item.input ?? {}) as Record<string, unknown>;
  const headline =
    typeof input.command === 'string'
      ? input.command
      : typeof input.file_path === 'string'
        ? input.file_path
        : '';

  const decide = async (d: ApprovalDecision) => {
    if (!onDecide) return;
    setBusy(true);
    setError('');
    try {
      await onDecide(item.requestId, d);
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败');
      setBusy(false);
    }
  };

  return (
    <div className={`approval approval--${item.state}`}>
      <div className="approval__head">
        <span className="tool__name">{item.tool}</span>
        <span className="approval__state">{APPROVAL_STATE[item.state]}</span>
      </div>
      {item.detail && item.detail !== headline ? <div className="approval__detail">{item.detail}</div> : null}
      {headline ? <pre className="code approval__cmd">{headline}</pre> : null}
      <details className="fold">
        <summary>
          <span className="fold__preview">完整入参</span>
        </summary>
        <pre className="code">{JSON.stringify(item.input ?? {}, null, 2)}</pre>
      </details>
      {pending && onDecide ? (
        <div className="approval__actions">
          <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => void decide('allow')}>
            允许
          </button>
          <button
            className="btn btn--sm"
            disabled={busy}
            onClick={() => void decide('allow_session')}
            title="本次进程内同类调用不再询问；不会写入任何 settings 文件"
          >
            本会话内都允许
          </button>
          <button className="btn btn--sm btn--danger" disabled={busy} onClick={() => void decide('deny')}>
            拒绝
          </button>
          {error ? <span className="approval__error">{error}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/** 统一 diff 按行着色；只着色，不做语法高亮 */
function DiffBody({ patch }: { patch: string }) {
  return (
    <pre className="code diff__body">
      {patch.split('\n').map((line, i) => {
        const cls = line.startsWith('@@')
          ? 'diff__hunk'
          : line.startsWith('+')
            ? 'diff__add'
            : line.startsWith('-')
              ? 'diff__del'
              : undefined;
        return (
          <span key={i} className={cls}>
            {line}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}

function renderItem(item: Item, onDecide?: DecideFn) {
  switch (item.kind) {
    case 'text':
      return (
        <>
          <div className={item.role === 'user' ? 'msg msg--user' : 'msg'}>
            <Markdown text={item.text} />
          </div>
          <MediaChips item={item} />
        </>
      );

    case 'thinking':
      return (
        <details className="fold fold--think">
          <summary>
            <span className="fold__tag">思考</span>
            {item.durationMs ? <span className="fold__meta num">{item.durationMs}ms</span> : null}
            <span className="fold__preview">{firstLine(item.text, 90)}</span>
          </summary>
          <div className="fold__body">{item.text}</div>
        </details>
      );

    case 'tool_call':
      return (
        <details className="fold fold--tool">
          <summary>
            <span className="tool__name">{item.name}</span>
            <span className="fold__preview mono">{item.summary ?? ''}</span>
          </summary>
          <pre className="code">{JSON.stringify(item.input, null, 2)}</pre>
        </details>
      );

    case 'tool_result':
      return (
        <details className={`fold fold--result${item.ok ? '' : ' is-error'}`}>
          <summary>
            <span className="result__mark">{item.ok ? '✓' : '✗'}</span>
            <span className="fold__preview mono">{firstLine(item.output) || '（无输出）'}</span>
            {item.truncated ? <span className="fold__meta">已截断</span> : null}
          </summary>
          <pre className="code">{item.output}</pre>
        </details>
      );

    case 'notice':
      return <div className={`notice notice--${item.level}`}>{item.text}</div>;

    case 'diff':
      return (
        <div className="diff">
          {item.files.map((f) => (
            <details className="fold diff__file" key={f.path}>
              <summary>
                <span className="tool__name">改动</span>
                <span className="fold__preview mono">{f.path}</span>
                <span className="diff__stat num">
                  <span className="diff__add">+{f.added}</span> <span className="diff__del">−{f.removed}</span>
                </span>
              </summary>
              {f.patch ? <DiffBody patch={f.patch} /> : null}
            </details>
          ))}
        </div>
      );

    case 'approval':
      return <Approval item={item} onDecide={onDecide} />;

    // usage 已聚合到轮次分隔线
    case 'usage':
      return null;

    default:
      return null;
  }
}

function DraftRow({ draft }: { draft: Draft }) {
  return (
    <div className="ev ev--draft">
      <div className="ev__gutter num" />
      <div className="ev__body">
        {draft.block === 'thinking' ? (
          <div className="draft draft--think">
            <span className="fold__tag">思考中</span> {firstLine(draft.text.slice(-400), 120)}
          </div>
        ) : (
          <div className="msg draft">
            <Markdown text={draft.text} />
          </div>
        )}
      </div>
    </div>
  );
}

export default function Timeline({
  events,
  onDecide,
  draft,
}: {
  events: UnifiedEvent[];
  onDecide?: DecideFn;
  draft?: Draft | null;
}) {
  const usage = collectUsage(events);
  const newestTurn = events.length > 0 ? events[events.length - 1].turn : -1;
  let lastTurn = -1;
  let lastClock = '';

  return (
    <div className="timeline__rows">
      {events.map((ev) => {
        if (ev.item.kind === 'usage') return null;

        const showTurn = ev.turn > 0 && ev.turn !== lastTurn;
        if (ev.turn > 0) lastTurn = ev.turn;

        // 同一分钟的事件不重复打时间戳，避免整列重复
        const clock = clockTime(ev.ts);
        const showClock = clock !== lastClock;
        if (showClock) lastClock = clock;

        return (
          <Fragment key={ev.uid ?? ev.seq}>
            {showTurn ? (
              <div className="turn">
                <span className="turn__n num">{ev.turn}</span>
                <span className={`turn__rule${ev.turn === newestTurn ? ' is-newest' : ''}`} />
                {usage.has(ev.turn) ? <UsageLine u={usage.get(ev.turn)!} /> : null}
              </div>
            ) : null}
            <div className={`ev ev--${ev.item.kind}`}>
              <div className="ev__gutter num">{showClock ? clock : ''}</div>
              <div className="ev__body">{renderItem(ev.item, onDecide)}</div>
            </div>
          </Fragment>
        );
      })}
      {draft && draft.text.trim() ? <DraftRow draft={draft} /> : null}
    </div>
  );
}
