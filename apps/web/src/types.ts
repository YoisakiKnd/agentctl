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
  | { kind: 'text'; role: 'user' | 'assistant'; text: string; media?: MediaRef[] }
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
  error?: string;
}

export type LiveMessage =
  | { type: 'event'; event: UnifiedEvent }
  | { type: 'delta'; block: 'text' | 'thinking'; text: string }
  | { type: 'delta_reset' }
  | { type: 'state'; state: RunState; sessionId?: string; error?: string; exitCode?: number | null }
  | { type: 'config'; model?: string; permissionMode?: PermissionMode };

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
