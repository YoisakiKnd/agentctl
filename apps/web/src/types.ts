/** 与 server 的 API 契约（刻意独立于 @agentctl/core，前后端不共享运行时） */

export type AgentId = 'claude' | 'codex' | 'dsh' | 'pi' | 'cursor';

export interface MediaRef {
  kind: 'image' | 'file';
  mime?: string;
  bytes: number;
}

export interface TruncInfo {
  originalChars: number;
  keptHead: number;
  keptTail: number;
}

export type Item =
  | { kind: 'text'; role: 'user' | 'assistant'; text: string; media?: MediaRef[]; phase?: 'plan' }
  | { kind: 'thinking'; text: string; durationMs?: number }
  | { kind: 'tool_call'; callId: string; name: string; input: unknown; summary?: string }
  | { kind: 'tool_result'; callId: string; ok: boolean; output: string; truncated?: TruncInfo }
  | { kind: 'diff'; files: { path: string; added: number; removed: number; patch?: string }[] }
  | {
      kind: 'usage';
      model?: string;
      inputTokens: number;
      outputTokens: number;
      cacheRead?: number;
      cacheWrite?: number;
    }
  | {
      kind: 'approval';
      requestId: string;
      tool: string;
      detail: string;
      choices: string[];
      state: 'pending' | 'approved' | 'denied';
      input?: unknown;
      /** 提问卡回答了什么 */
      answers?: QuestionAnswers;
    }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; code?: string; text: string };

export interface UnifiedEvent {
  agent: AgentId;
  sessionId: string;
  turn: number;
  seq: number;
  ts: string;
  item: Item;
  /** 跨实时流与磁盘回放的去重键 */
  uid?: string;
  /** 只存在于实时流、不会落盘 */
  transient?: boolean;
}

export interface SessionSummary {
  id: string;
  agent: AgentId;
  sessionId: string;
  cwd: string;
  file: string;
  title: string;
  model?: string;
  turns: number;
  costUsd?: number;
  sizeBytes: number;
  mtime: number;
  updatedAt: string;
  preview?: string;
  unknownTypes?: Record<string, number>;
  subagent?: string;
  pinned?: boolean;
  tags?: string[];
  /** 用户改过标题时，agent 自己给的原标题 */
  originalTitle?: string;
}

/** 会话上次用的运行选项（服务端记的；没有时权限模式取 agent 自己记录的） */
export interface RunPrefs {
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
}

export interface EventWindow {
  events: UnifiedEvent[];
  nextBefore: number | null;
  hasMore: boolean;
  window: { start: number; end: number };
}

export interface Stats {
  sessions: number;
  agents: number;
  totalCostUsd: number;
  totalBytes: number;
  latestAt: string | null;
}

export interface AgentInfo {
  id: AgentId;
  name: string;
  dataDir: string;
  binary?: string;
  binaryPath?: string;
  available: boolean;
  sessionCount: number;
  capabilities: {
    discover: boolean;
    replay: boolean;
    live: 'acp' | 'stream-json' | 'rpc' | 'pty' | false;
    resume: boolean;
    fork: boolean;
    approvals: boolean;
    thinking: boolean;
    usage: boolean;
  };
}

export type RunState = 'starting' | 'running' | 'idle' | 'exited';
export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions';
export type ApprovalDecision = 'allow' | 'allow_session' | 'deny';

export interface ModelInfo {
  value: string;
  displayName: string;
  description?: string;
  resolvedModel?: string;
  effortLevels?: string[];
}

export interface RunInfo {
  id: string;
  agent: AgentId;
  sessionKey?: string;
  cwd: string;
  state: RunState;
  title: string;
  startedAt: string;
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  pendingApprovals: number;
  queued?: number;
  error?: string;
}

/** 进程忙时发来、排队等这一轮结束再发的消息 */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: { name: string; mime: string; bytes: number; uploadId?: string }[];
  at: string;
}

/** 发消息时进程正忙：queue 排到这一轮之后；steer 插进正在进行的这一轮 */
export type SendMode = 'queue' | 'steer';

/** 提问的回答：{ 问题原文: [选中的选项 / 自己写的答案] } */
export type QuestionAnswers = Record<string, string[]>;

export type LiveMessage =
  | { type: 'event'; event: UnifiedEvent }
  | { type: 'delta'; block: 'text' | 'thinking'; text: string }
  | { type: 'delta_reset' }
  | { type: 'state'; state: RunState; sessionId?: string; error?: string; exitCode?: number | null }
  | { type: 'config'; model?: string; permissionMode?: PermissionMode; models?: ModelInfo[]; effort?: string }
  | { type: 'queue'; items: QueuedMessage[]; steer: boolean };

export interface Me {
  authRequired: boolean;
  authenticated: boolean;
}

export const AGENT_LABEL: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  dsh: 'DeepSeek Harness',
  pi: 'Pi',
  cursor: 'Cursor',
};

export interface SearchHit {
  offset: number;
  uid?: string;
  turn: number;
  ts: string;
  kind: Item['kind'];
  role?: 'user' | 'assistant';
  before: string;
  match: string;
  after: string;
}

export interface SearchResult {
  results: { session: SessionSummary; hits: SearchHit[] }[];
  total: number;
  truncated: boolean;
  ms: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  /** agent 不记账（Codex、DSH）时没有这个字段 */
  costUsd?: number;
  messages: number;
}

export interface UsageReport {
  days: string[];
  from: string | null;
  to: string;
  daily: ({ day: string; agent: AgentId } & UsageTotals)[];
  agents: ({ agent: AgentId; sessions: number } & UsageTotals)[];
  models: ({ agent: AgentId; model: string } & UsageTotals)[];
  sessions: ({ id: string; agent: AgentId; title: string; cwd: string; updatedAt: string } & UsageTotals)[];
  totals: UsageTotals & { sessions: number };
  ms: number;
}

export interface QuotaWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt?: string;
  windowMinutes?: number;
}

export interface QuotaEntry {
  /** claude / codex / custom:<uuid> */
  id: string;
  /** 内置订阅源对应的 agent；自定义订阅源没有 */
  agent?: AgentId;
  kind: 'cli' | 'json' | 'deepseek';
  name: string;
  enabled: boolean;
  plan?: string;
  windows?: QuotaWindow[];
  credits?: { enabled: boolean; balance?: string; unlimited?: boolean; usedPercent?: number };
  balance?: { amount: number; unit?: string; lowBelow?: number };
  blocked?: boolean;
  fetchedAt?: string;
  error?: string;
  /** 自定义订阅源的配置（密钥已打码） */
  config?: Record<string, unknown>;
}

export interface QuotaReport {
  agents: QuotaEntry[];
  warnPercent: number;
  settings: { resetMinUsed: number; disabled: string[] };
}

export type ChannelKind = 'ntfy' | 'bark' | 'telegram' | 'webhook' | 'browser';

export interface NotifyChannel {
  id: string;
  kind: ChannelKind;
  name: string;
  config: Record<string, string>;
  events: string[];
  enabled: boolean;
}

export interface ChannelField {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
}

export interface NotifyItem {
  id: number;
  at: number;
  event: 'reset' | 'warn' | 'low' | 'test';
  source?: string;
  title: string;
  body: string;
  deliveries?: { channel: string; ok: boolean; error?: string }[];
}
