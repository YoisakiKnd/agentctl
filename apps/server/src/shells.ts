import { randomUUID } from 'node:crypto';
import pty, { type IPty } from 'node-pty';

/**
 * Shell 模式：网页里的真终端（node-pty + xterm.js）。
 *
 * headless 模式永远比 TUI 少功能（斜杠命令、交互式确认、/model 菜单……），
 * 所以每个会话都能一键打开真正的 `claude --resume <id>`，或者在会话目录里开一个普通 shell。
 *
 * 终端不跟着 WebSocket 生死：刷新页面、手机切后台、换设备都能重新接上，
 * 接上时先回放最近的输出。没人连着超过 IDLE_KILL_MS 才结束。
 */

export type ShellKind = 'agent' | 'shell';

export interface ShellInfo {
  id: string;
  key: string;
  kind: ShellKind;
  cwd: string;
  title: string;
  startedAt: string;
  clients: number;
  exited: boolean;
  exitCode?: number;
}

type ShellMessage = { type: 'output'; data: string } | { type: 'exit'; code: number };
type Client = (msg: ShellMessage) => void;

/** 重连回放的输出上限（字符数）；够还原一屏 TUI 加一段滚动历史 */
const SCROLLBACK = 256 * 1024;
const IDLE_KILL_MS = 30 * 60_000;

class Shell {
  readonly id = randomUUID();
  readonly startedAt = new Date().toISOString();
  readonly key: string;
  readonly kind: ShellKind;
  readonly cwd: string;
  readonly title: string;
  readonly pty: IPty;
  exited = false;
  exitCode?: number;
  private buffer = '';
  private readonly clients = new Set<Client>();
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly onGone: () => void;

  constructor(opts: SpawnOptions, onGone: () => void) {
    this.key = opts.key;
    this.kind = opts.kind;
    this.cwd = opts.cwd;
    this.title = opts.title;
    this.onGone = onGone;
    this.pty = pty.spawn(opts.file, opts.args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>,
    });
    this.pty.onData((data) => {
      this.buffer += data;
      if (this.buffer.length > SCROLLBACK) this.buffer = this.buffer.slice(-SCROLLBACK);
      for (const c of this.clients) c({ type: 'output', data });
    });
    this.pty.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode;
      clearTimeout(this.idleTimer);
      for (const c of this.clients) c({ type: 'exit', code: exitCode });
      // 留一会儿让还连着的页面看到退出码，再从表里摘掉
      setTimeout(this.onGone, 5000).unref();
    });
    this.armIdle();
  }

  attach(client: Client): () => void {
    if (this.buffer) client({ type: 'output', data: this.buffer });
    if (this.exited) client({ type: 'exit', code: this.exitCode ?? 0 });
    this.clients.add(client);
    clearTimeout(this.idleTimer);
    return () => {
      this.clients.delete(client);
      this.armIdle();
    };
  }

  write(data: string): void {
    if (!this.exited) this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    try {
      this.pty.resize(cols, rows);
    } catch {
      /* 进程刚好退出时 resize 会抛，忽略 */
    }
  }

  kill(): void {
    if (!this.exited) this.pty.kill('SIGHUP');
  }

  info(): ShellInfo {
    return {
      id: this.id,
      key: this.key,
      kind: this.kind,
      cwd: this.cwd,
      title: this.title,
      startedAt: this.startedAt,
      clients: this.clients.size,
      exited: this.exited,
      exitCode: this.exitCode,
    };
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    if (this.clients.size === 0 && !this.exited) {
      this.idleTimer = setTimeout(() => this.kill(), IDLE_KILL_MS);
      this.idleTimer.unref();
    }
  }
}

export interface SpawnOptions {
  /** 同一个 key 只会有一个活着的终端（`${sessionKey}:${kind}`） */
  key: string;
  kind: ShellKind;
  file: string;
  args: string[];
  cwd: string;
  title: string;
  cols: number;
  rows: number;
}

export class ShellManager {
  private readonly shells = new Map<string, Shell>();

  /** 有活着的就复用（重连），没有才新开 */
  open(opts: SpawnOptions): Shell {
    const existing = this.shells.get(opts.key);
    if (existing && !existing.exited) return existing;
    const shell: Shell = new Shell(opts, () => {
      if (this.shells.get(opts.key) === shell) this.shells.delete(opts.key);
    });
    this.shells.set(opts.key, shell);
    return shell;
  }

  get(key: string): Shell | undefined {
    const s = this.shells.get(key);
    return s && !s.exited ? s : undefined;
  }

  list(): ShellInfo[] {
    return [...this.shells.values()].map((s) => s.info());
  }

  killAll(): void {
    for (const s of this.shells.values()) s.kill();
  }
}

export type { Shell };
