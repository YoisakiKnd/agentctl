import type { AgentId, EventWindow, SessionSummary, UnifiedEvent } from './events.ts';
import type { SearchHit, SearchQuery } from './search.ts';
import type { UsageBucket } from './usage.ts';

export interface AgentMeta {
  name: string;
  /** 期望的可执行文件名，用于探测是否可用 */
  binary?: string;
  /** 会话文件根目录（相对 $HOME） */
  dataDir: string;
  docs?: string;
}

export interface AgentCapabilities {
  /** 能扫盘列出历史会话 */
  discover: boolean;
  /** 能完整回放历史 */
  replay: boolean;
  /** 实时执行方式；false 表示 M0 只读 */
  live: 'acp' | 'stream-json' | 'rpc' | 'pty' | false;
  resume: boolean;
  fork: boolean;
  approvals: boolean;
  thinking: boolean;
  usage: boolean;
}

export interface ReplayOptions {
  /** 向前翻的字节游标；缺省读文件尾部（首屏） */
  before?: number;
  /** 单窗口字节预算 */
  maxBytes?: number;
  /** 跳转用：窗口以"这个偏移所在的那一行"结尾（优先于 before） */
  through?: number;
}

/**
 * 一个 agent 一个包。新增 agent = 新增一个实现，UI 与 server 一行不改。
 */
export interface AgentAdapter {
  id: AgentId;
  meta: AgentMeta;
  capabilities: AgentCapabilities;
  /** 扫盘发现会话；实现应只读 stat + 头尾，不整文件解析 */
  discover(): Promise<SessionSummary[]>;
  /** 回放一个窗口的事件（时间正序返回） */
  replay(session: SessionSummary, opts?: ReplayOptions): Promise<EventWindow>;
  /**
   * 可选：后台全量扫描补全摘要（轮次数 / 花费 / 首条提示）。
   * discover 只读头尾拿不到准确轮次，这一步由 registry 在空闲时按需触发。
   */
  refine?(session: SessionSummary): Promise<Partial<SessionSummary>>;
  /**
   * 可选：从字节游标 after（必须是行边界，通常是上次窗口的 window.end）读到文件末尾。
   * 会话页靠它增量追新内容——不管会话是网页里跑的还是终端里跑的。
   */
  replayAfter?(session: SessionSummary, after: number, maxBytes?: number): Promise<EventWindow>;
  /**
   * 可选：replay 游标所在坐标系里的内容总长。缺省就是文件字节数；
   * 压缩存储的会话（DSH）游标是解压后的偏移，必须实现它。
   */
  contentLength?(session: SessionSummary): Promise<number>;
  /** 可选：全文搜索这个会话（见 core/search.ts 的两段式匹配） */
  search?(session: SessionSummary, q: SearchQuery, limit: number): Promise<SearchHit[]>;
  /**
   * 可选：整个会话按天 × 模型的用量（全量扫描，server 按 size+mtime 缓存结果）。
   * 计的是实际花出去的量：会被回退掉的分支（Pi）、子代理也算在内。
   */
  usage?(session: SessionSummary): Promise<UsageBucket[]>;
  /** 可选：在真终端里续接这个会话的参数（Shell 模式用），例如 claude 是 ['--resume', id] */
  resumeArgs?(session: SessionSummary): string[];
  /** 可选：该 agent 命令行当前能用的模型（与终端里 /model 看到的一致） */
  models?(binary?: string): Promise<ModelInfo[]>;
  /** 可选：启动一次实时运行（新建或续接）。capabilities.live 为 false 的适配器不实现 */
  run?(req: RunRequest, sink: RunSink): RunHandle;
}

/* ── 实时运行 ─────────────────────────────────────────────── */

/**
 * default 逐个审批 · acceptEdits 自动接受编辑 · auto 由分类器自动判断（危险操作仍会问）
 * plan 只规划 · bypassPermissions 跳过一切权限检查
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions';

export interface ModelInfo {
  /** 传给 --model 的值；'default' 表示不指定，跟随 agent 自己的配置 */
  value: string;
  displayName: string;
  description?: string;
  /** 别名实际指向的模型 id */
  resolvedModel?: string;
  /** 支持的推理强度（--effort） */
  effortLevels?: string[];
}

export interface RunRequest {
  /** 已校验过的绝对路径 */
  cwd: string;
  /** 首条用户消息 */
  prompt: string;
  /** 续接已有会话（agent 自己的 sessionId，不带前缀） */
  resumeSessionId?: string;
  model?: string;
  /** 推理强度（--effort），只在启动进程时生效 */
  effort?: string;
  permissionMode?: PermissionMode;
  /** 允许本进程（启动时或运行中）进入 bypassPermissions；不影响默认行为 */
  allowBypass?: boolean;
  /** 可执行文件的绝对路径（server 探测好再传进来，服务进程的 PATH 不可靠） */
  binary?: string;
  /** 续接时的起始轮次，保证实时事件的轮号接得上历史 */
  startTurn?: number;
}

export type RunState = 'starting' | 'running' | 'idle' | 'exited';

export type ApprovalDecision = 'allow' | 'allow_session' | 'deny';

/**
 * 实时通道上的消息。event 是正式事件（与回放同构，可按 uid 去重）；
 * delta 是流式增量，只用于打字机效果，正式事件到达后即丢弃。
 */
export type LiveMessage =
  | { type: 'event'; event: UnifiedEvent }
  | { type: 'delta'; block: 'text' | 'thinking'; text: string }
  | { type: 'delta_reset' }
  | { type: 'state'; state: RunState; sessionId?: string; error?: string; exitCode?: number | null }
  /** 进程当前生效的配置（启动时、运行中切换后各推一次） */
  | {
      type: 'config';
      model?: string;
      permissionMode?: PermissionMode;
      /** 进程自己报的可选模型（DSH 的 ACP 只在建立会话后才给），网页用它替换静态列表 */
      models?: ModelInfo[];
    };

export type RunSink = (msg: LiveMessage) => void;

export interface RunHandle {
  /** 首次拿到 agent 分配的 sessionId 时 resolve；进程先退出则 reject */
  sessionId: Promise<string>;
  /** 追加一条用户消息（进程会排队，不必等上一轮结束） */
  send(text: string): void;
  /** answers：AskUserQuestion 的回答，`{ 问题原文: 选中的选项（多选用 ", " 连接） }` */
  respond(requestId: string, decision: ApprovalDecision, answers?: Record<string, string>): boolean;
  /** 运行中切换权限模式；resolve 为实际生效的模式 */
  setPermissionMode?(mode: PermissionMode): Promise<PermissionMode>;
  /** 运行中切换模型（下一次请求起生效）；resolve 为实际生效的模型 id */
  setModel?(model: string): Promise<string | undefined>;
  /** 打断当前这一轮，进程保留 */
  interrupt(): void;
  /** 结束进程 */
  stop(): void;
  exited: Promise<{ code: number | null; signal: string | null }>;
}
