import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { HOME, expandHome, isPathAllowed, type Config } from './config.ts';

/**
 * 新建会话时的「工作区」：浏览服务器上的目录、按名字新建项目、从 Git 仓库克隆。
 * 新建和克隆都放在工作区根目录下（网页上可以改，默认 ~/Codes 这类常见目录）。
 */

export class WorkspaceError extends Error {
  readonly statusCode = 400;
}

/** 没选过根目录时，依次找这些常见的代码目录，都没有就用家目录 */
const ROOT_GUESSES = ['Codes', 'Code', 'code', 'Projects', 'projects', 'src', 'dev', 'workspace'];

export function defaultRoot(cfg: Config): string {
  const first = cfg.allowedRoots[0];
  if (first) return expandHome(first);
  for (const name of ROOT_GUESSES) {
    const p = join(HOME, name);
    if (existsSync(p)) return p;
  }
  return HOME;
}

export interface DirEntry {
  name: string;
  path: string;
  /** 是 git 仓库（有 .git） */
  git: boolean;
}

export interface DirListing {
  path: string;
  /** 能往上走时给出（白名单之外的不给） */
  parent?: string;
  git: boolean;
  entries: DirEntry[];
  /** 子目录太多只列了前面这些 */
  truncated: boolean;
}

const LIST_LIMIT = 1000;

async function isDir(p: string): Promise<boolean> {
  return (await stat(p).catch(() => null))?.isDirectory() ?? false;
}

/** 列出一个目录下的子目录（只列目录；默认不列隐藏目录） */
export async function listDir(cfg: Config, raw: string, hidden: boolean): Promise<DirListing> {
  const path = expandHome(raw.trim()).replace(/(.)\/+$/, '$1');
  if (!isAbsolute(path)) throw new WorkspaceError('路径必须是绝对路径');
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new WorkspaceError(`目录不存在：${path}`);
  }
  if (!(await isDir(real))) throw new WorkspaceError(`不是目录：${path}`);
  if (!isPathAllowed(cfg, real)) throw new WorkspaceError('该目录不在 allowedRoots 白名单内');
  let names: string[];
  try {
    names = (await readdir(real, { withFileTypes: true }))
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
      .filter((n) => hidden || !n.startsWith('.'));
  } catch (err) {
    throw new WorkspaceError(`读不了这个目录：${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
  names.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' }));
  const truncated = names.length > LIST_LIMIT;
  const entries = (
    await Promise.all(
      names.slice(0, LIST_LIMIT).map(async (name) => {
        const p = join(real, name);
        // 指向文件的符号链接、断掉的链接不列
        if (!(await isDir(p))) return null;
        return { name, path: p, git: existsSync(join(p, '.git')) };
      }),
    )
  ).filter((e): e is DirEntry => !!e);
  const up = dirname(real);
  return {
    path: real,
    parent: up !== real && isPathAllowed(cfg, up) ? up : undefined,
    git: existsSync(join(real, '.git')),
    entries,
    truncated,
  };
}

/** 项目名 / 文件夹名：不能带路径分隔符，不能是 . 或 ..，不以 - 开头（免得被当成命令行参数） */
export function checkName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new WorkspaceError('缺少名字');
  if (name.length > 100) throw new WorkspaceError('名字太长了');
  if (/[\\/\u0000-\u001f]/.test(name) || name === '.' || name === '..' || name.startsWith('-')) {
    throw new WorkspaceError('名字里不能有 / \\ 这类字符，也不能以 - 开头');
  }
  return name;
}

/** 在 parent 下新建一个子目录；parent 必须存在且在白名单内，子目录不能已存在 */
export async function makeChild(cfg: Config, parentRaw: string, rawName: unknown): Promise<string> {
  const name = checkName(rawName);
  let parent: string;
  try {
    parent = await realpath(expandHome(parentRaw));
  } catch {
    throw new WorkspaceError(`目录不存在：${parentRaw}`);
  }
  if (!(await isDir(parent))) throw new WorkspaceError(`不是目录：${parentRaw}`);
  const path = join(parent, name);
  if (!isPathAllowed(cfg, path)) throw new WorkspaceError('该目录不在 allowedRoots 白名单内');
  if (existsSync(path)) throw new WorkspaceError(`已经有 ${name} 了`);
  try {
    await mkdir(path, { mode: 0o755 });
  } catch (err) {
    throw new WorkspaceError(`新建失败：${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
  return path;
}

export function gitInit(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', ['init', '--quiet'], { cwd: path, timeout: 20_000 }, (err, _out, stderr) => {
      if (err) reject(new WorkspaceError(`git init 失败：${stderr.trim() || err.message}`));
      else resolve();
    });
  });
}

/* ── 克隆 ─────────────────────────────────────────────────── */

/**
 * 只收常见的远程地址：https / http / ssh:// / scp 风格（git@host:path）。
 * 不收 file://、ext:: 之类，也不收以 - 开头的（会被 git 当成选项）。
 */
const URL_RE = /^(?:https?:\/\/[^\s/]+\/\S+|ssh:\/\/\S+|[\w.-]+@[\w.-]+:[^\s-]\S*)$/;

export function checkRepoUrl(raw: unknown): string {
  const url = typeof raw === 'string' ? raw.trim() : '';
  if (!URL_RE.test(url)) throw new WorkspaceError('仓库地址不对：支持 https://… 、ssh://… 或 git@host:owner/repo');
  return url;
}

/** 从仓库地址推出文件夹名：…/owner/repo(.git) → repo */
export function repoName(url: string): string {
  const last = basename(url.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/^.*:/, (m) => (m.includes('/') ? m : '')));
  const name = last.replace(/\.git$/, '').replace(/[^\w.-]/g, '-');
  return name && name !== '.' && name !== '..' && !name.startsWith('-') ? name : 'repo';
}

export interface CloneJob {
  id: string;
  url: string;
  path: string;
  state: 'running' | 'done' | 'error';
  /** git 打出来的最后一行进度（Receiving objects: 45% …） */
  progress: string;
  error?: string;
}

const CLONE_TIMEOUT_MS = 15 * 60_000;
/** 结束的任务留一会儿，网页轮询能拿到结果 */
const JOB_KEEP_MS = 30 * 60_000;

/**
 * 克隆放在后台跑、网页轮询：大仓库要几分钟，而 Cloudflare 这类反代 100 秒就会掐断一个请求。
 * 远端要密码时不弹交互（GIT_TERMINAL_PROMPT=0、ssh BatchMode），直接失败给出原因。
 */
export class CloneJobs {
  private readonly jobs = new Map<string, CloneJob>();

  get(id: string): CloneJob | undefined {
    return this.jobs.get(id);
  }

  async start(cfg: Config, rootRaw: string, rawUrl: unknown, rawName: unknown): Promise<CloneJob> {
    const url = checkRepoUrl(rawUrl);
    const name = rawName === undefined || rawName === '' ? repoName(url) : checkName(rawName);
    let root: string;
    try {
      root = await realpath(expandHome(rootRaw));
    } catch {
      throw new WorkspaceError(`工作区目录不存在：${rootRaw}`);
    }
    const path = join(root, name);
    if (!isPathAllowed(cfg, path)) throw new WorkspaceError('该目录不在 allowedRoots 白名单内');
    if (existsSync(path)) throw new WorkspaceError(`${path} 已经存在，换个文件夹名`);
    for (const j of this.jobs.values()) {
      if (j.state === 'running' && j.path === path) throw new WorkspaceError('这个位置正在克隆');
    }

    const job: CloneJob = { id: randomUUID(), url, path, state: 'running', progress: '' };
    this.jobs.set(job.id, job);
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    env.GIT_SSH_COMMAND ??= 'ssh -o BatchMode=yes';
    const child = spawn('git', ['clone', '--progress', '--', url, path], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    child.stderr.on('data', (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8')).slice(-4000);
      // 进度行用 \r 覆盖刷新，取最后一段非空的
      const lines = tail.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
      job.progress = lines.at(-1) ?? '';
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), CLONE_TIMEOUT_MS);
    const finish = (error?: string) => {
      clearTimeout(timer);
      if (job.state !== 'running') return;
      job.state = error ? 'error' : 'done';
      job.error = error;
      setTimeout(() => this.jobs.delete(job.id), JOB_KEEP_MS).unref();
    };
    child.on('error', (err) => finish(`跑不起来 git：${err.message}`));
    child.on('exit', (code, signal) => {
      if (code === 0) return finish();
      const lines = tail.split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l && !/^(Cloning into|remote: (Counting|Compressing|Enumerating)|Receiving|Resolving)/.test(l));
      finish(signal ? '克隆超时，已停止' : lines.slice(-3).join('\n') || `git clone 退出码 ${code}`);
    });
    return job;
  }
}
