/**
 * 统一事件模型 —— 整个系统的核心契约。
 * 所有适配器只做一件事：把 agent 的原始格式翻译成这里的结构。
 * 前端只认识这里定义的类型，新增 agent 不改 UI。
 */

export type AgentId = 'claude' | 'codex' | 'dsh' | 'pi' | 'cursor';

/** 会话内的一条媒体（图片 / 附件）。M0 只记录引用，不搬字节。 */
export interface MediaRef {
  kind: 'image' | 'file';
  mime?: string;
  bytes: number;
  /** 相对会话文件的字节位置，便于将来按需取回原图 */
  offset?: number;
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
  | { kind: 'diff'; files: FilePatch[] }
  | {
      kind: 'usage';
      model?: string;
      inputTokens: number;
      outputTokens: number;
      cacheRead?: number;
      cacheWrite?: number;
      costUsd?: number;
    }
  | {
      kind: 'approval';
      requestId: string;
      tool: string;
      detail: string;
      choices: string[];
      state: 'pending' | 'approved' | 'denied';
      /** 工具入参原文，审批前要能看清它到底要干什么 */
      input?: unknown;
    }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; code?: string; text: string };

export interface FilePatch {
  path: string;
  added: number;
  removed: number;
  patch?: string;
}

export interface UnifiedEvent {
  agent: AgentId;
  sessionId: string;
  /** 绝对轮次（1 起）；无法判定时为 0 */
  turn: number;
  /** agent 内单调递增序号。claude 用行首字节偏移，codex 用 ordinal */
  seq: number;
  ts: string;
  item: Item;
  /**
   * 跨数据源稳定的去重键。实时流与磁盘回放各有各的 seq，
   * 但同一条消息的 uid 一致（claude 用行 uuid + 块序号），前端据此合并。
   * 同 uid 的后到事件覆盖先到的（例如审批从 pending 变为 approved）。
   */
  uid?: string;
  /**
   * 只存在于实时流、永远不会写进会话文件的事件（审批卡、进程退出提示等）。
   * 合并时它们没有磁盘对应物可去重，只能锚定在前一个已落盘事件之后。
   */
  transient?: boolean;
  /** 永远保留回到原文的指针，方便排查解析问题 */
  raw?: { file: string; offset: number; type: string };
}

/** 会话摘要 —— 列表页只需要这些，绝不整文件解析 */
export interface SessionSummary {
  /** `${agent}:${sessionId}` */
  id: string;
  agent: AgentId;
  sessionId: string;
  /** 项目根目录（agent 记录的真实 cwd） */
  cwd: string;
  /** 真相源文件 */
  file: string;
  title: string;
  /** 最近使用的模型 */
  model?: string;
  /** 绝对轮次数 */
  turns: number;
  /** 累计花费（agent 自己记账的话） */
  costUsd?: number;
  sizeBytes: number;
  mtime: number;
  updatedAt: string;
  /** 首条人类输入的片段，用于列表副标题 */
  preview?: string;
  /** 解析过程中遇到的不认识的行类型数量，用于提示"格式变了" */
  unknownTypes?: Record<string, number>;
  /** 子代理会话（例如 Codex 的 Guardian 审查），值为子代理名；列表里弱化显示 */
  subagent?: string;
  /** 以下是 agentctl 自己的注解（存在索引库里，不写 agent 的文件） */
  pinned?: boolean;
  tags?: string[];
  /** 用户改过标题时，agent 自己给的原标题 */
  originalTitle?: string;
}

export interface EventWindow {
  /** 时间正序（最旧 → 最新） */
  events: UnifiedEvent[];
  /** 继续往前翻的游标；null 表示已到文件开头 */
  nextBefore: number | null;
  hasMore: boolean;
  /** 本窗口在文件中的字节区间，便于调试 */
  window: { start: number; end: number };
}

export const AGENT_LABEL: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  dsh: 'DeepSeek Harness',
  pi: 'Pi',
  cursor: 'Cursor',
};
