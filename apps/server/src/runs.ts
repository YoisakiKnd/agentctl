import { randomUUID } from 'node:crypto';
import type {
  AgentAdapter,
  AgentId,
  ApprovalDecision,
  LiveMessage,
  PermissionMode,
  RunHandle,
  RunState,
} from '@agentctl/core';

export interface RunInfo {
  id: string;
  agent: AgentId;
  /** `${agent}:${sessionId}`；新会话在 agent 分配 id 之前为空 */
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

type Listener = (msg: LiveMessage) => void;

/** 回放缓冲：晚到的订阅者（刷新页面、换设备）先补齐这些，再接实时流 */
const LOG_LIMIT = 4000;
/** 进程退出后保留多久，让还开着的页面能看到"已结束"而不是 404 */
const RETAIN_EXITED_MS = 10 * 60_000;

class Run {
  readonly id = randomUUID();
  readonly startedAt = new Date().toISOString();
  state: RunState = 'starting';
  sessionId = '';
  error?: string;
  handle!: RunHandle;
  /** 一轮跑完（running → idle）时调用；用来刷新套餐额度 */
  onTurnEnd?: () => void;
  private readonly log: LiveMessage[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly pending = new Set<string>();
  readonly agent: AgentId;
  readonly cwd: string;
  readonly title: string;
  /** 运行中可被 set_model 改掉 */
  model?: string;
  readonly effort?: string;
  permissionMode?: PermissionMode;

  constructor(
    agent: AgentId,
    cwd: string,
    title: string,
    model?: string,
    permissionMode?: PermissionMode,
    effort?: string,
  ) {
    this.agent = agent;
    this.cwd = cwd;
    this.title = title;
    this.model = model;
    this.effort = effort;
    this.permissionMode = permissionMode;
  }

  push(msg: LiveMessage): void {
    if (msg.type === 'config') {
      if (msg.permissionMode) this.permissionMode = msg.permissionMode;
      // init 里报的是解析后的完整 id；用户选的是别名时保留别名，下拉框才对得上
      if (msg.model && !this.model) this.model = msg.model;
    }
    if (msg.type === 'state') {
      if (this.state === 'running' && msg.state === 'idle') this.onTurnEnd?.();
      this.state = msg.state;
      if (msg.sessionId) this.sessionId = msg.sessionId;
      if (msg.error) this.error = msg.error;
    }
    if (msg.type === 'event' && msg.event.item.kind === 'approval') {
      if (msg.event.item.state === 'pending') this.pending.add(msg.event.item.requestId);
      else this.pending.delete(msg.event.item.requestId);
    }
    // 增量只对"此刻正在看"的人有意义，不进回放缓冲，否则刷新后会看到重复的半截文字
    if (msg.type !== 'delta' && msg.type !== 'delta_reset') {
      this.log.push(msg);
      if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
    }
    for (const fn of this.listeners) fn(msg);
  }

  subscribe(fn: Listener): () => void {
    for (const msg of this.log) fn(msg);
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  info(): RunInfo {
    return {
      id: this.id,
      agent: this.agent,
      sessionKey: this.sessionId ? `${this.agent}:${this.sessionId}` : undefined,
      cwd: this.cwd,
      state: this.state,
      title: this.title,
      startedAt: this.startedAt,
      model: this.model,
      effort: this.effort,
      permissionMode: this.permissionMode,
      pendingApprovals: this.pending.size,
      error: this.error,
    };
  }
}

export interface StartOptions {
  adapter: AgentAdapter;
  binary?: string;
  cwd: string;
  prompt: string;
  title: string;
  resumeSessionId?: string;
  startTurn?: number;
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  allowBypass?: boolean;
}

/**
 * 运行中的 agent 进程表。只在内存里：server 重启 = 所有进程随之结束，
 * 会话本身仍在 agent 的磁盘文件里，下次发消息会自动 --resume。
 */
export class RunManager {
  private readonly runs = new Map<string, Run>();
  private readonly onExit: (run: RunInfo) => void;
  private readonly onTurnEnd: (run: RunInfo) => void;

  constructor(onExit: (run: RunInfo) => void = () => undefined, onTurnEnd: (run: RunInfo) => void = () => undefined) {
    this.onExit = onExit;
    this.onTurnEnd = onTurnEnd;
  }

  start(opts: StartOptions): Run {
    if (!opts.adapter.run) throw new Error(`${opts.adapter.meta.name} 尚未支持实时运行`);
    const run = new Run(opts.adapter.id, opts.cwd, opts.title, opts.model, opts.permissionMode, opts.effort);
    if (opts.resumeSessionId) run.sessionId = opts.resumeSessionId;
    run.onTurnEnd = () => this.onTurnEnd(run.info());
    this.runs.set(run.id, run);

    run.handle = opts.adapter.run(
      {
        cwd: opts.cwd,
        prompt: opts.prompt,
        resumeSessionId: opts.resumeSessionId,
        startTurn: opts.startTurn,
        model: opts.model,
        effort: opts.effort,
        permissionMode: opts.permissionMode,
        allowBypass: opts.allowBypass,
        binary: opts.binary,
      },
      (msg) => run.push(msg),
    );

    void run.handle.exited.then(() => {
      this.onExit(run.info());
      setTimeout(() => {
        if (this.runs.get(run.id) === run) this.runs.delete(run.id);
      }, RETAIN_EXITED_MS).unref();
    });
    return run;
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  /** 某个会话当前（或最近）的运行；优先返回仍活着的那个 */
  forSession(sessionKey: string): Run | undefined {
    let fallback: Run | undefined;
    for (const run of this.runs.values()) {
      if (`${run.agent}:${run.sessionId}` !== sessionKey) continue;
      if (run.state !== 'exited') return run;
      fallback = run;
    }
    return fallback;
  }

  list(): RunInfo[] {
    return [...this.runs.values()].map((r) => r.info());
  }

  respond(id: string, requestId: string, decision: ApprovalDecision, answers?: Record<string, string>): boolean {
    return this.runs.get(id)?.handle.respond(requestId, decision, answers) ?? false;
  }

  stopAll(): void {
    for (const run of this.runs.values()) run.handle.stop();
  }
}

export type { Run };
