import { randomUUID } from 'node:crypto';
import type {
  AgentAdapter,
  AgentId,
  ApprovalDecision,
  Attachment,
  LiveMessage,
  PermissionMode,
  QuestionAnswers,
  QueuedMessage,
  RunHandle,
  RunState,
} from '@agentctl/core';
import { oneLine } from '@agentctl/core';

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
  /** 排队等着发的消息数 */
  queued: number;
  error?: string;
}

/** 发消息时进程正忙：queue 排到这一轮之后；steer 插进正在进行的这一轮 */
export type SendMode = 'queue' | 'steer';

interface Queued {
  id: string;
  text: string;
  attachments: Attachment[];
  at: string;
}

const UPLOAD_ID_RE = /[\\/]uploads[\\/]([0-9a-f-]{36})[\\/]/;

function publicQueued(q: Queued): QueuedMessage {
  return {
    id: q.id,
    text: q.text,
    at: q.at,
    attachments: q.attachments.map((a) => ({ name: a.name, mime: a.mime, bytes: a.bytes, uploadId: UPLOAD_ID_RE.exec(a.path)?.[1] })),
  };
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
  /**
   * 进程忙时发来的消息在这里排队，空闲了再一条条交给适配器。
   * 排在 server 而不是适配器里：网页能看到、能撤回、能改成引导，刷新页面也还在。
   */
  private queue: Queued[] = [];
  /** 提问卡的回答，等适配器推「已回答」那条事件时一起记进去 */
  private readonly answers = new Map<string, QuestionAnswers>();
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
      // 空闲了就发下一条排队的；放到微任务里，别在适配器的 setState 里重入
      if (msg.state === 'idle' && this.queue.length) queueMicrotask(() => this.drain());
      if (msg.state === 'exited' && this.queue.length) this.dropQueue();
      this.state = msg.state;
      if (msg.sessionId) this.sessionId = msg.sessionId;
      if (msg.error) this.error = msg.error;
    }
    if (msg.type === 'event' && msg.event.item.kind === 'approval') {
      const item = msg.event.item;
      if (item.state === 'pending') this.pending.add(item.requestId);
      else {
        this.pending.delete(item.requestId);
        const answers = this.answers.get(item.requestId);
        if (answers) {
          this.answers.delete(item.requestId);
          msg = { ...msg, event: { ...msg.event, item: { ...item, answers } } };
        }
      }
    }
    // 增量只对"此刻正在看"的人有意义，不进回放缓冲，否则刷新后会看到重复的半截文字
    if (msg.type !== 'delta' && msg.type !== 'delta_reset') {
      this.log.push(msg);
      if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
    }
    for (const fn of this.listeners) fn(msg);
  }

  respond(requestId: string, decision: ApprovalDecision, answers?: QuestionAnswers): boolean {
    if (answers && decision !== 'deny') this.answers.set(requestId, answers);
    const ok = this.handle.respond(requestId, decision, answers);
    if (!ok) this.answers.delete(requestId);
    return ok;
  }

  /** 适配器就位后调用一次：告诉网页能不能引导 */
  attach(handle: RunHandle): void {
    this.handle = handle;
    this.publishQueue();
  }

  /** 发一条消息：空闲就直接开始新的一轮；忙的时候按 mode 排队或引导 */
  send(text: string, attachments: Attachment[], mode: SendMode): void {
    if (this.state === 'exited') throw new Error('agent 进程已退出');
    if (this.state === 'idle' && !this.queue.length) {
      this.handle.send(text, attachments);
      return;
    }
    if (mode === 'steer' && this.canSteer()) {
      this.steerNow(text, attachments);
      return;
    }
    this.queue.push({ id: randomUUID(), text, attachments, at: new Date().toISOString() });
    this.publishQueue();
  }

  /** 把排队中的一条改成引导：马上插进正在进行的这一轮（已经空闲就直接发） */
  steerQueued(id: string): boolean {
    const item = this.take(id);
    if (!item) return false;
    if (this.state === 'idle') this.handle.send(item.text, item.attachments);
    else if (this.canSteer()) this.steerNow(item.text, item.attachments);
    else {
      this.queue.unshift(item);
      this.publishQueue();
      throw new Error(this.state === 'starting' ? '进程还在启动，稍后再引导' : '这个 agent 不支持在一轮进行中插入消息');
    }
    return true;
  }

  /** 撤回排队中的一条（网页把它放回输入框） */
  unqueue(id: string): QueuedMessage | undefined {
    const item = this.take(id);
    return item && publicQueued(item);
  }

  /** 打断时清空队列：排队的消息交还给网页放回输入框，不再自动发出 */
  takeQueue(): QueuedMessage[] {
    const items = this.queue.map(publicQueued);
    this.queue = [];
    if (items.length) this.publishQueue();
    return items;
  }

  private canSteer(): boolean {
    return this.state === 'running' && !!this.handle.steer;
  }

  /**
   * 引导时还有等审批 / 等回答的请求：先拒绝掉，agent 才会往下走、看到这条消息。
   * 相当于终端里「不批准，告诉它该怎么做」。
   */
  private steerNow(text: string, attachments: Attachment[]): void {
    for (const id of [...this.pending]) this.handle.respond(id, 'deny');
    this.handle.steer!(text, attachments);
  }

  private take(id: string): Queued | undefined {
    const i = this.queue.findIndex((q) => q.id === id);
    if (i < 0) return undefined;
    const [item] = this.queue.splice(i, 1);
    this.publishQueue();
    return item;
  }

  private drain(): void {
    if (this.state !== 'idle') return;
    const next = this.queue.shift();
    if (!next) return;
    this.publishQueue();
    try {
      this.handle.send(next.text, next.attachments);
    } catch {
      /* 进程刚好退出：exited 状态会随后到达 */
    }
  }

  /** 进程意外退出时还有排队的：留一条提示，免得用户以为发出去了 */
  private dropQueue(): void {
    const texts = this.queue.map((q) => `「${oneLine(q.text || q.attachments.map((a) => a.name).join('、'), 60)}」`);
    this.queue = [];
    this.publishQueue();
    this.push({
      type: 'event',
      event: {
        agent: this.agent,
        sessionId: this.sessionId,
        turn: 0,
        seq: 0,
        ts: new Date().toISOString(),
        uid: `queue-dropped:${randomUUID()}`,
        transient: true,
        item: { kind: 'notice', level: 'warn', code: 'queue_dropped', text: `进程已退出，${texts.length} 条排队的消息没有发出：${texts.join('')}` },
      },
    });
  }

  private publishQueue(): void {
    this.push({ type: 'queue', items: this.queue.map(publicQueued), steer: !!this.handle?.steer });
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
      queued: this.queue.length,
      error: this.error,
    };
  }
}

export interface StartOptions {
  adapter: AgentAdapter;
  binary?: string;
  cwd: string;
  prompt: string;
  attachments?: Attachment[];
  uploadsDir?: string;
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

    const handle = opts.adapter.run(
      {
        cwd: opts.cwd,
        prompt: opts.prompt,
        attachments: opts.attachments,
        uploadsDir: opts.uploadsDir,
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
    run.attach(handle);

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

  respond(id: string, requestId: string, decision: ApprovalDecision, answers?: QuestionAnswers): boolean {
    return this.runs.get(id)?.respond(requestId, decision, answers) ?? false;
  }

  stopAll(): void {
    for (const run of this.runs.values()) run.handle.stop();
  }
}

export type { Run };
