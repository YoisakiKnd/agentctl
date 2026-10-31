import { Fragment, useState } from 'react';
import type { ApprovalDecision, Item, QuestionAnswers, UnifiedEvent } from '../types';
import type { Draft } from '../live';
import { clockTime, formatTokens } from '../format';
import Markdown from './Markdown';
import Icon, { type IconName } from './Icon';
import { SentAttachments, splitAttachments } from './Attachments';

function firstLine(text: string, max = 140): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  const s = line.trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 工具名 → 图标：命令、文件、搜索、网页、子代理各一类 */
function toolIcon(name: string): IconName {
  const n = name.toLowerCase();
  if (/bash|exec|shell|command|run|terminal/.test(n)) return 'terminal';
  if (/edit|write|patch|file|read|notebook/.test(n)) return 'file';
  if (/grep|glob|search|find|ls/.test(n)) return 'search';
  if (/web|fetch|url|browser/.test(n)) return 'globe';
  if (/task|agent|todo|plan/.test(n)) return 'spark';
  return 'chevron';
}

/** hideImages：消息里已经有附件清单（图片会显示成缩略图），agent 记下的图片块就不重复列了 */
function MediaChips({ item, hideImages }: { item: Extract<Item, { kind: 'text' }>; hideImages?: boolean }) {
  const media = hideImages ? item.media?.filter((m) => m.kind !== 'image') : item.media;
  if (!media?.length) return null;
  return (
    <div className="chips">
      {media.map((m, i) => (
        <span className="pill" key={i}>
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
      {u.model ? <span className="turn__model mono">{u.model}</span> : null}
      {u.input > 0 ? <span title="新输入 token">↑ {formatTokens(u.input)}</span> : null}
      <span title="输出 token">↓ {formatTokens(u.output)}</span>
      {u.cacheRead > 0 ? <span title="缓存读 token">缓存 {formatTokens(u.cacheRead)}</span> : null}
    </span>
  );
}

export type DecideFn = (
  requestId: string,
  decision: ApprovalDecision,
  answers?: QuestionAnswers,
) => Promise<void>;

interface Question {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
  /** 能不能不选选项、自己写（Claude 的提问总能；Codex 由题目决定，没有选项的题只能自己写） */
  allowOther: boolean;
  /** 密码之类：输入时遮住 */
  secret?: boolean;
}

function questionsOf(input: unknown): Question[] {
  const raw = (input as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q): q is Record<string, unknown> => !!q && typeof q === 'object' && typeof q.question === 'string')
    .map((q) => {
      const options = (Array.isArray(q.options) ? q.options : [])
        .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && typeof o.label === 'string')
        .map((o) => ({ label: o.label as string, description: typeof o.description === 'string' ? o.description : undefined }));
      return {
        question: q.question as string,
        header: typeof q.header === 'string' ? q.header : undefined,
        multiSelect: q.multiSelect === true,
        options,
        allowOther: q.allowOther !== false || !options.length,
        secret: q.secret === true,
      };
    });
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
    const free = q.allowOther ? other[q.question]?.trim() : '';
    if (free) chosen.push(free);
    return chosen;
  };
  const complete = questions.every((q) => answerOf(q).length > 0);

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
        <Icon name="chat" size={15} />
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
          {q.allowOther ? (
            <input
              className="input question__other"
              type={q.secret ? 'password' : 'text'}
              autoComplete={q.secret ? 'off' : undefined}
              placeholder={!q.options.length ? '写下你的回答' : q.multiSelect ? '补充其他答案（可选）' : '或者自己写'}
              value={other[q.question] ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                setOther((cur) => ({ ...cur, [q.question]: v }));
                // 单选题自己写了答案就取消已选项，避免两个答案混在一起
                if (!q.multiSelect && v.trim()) setPicked((cur) => ({ ...cur, [q.question]: [] }));
              }}
            />
          ) : null}
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
        <Icon name="alert" size={15} />
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
    case 'text': {
      if (item.role === 'user') {
        const { text, paths } = splitAttachments(item.text);
        return (
          <div className="bubble">
            {text ? (
              <div className="msg">
                <Markdown text={text} />
              </div>
            ) : null}
            <SentAttachments paths={paths} />
            <MediaChips item={item} hideImages={paths.length > 0} />
          </div>
        );
      }
      return (
        <>
          <div className="msg">
            <Markdown text={item.text} />
          </div>
          <MediaChips item={item} />
        </>
      );
    }

    case 'thinking':
      return (
        <details className="fold fold--think">
          <summary>
            <Icon name="spark" size={14} className="fold__icon" />
            <span className="fold__tag">思考</span>
            {item.durationMs ? <span className="fold__meta num">{(item.durationMs / 1000).toFixed(1)}s</span> : null}
            <span className="fold__preview">{firstLine(item.text, 90)}</span>
          </summary>
          <div className="fold__body">{item.text}</div>
        </details>
      );

    case 'tool_call':
      return (
        <details className="fold fold--tool">
          <summary>
            <Icon name={toolIcon(item.name)} size={14} className="fold__icon" />
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
            <Icon name={item.ok ? 'check' : 'x'} size={13} className="fold__icon" />
            <span className="fold__preview mono">{firstLine(item.output) || '（无输出）'}</span>
            {item.truncated ? <span className="fold__meta">已截断</span> : null}
          </summary>
          <pre className="code">{item.output}</pre>
        </details>
      );

    case 'notice':
      return (
        <div className={`notice notice--${item.level}`}>
          <Icon name={item.level === 'info' ? 'dot' : 'alert'} size={13} />
          <span>{item.text}</span>
        </div>
      );

    case 'diff':
      return (
        <div className="diff">
          {item.files.map((f) => (
            <details className="fold fold--diff" key={f.path}>
              <summary>
                <Icon name="file" size={14} className="fold__icon" />
                <span className="fold__preview mono">{f.path}</span>
                <span className="diff__stat num">
                  <span className="diff__add">+{f.added}</span>
                  <span className="diff__del">−{f.removed}</span>
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
            <Icon name="spark" size={14} />
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
  highlight,
}: {
  events: UnifiedEvent[];
  onDecide?: DecideFn;
  draft?: Draft | null;
  /** 搜索跳转：这一行（偏移）上的事件高亮 */
  highlight?: number;
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
                <span className="turn__n num">第 {ev.turn} 轮</span>
                <span className={`turn__rule${ev.turn === newestTurn ? ' is-newest' : ''}`} />
                {usage.has(ev.turn) ? <UsageLine u={usage.get(ev.turn)!} /> : null}
              </div>
            ) : null}
            <div
              className={`ev ev--${ev.item.kind}${ev.item.kind === 'text' ? ` ev--${ev.item.role}` : ''}${ev.seq === highlight ? ' is-hit' : ''}`}
              data-seq={ev.seq}
            >
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
