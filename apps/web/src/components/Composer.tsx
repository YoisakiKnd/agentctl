import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { RunOptions } from '../api';
import { homeShorten } from '../format';
import { useAllowBypass } from '../caps';
import { EFFORT_LABEL, isAlias, modelLabel, useModels } from '../models';
import Icon from './Icon';
import { AttachButton, AttachmentTray, onPasteFiles, useAttachments, useDropZone } from './Attachments';
import type { AgentId, ModelInfo, PermissionMode, QueuedMessage, RunState, SendMode } from '../types';

interface ModeOption {
  value: PermissionMode;
  label: string;
  hint: string;
}

const MODES: ModeOption[] = [
  { value: 'default', label: '逐个审批', hint: '每次需要权限的工具调用都在网页里确认' },
  { value: 'acceptEdits', label: '自动接受编辑', hint: '文件编辑直接放行，命令仍需确认' },
  { value: 'auto', label: 'Auto 模式', hint: '由分类器自动放行安全操作，有风险的仍会弹审批' },
  { value: 'plan', label: '只做规划', hint: '只读分析并给出方案，不改文件、不跑命令' },
  { value: 'bypassPermissions', label: '跳过所有权限', hint: '不再询问任何操作，agent 可以直接执行任意命令' },
];

/**
 * DSH 的三档权限预设。沙箱在会话创建时定下（新会话按这里选的建）；
 * 已有会话运行中切换，改的是网页怎么回答它的权限请求。
 */
const DSH_MODES: ModeOption[] = [
  {
    value: 'plan',
    label: '仅可查看',
    hint: '只读沙箱（新会话）；已有会话里，所有权限请求都自动拒绝',
  },
  {
    value: 'default',
    label: '工作区内修改',
    hint: '工作区内可以改文件，越界的操作逐个审批（DSH 默认）',
  },
  {
    value: 'bypassPermissions',
    label: '完全权限',
    hint: '不加沙箱、不询问（新会话）；已有会话里，所有权限请求都自动同意',
  },
];

/** 和 Codex 自己的 /permissions 一一对应（Codex 没有「只自动接受编辑」这一档） */
const CODEX_MODES: ModeOption[] = [
  { value: 'default', label: '默认', hint: 'Codex 的 Default：工作区内读写、跑命令；访问工作区外或联网时由你审批' },
  { value: 'auto', label: 'Auto-review', hint: '同默认，但审批交给 Codex 的审核子代理按风险判断，不来问你' },
  { value: 'plan', label: '只读规划', hint: 'Codex 的 Plan 模式 + Read Only：先调研、有疑问会弹选项问你，最后给出方案；改文件、联网时由你审批' },
  { value: 'bypassPermissions', label: '完全访问', hint: 'Codex 的 Full Access：不加沙箱、不审批，可以改工作区外的文件、联网' },
]

export function modesFor(agent: AgentId): ModeOption[] {
  if (agent === 'dsh') return DSH_MODES;
  return agent === 'codex' ? CODEX_MODES : MODES;
}

const BYPASS_WARNING =
  '跳过所有权限后，agent 执行任何命令、改任何文件都不再询问。\n只在你信任当前任务和工作目录时使用。确定开启？';

/** 权限模式下拉。选 bypass 要二次确认；服务端禁用 bypass 时不提供该项 */
export function PermissionSelect({
  agent,
  value,
  onChange,
  disabled,
}: {
  agent: AgentId;
  value: PermissionMode;
  onChange: (v: PermissionMode) => void;
  disabled?: boolean;
}) {
  const allowBypass = useAllowBypass();
  const modes = modesFor(agent);
  if (modes.length === 0) return null;
  const mode = modes.find((m) => m.value === value) ?? modes[0];
  return (
    <select
      className={`select${value === 'bypassPermissions' ? ' select--danger' : ''}`}
      value={mode.value}
      title={mode.hint}
      disabled={disabled}
      onChange={(e) => {
        const next = e.target.value as PermissionMode;
        if (next === 'bypassPermissions' && !confirm(BYPASS_WARNING)) {
          e.target.value = mode.value;
          return;
        }
        onChange(next);
      }}
      aria-label="权限模式"
    >
      {modes.filter((m) => m.value !== 'bypassPermissions' || allowBypass || value === m.value).map((m) => (
        <option key={m.value} value={m.value}>
          {m.label}
        </option>
      ))}
    </select>
  );
}

/** 触屏设备上回车留给换行，发送走按钮；桌面上回车发送、Shift+回车换行 */
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export function ModelSelect({
  agent,
  value,
  onChange,
  disabled,
  options,
}: {
  agent: AgentId;
  /** 运行中的进程自己报的模型列表，优先于静态列表 */
  options?: ModelInfo[] | null;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const fetched = useModels(agent);
  const models = options?.length ? options : fetched;
  const option = (m: ModelInfo) => (
    <option key={m.value} value={m.value} title={[m.description, m.resolvedModel].filter(Boolean).join(' · ')}>
      {modelLabel(m, models)}
    </option>
  );
  // 运行中的模型可能不在列表里（比如终端里用完整 id 启动的），也要能显示出来
  const known = models.some((m) => m.value === value);
  return (
    <select
      className="select"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      aria-label="模型"
      title={models.find((m) => m.value === value)?.description}
    >
      {!known ? <option value={value}>{value}</option> : null}
      <optgroup label="常用">{models.filter(isAlias).map(option)}</optgroup>
      {models.some((m) => !isAlias(m)) ? (
        <optgroup label="指定版本">{models.filter((m) => !isAlias(m)).map(option)}</optgroup>
      ) : null}
    </select>
  );
}

/** 某个模型支持的强度；模型没报（或是「默认」）时取列表里第一个有强度的 */
function effortLevelsOf(models: ModelInfo[], model?: string): string[] {
  return models.find((m) => m.value === (model ?? 'default'))?.effortLevels ?? models.find((m) => m.effortLevels?.length)?.effortLevels ?? [];
}

export function EffortSelect({
  levels,
  value,
  onChange,
  disabled,
  hint,
}: {
  levels: string[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  hint?: string;
}) {
  // 进程报的当前值可能不在列表里（例如换模型后），也要显示出来
  const all = value && !levels.includes(value) ? [...levels, value] : levels;
  return (
    <select className="select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label="推理强度" title={hint ?? '推理强度'}>
      <option value="">强度·默认</option>
      {all.map((e) => (
        <option key={e} value={e}>
          强度·{EFFORT_LABEL[e] ?? e}
        </option>
      ))}
    </select>
  );
}

/** 启动进程时才生效的选项：模型、推理强度、权限模式 */
export function RunOptionFields({
  agent,
  value,
  onChange,
}: {
  agent: AgentId;
  value: RunOptions;
  onChange: (v: RunOptions) => void;
}) {
  const models = useModels(agent);
  const model = models.find((m) => m.value === (value.model ?? 'default'));
  const efforts = model?.effortLevels ?? [];
  return (
    <>
      <ModelSelect
        agent={agent}
        value={value.model ?? 'default'}
        onChange={(v) => {
          const next = models.find((m) => m.value === v);
          // 换到不支持当前强度的模型时，强度回到默认
          const effort = value.effort && next?.effortLevels?.includes(value.effort) ? value.effort : undefined;
          onChange({ ...value, model: v === 'default' ? undefined : v, effort });
        }}
      />
      {efforts.length || value.effort ? (
        <EffortSelect levels={efforts} value={value.effort ?? ''} onChange={(e) => onChange({ ...value, effort: e || undefined })} />
      ) : null}
      <PermissionSelect
        agent={agent}
        value={value.permissionMode ?? 'default'}
        onChange={(v) => onChange({ ...value, permissionMode: v })}
      />
    </>
  );
}

/** 三项都显式带上：'default' / 空串表示"就用默认"，免得服务端拿上次的选项补 */
export function explicit(o: RunOptions): RunOptions {
  return { model: o.model ?? 'default', effort: o.effort ?? '', permissionMode: o.permissionMode ?? 'default' };
}

/** 提交时按 Enter（排除输入法组字中的 Enter，否则中文用户选词就会把消息发出去） */
export function isSubmitKey(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return false;
  if (e.metaKey || e.ctrlKey) return true;
  return !coarse && !e.shiftKey;
}

/** 排队中的消息：这一轮结束后依次发出；可以改成引导、撤回编辑或删掉 */
function QueueList({
  items,
  canSteer,
  onSteer,
  onEdit,
  onRemove,
}: {
  items: QueuedMessage[];
  canSteer: boolean;
  onSteer?: (id: string) => void;
  onEdit?: (id: string) => void;
  onRemove?: (id: string) => void;
}) {
  return (
    <div className="cqueue" aria-label="排队中的消息">
      <div className="cqueue__head">排队中 · 这一轮结束后依次发出</div>
      {items.map((q) => (
        <div className="cqueue__item" key={q.id}>
          <span className="cqueue__text" title={q.text}>
            {q.text || <span className="is-faint">{q.attachments.map((a) => a.name).join('、')}</span>}
          </span>
          {q.attachments.length && q.text ? (
            <span className="cqueue__meta" title={q.attachments.map((a) => a.name).join('\n')}>
              <Icon name="clip" size={12} />
              {q.attachments.length}
            </span>
          ) : null}
          {canSteer && onSteer ? (
            <button type="button" className="linkbtn" onClick={() => onSteer(q.id)} title="现在就插进正在进行的这一轮">
              引导
            </button>
          ) : null}
          {onEdit ? (
            <button type="button" className="linkbtn" onClick={() => onEdit(q.id)} title="撤回到输入框里改">
              编辑
            </button>
          ) : null}
          {onRemove ? (
            <button type="button" className="iconbtn cqueue__remove" onClick={() => onRemove(q.id)} aria-label="删掉这条">
              <Icon name="x" size={12} />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export default function Composer({
  agent,
  path,
  state,
  pending,
  processAlive,
  onSend,
  onInterrupt,
  onStop,
  queue = [],
  canSteer = false,
  onUnqueue,
  onSteerQueued,
  runModel,
  onSetModel,
  runPermissionMode,
  runModels,
  onSetPermissionMode,
  warning,
  notice,
  initialOpts,
  runEffort,
  onSetEffort,
  effortPending,
  onSaveOpts,
}: {
  agent: AgentId;
  path: string;
  state: RunState | null;
  pending: number;
  processAlive: boolean;
  /** mode 只在进程忙时有意义：排到这一轮之后，还是插进这一轮 */
  onSend: (text: string, opts: RunOptions, attachments: string[], mode: SendMode) => Promise<void>;
  /** 打断这一轮；resolve 为被撤下来的排队消息（放回输入框） */
  onInterrupt?: () => Promise<QueuedMessage[] | undefined>;
  onStop?: () => Promise<void>;
  /** 排队等这一轮结束再发的消息 */
  queue?: QueuedMessage[];
  /** agent 能不能把消息插进正在进行的这一轮 */
  canSteer?: boolean;
  onUnqueue?: (id: string) => Promise<QueuedMessage>;
  onSteerQueued?: (id: string) => Promise<void>;
  /** 当前进程用的模型；进程活着时下拉框直接切换它 */
  runModel?: string;
  onSetModel?: (model: string) => Promise<void>;
  runPermissionMode?: PermissionMode;
  runModels?: ModelInfo[] | null;
  onSetPermissionMode?: (mode: PermissionMode) => Promise<void>;
  /** 输入框上方的提醒（例如会话可能正在终端里使用） */
  warning?: string;
  /** 输入框上方的额外内容（套餐额度提醒） */
  notice?: React.ReactNode;
  /** 进程不在时下拉框的初始值：会话上次用的选项 */
  initialOpts?: RunOptions;
  /** 进程当前的推理强度；有 onSetEffort 时运行中也能切换 */
  runEffort?: string | null;
  onSetEffort?: (effort: string) => Promise<void>;
  /** 运行中改强度要等下次启动进程才生效（Claude 的 --effort） */
  effortPending?: boolean;
  /** 进程不在时改了下拉框：马上存到服务端（浏览器重启后仍是这个选择） */
  onSaveOpts?: (opts: RunOptions) => void;
}) {
  const [text, setText] = useState('');
  const fetchedModels = useModels(agent);
  const [opts, setOptsState] = useState<RunOptions>(initialOpts ?? {});
  /** 用户自己动过下拉框之后，就不再被服务端回来的 prefs 覆盖 */
  const touched = useRef(false);
  const setOpts = (next: RunOptions) => {
    touched.current = true;
    setOptsState(next);
    onSaveOpts?.(explicit(next));
  };
  const initialKey = JSON.stringify(initialOpts ?? {});
  useEffect(() => {
    if (!touched.current) setOptsState(JSON.parse(initialKey) as RunOptions);
  }, [initialKey]);
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const files = useAttachments();
  const drop = useDropZone(files.add);
  const working = state === 'starting' || state === 'running';
  /** 进程正在跑一轮、agent 支持插话：默认发出去就是引导，另给一个「排队」 */
  const steerable = state === 'running' && canSteer;
  const canSend = !busy && !files.uploading && (!!text.trim() || files.ids.length > 0);

  const submit = async (mode: SendMode = steerable ? 'steer' : 'queue') => {
    const value = text.trim();
    if (!canSend) return;
    setBusy(true);
    setError('');
    try {
      // 三项都显式带上：'default' / 空串表示"就用默认"，免得服务端拿会话上次的选项补
      await onSend(value, explicit(opts), files.ids, mode);
      touched.current = false;
      setText('');
      files.clear();
      input.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败');
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn?: () => Promise<unknown>) => {
    if (!fn) return;
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    }
  };

  /** 撤回的排队消息放回输入框：文字接在已经写了的前面，附件放回托盘 */
  const restore = (items: QueuedMessage[]) => {
    if (!items.length) return;
    const texts = items.map((q) => q.text).filter(Boolean);
    setText((cur) => [...texts, cur.trim()].filter(Boolean).join('\n\n'));
    files.restore(items.flatMap((q) => q.attachments));
    input.current?.focus();
  };

  const placeholder = processAlive
    ? working
      ? steerable
        ? coarse
          ? '补充指示，发送即插进这一轮'
          : '补充指示 · Enter 插进这一轮 · Tab 排队'
        : '继续输入会排在当前这一轮之后'
      : '继续对话'
    : `发送消息，会在同一会话上续接（${agent === 'codex' ? 'codex resume' : agent === 'dsh' ? 'DSH 会话恢复' : 'claude --resume'}）`;

  return (
    <footer className="composer">
      <div className="composer__inner">
        {notice}
        {warning ? (
          <div className="composer__warn">
            <Icon name="alert" size={14} />
            {warning}
          </div>
        ) : null}
        {pending > 0 ? (
          <div className="composer__alert">
            <Icon name="alert" size={14} />有 {pending} 个请求等你处理，见上方卡片
            {steerable ? '；直接发消息会先拒绝它们，再把消息交给 agent' : ''}
          </div>
        ) : null}
        {queue.length ? (
          <QueueList
            items={queue}
            canSteer={steerable}
            onSteer={onSteerQueued ? (id) => void act(() => onSteerQueued(id)) : undefined}
            onEdit={onUnqueue ? (id) => void act(async () => restore([await onUnqueue(id)])) : undefined}
            onRemove={onUnqueue ? (id) => void act(() => onUnqueue(id)) : undefined}
          />
        ) : null}
        <div
          className={`composer__card${working ? ' is-working' : ''}${drop.over ? ' is-dropping' : ''}`}
          onClick={(e) => e.target === e.currentTarget && input.current?.focus()}
          {...drop.props}
        >
          <AttachmentTray items={files.items} onRemove={files.remove} />
          <textarea
            ref={input}
            className="composer__input"
            rows={text.includes('\n') ? Math.min(8, text.split('\n').length) : 1}
            placeholder={placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => onPasteFiles(e, files.add)}
            onKeyDown={(e) => {
              if (isSubmitKey(e)) {
                e.preventDefault();
                void submit();
              } else if (e.key === 'Tab' && !e.shiftKey && working && canSend) {
                // 和 Codex 终端一样：一轮进行中按 Tab 排队
                e.preventDefault();
                void submit('queue');
              }
            }}
          />
          <div className="composer__bar">
            <AttachButton onFiles={files.add} />
            <span className="composer__opts">
              {processAlive ? (
                <>
                  {onSetModel ? (
                    <ModelSelect
                      agent={agent}
                      options={runModels}
                      value={runModel ?? 'default'}
                      disabled={switching}
                      onChange={(m) => {
                        setSwitching(true);
                        void act(() => onSetModel(m)).finally(() => setSwitching(false));
                      }}
                    />
                  ) : null}
                  {onSetEffort ? (
                    <EffortSelect
                      levels={effortLevelsOf(runModels?.length ? runModels : fetchedModels, runModel)}
                      value={runEffort ?? ''}
                      disabled={switching}
                      hint={effortPending ? '推理强度在启动进程时指定：改了会记下，下次启动进程时生效' : undefined}
                      onChange={(e) => {
                        setSwitching(true);
                        void act(() => onSetEffort(e)).finally(() => setSwitching(false));
                      }}
                    />
                  ) : null}
                  {onSetPermissionMode ? (
                    <PermissionSelect
                      agent={agent}
                      value={runPermissionMode ?? 'default'}
                      disabled={switching}
                      onChange={(m) => {
                        setSwitching(true);
                        void act(() => onSetPermissionMode(m)).finally(() => setSwitching(false));
                      }}
                    />
                  ) : null}
                </>
              ) : (
                <RunOptionFields agent={agent} value={opts} onChange={setOpts} />
              )}
            </span>
            {working && onInterrupt ? (
              <button
                className="btn btn--sm composer__interrupt"
                onClick={() =>
                  void act(async () => {
                    restore((await onInterrupt()) ?? []);
                  })
                }
                title={queue.length ? '打断当前这一轮，进程保留；排队的消息放回输入框' : '打断当前这一轮，进程保留'}
              >
                <Icon name="stop" size={13} filled />
                打断
              </button>
            ) : null}
            {steerable && canSend ? (
              <button className="btn btn--sm" onClick={() => void submit('queue')} title={coarse ? '等这一轮结束再发' : '等这一轮结束再发（Tab）'}>
                排队
              </button>
            ) : null}
            <button
              className="sendbtn"
              disabled={!canSend}
              onClick={() => void submit()}
              aria-label={busy ? '发送中' : steerable ? '引导' : working ? '排队' : '发送'}
              title={
                files.uploading
                  ? '附件还在上传'
                  : steerable
                    ? `引导：插进正在进行的这一轮，agent 做完当前这一步就会看到${coarse ? '' : '（Enter）'}`
                    : working
                      ? `排队：这一轮结束后发出${coarse ? '' : '（Enter）'}`
                      : coarse
                        ? '发送'
                        : '发送（Enter；Shift+Enter 换行）'
              }
            >
              <Icon name="send" size={17} />
            </button>
          </div>
        </div>
        <div className="composer__foot">
          <span className="composer__path mono" title={path}>
            <Icon name="folder" size={12} />
            {homeShorten(path)}
          </span>
          {error ? <span className="composer__error">{error}</span> : null}
          {processAlive && onStop ? (
            <button className="linkbtn" onClick={() => void act(onStop)} title="结束 agent 进程；会话仍可随时续接">
              结束进程
            </button>
          ) : null}
        </div>
      </div>
    </footer>
  );
}
