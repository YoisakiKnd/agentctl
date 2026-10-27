import { useRef, useState, type KeyboardEvent } from 'react';
import type { RunOptions } from '../api';
import { homeShorten } from '../format';
import { useAllowBypass } from '../caps';
import { EFFORT_LABEL, isAlias, modelLabel, useModels } from '../models';
import Icon from './Icon';
import type { AgentId, ModelInfo, PermissionMode, RunState } from '../types';

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

/** DSH 的 ACP 没有暴露权限模式：沿用 DSH 自己的权限预设，网页上不提供切换 */
const NO_MODES: ModeOption[] = [];

/** Codex 没有"只自动接受编辑"这一档；plan 对应只读沙箱 */
const CODEX_MODES: ModeOption[] = [
  { value: 'default', label: '逐个审批', hint: '除只读的安全命令外都要你确认（untrusted）' },
  { value: 'auto', label: 'Auto 模式', hint: '在工作区沙箱里运行，由 Codex 判断何时需要你确认（on-request）' },
  { value: 'plan', label: '只读', hint: '只读沙箱：能看不能改，需要写入时会来问你' },
  { value: 'bypassPermissions', label: '跳过所有权限', hint: '不询问、不加沙箱（danger-full-access）' },
];

export function modesFor(agent: AgentId): ModeOption[] {
  if (agent === 'dsh') return NO_MODES;
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
      {efforts.length ? (
        <select
          className="select"
          value={value.effort ?? ''}
          onChange={(e) => onChange({ ...value, effort: e.target.value || undefined })}
          aria-label="推理强度"
          title="推理强度（--effort）"
        >
          <option value="">强度·默认</option>
          {efforts.map((e) => (
            <option key={e} value={e}>
              强度·{EFFORT_LABEL[e] ?? e}
            </option>
          ))}
        </select>
      ) : null}
      <PermissionSelect
        agent={agent}
        value={value.permissionMode ?? 'default'}
        onChange={(v) => onChange({ ...value, permissionMode: v })}
      />
    </>
  );
}

/** 提交时按 Enter（排除输入法组字中的 Enter，否则中文用户选词就会把消息发出去） */
export function isSubmitKey(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return false;
  if (e.metaKey || e.ctrlKey) return true;
  return !coarse && !e.shiftKey;
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
  runModel,
  onSetModel,
  runPermissionMode,
  runModels,
  onSetPermissionMode,
  warning,
  notice,
}: {
  agent: AgentId;
  path: string;
  state: RunState | null;
  pending: number;
  processAlive: boolean;
  onSend: (text: string, opts: RunOptions) => Promise<void>;
  onInterrupt?: () => Promise<void>;
  onStop?: () => Promise<void>;
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
}) {
  const [text, setText] = useState('');
  const [opts, setOpts] = useState<RunOptions>({});
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const working = state === 'starting' || state === 'running';

  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setError('');
    try {
      await onSend(value, opts);
      setText('');
      input.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : '发送失败');
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn?: () => Promise<void>) => {
    if (!fn) return;
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
    }
  };

  const placeholder = processAlive
    ? working
      ? '继续输入会排在当前这一轮之后'
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
            <Icon name="alert" size={14} />有 {pending} 个工具调用等待审批，见上方卡片
          </div>
        ) : null}
        <div className={`composer__card${working ? ' is-working' : ''}`} onClick={(e) => e.target === e.currentTarget && input.current?.focus()}>
          <textarea
            ref={input}
            className="composer__input"
            rows={text.includes('\n') ? Math.min(8, text.split('\n').length) : 1}
            placeholder={placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (isSubmitKey(e)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="composer__bar">
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
              <button className="btn btn--sm composer__interrupt" onClick={() => void act(onInterrupt)} title="打断当前这一轮，进程保留">
                <Icon name="stop" size={13} filled />
                打断
              </button>
            ) : null}
            <button
              className="sendbtn"
              disabled={busy || !text.trim()}
              onClick={() => void submit()}
              aria-label={busy ? '发送中' : '发送'}
              title={coarse ? '发送' : '发送（Enter；Shift+Enter 换行）'}
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
