import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { oneLine, type ApprovalDecision, type EventWindow, type PermissionMode, type SessionSummary } from '@agentctl/core';
import {
  COOKIE_NAME,
  SESSION_TTL_MS,
  issueSession,
  verifyPassword,
  verifySession,
  type LoginThrottle,
} from './auth.ts';
import { expandHome, isPathAllowed, type Config } from './config.ts';
import type { Registry } from './registry.ts';
import type { RunInfo, RunManager } from './runs.ts';
import type { ShellKind, ShellManager } from './shells.ts';

export interface Ctx {
  cfg: Config;
  registry: Registry;
  runs: RunManager;
  shells: ShellManager;
  throttle: LoginThrottle;
  version: string;
  remote: boolean;
}

/** 无需鉴权即可访问的端点 */
const OPEN = new Set(['/api/health', '/api/auth/login', '/api/auth/me']);

const PERMISSION_MODES = new Set<PermissionMode>(['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions']);
const DECISIONS = new Set<ApprovalDecision>(['allow', 'allow_session', 'deny']);
/**
 * 模型值只经 argv 数组（不过 shell）或 JSON-RPC 参数传给 agent，所以不必限死字符集
 * （DSH 的模型值形如 ["deepseek-official","deepseek-flash"]）。要防的只有：
 * 以 - 开头会被 CLI 当成参数；控制字符与换行不该出现在模型名里。
 */
const MODEL_RE = /^[^-\s\p{Cc}][^\p{Cc}]{0,199}$/u;
const EFFORT_RE = /^[a-z]{2,12}$/;
const MAX_PROMPT_CHARS = 100_000;
/** 新会话要等 agent 分配 sessionId 才能跳转到会话页 */
const SESSION_ID_TIMEOUT_MS = 30_000;

class BadRequest extends Error {}

interface RunBody {
  model?: unknown;
  effort?: unknown;
  permissionMode?: unknown;
}

function modelOf(value: unknown): string {
  if (typeof value !== 'string' || !MODEL_RE.test(value)) throw new BadRequest('model 不合法');
  return value;
}

function modeOf(value: unknown, cfg: Config): PermissionMode {
  if (!PERMISSION_MODES.has(value as PermissionMode)) {
    throw new BadRequest('permissionMode 只能是 default / acceptEdits / auto / plan / bypassPermissions');
  }
  if (value === 'bypassPermissions' && !cfg.allowBypassPermissions) {
    throw new BadRequest('服务端配置禁止了 bypassPermissions（allowBypassPermissions: false）');
  }
  return value as PermissionMode;
}

/** AskUserQuestion 的回答：{ 问题: 答案 }，只收字符串 */
function answersOf(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequest('answers 必须是对象');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string' || k.length > 2000 || v.length > 10_000) throw new BadRequest('answers 格式不合法');
    out[k] = v;
  }
  return out;
}

function runOptions(body: RunBody, cfg: Config): { model?: string; effort?: string; permissionMode?: PermissionMode } {
  const out: { model?: string; effort?: string; permissionMode?: PermissionMode } = {};
  if (body.model !== undefined && body.model !== '') out.model = modelOf(body.model);
  if (body.effort !== undefined && body.effort !== '') {
    if (typeof body.effort !== 'string' || !EFFORT_RE.test(body.effort)) throw new BadRequest('effort 不合法');
    out.effort = body.effort;
  }
  if (body.permissionMode !== undefined && body.permissionMode !== '') {
    out.permissionMode = modeOf(body.permissionMode, cfg);
  }
  return out;
}

function promptOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequest('消息不能为空');
  if (value.length > MAX_PROMPT_CHARS) throw new BadRequest(`消息过长（上限 ${MAX_PROMPT_CHARS} 字符）`);
  return value;
}

/** 工作目录：绝对路径、真实存在、解开符号链接后仍在白名单内 */
async function checkedCwd(cfg: Config, raw: unknown): Promise<string> {
  if (typeof raw !== 'string' || !raw.trim()) throw new BadRequest('缺少工作目录');
  const expanded = expandHome(raw.trim());
  if (!isAbsolute(expanded)) throw new BadRequest('工作目录必须是绝对路径');
  let real: string;
  try {
    real = await realpath(expanded);
    if (!(await stat(real)).isDirectory()) throw new Error();
  } catch {
    throw new BadRequest(`目录不存在：${raw}`);
  }
  if (!isPathAllowed(cfg, real)) throw new BadRequest('该目录不在 allowedRoots 白名单内');
  return real;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** 新会话刚起、文件还没被扫到时，用运行信息顶一个摘要，会话页不至于 404 */
function placeholderSummary(run: RunInfo): SessionSummary {
  const sessionId = run.sessionKey?.split(':')[1] ?? '';
  return {
    id: run.sessionKey ?? '',
    agent: run.agent,
    sessionId,
    cwd: run.cwd,
    file: '',
    title: run.title,
    model: run.model,
    turns: 0,
    sizeBytes: 0,
    mtime: Date.parse(run.startedAt),
    updatedAt: run.startedAt,
  };
}

const EMPTY_WINDOW: EventWindow = { events: [], nextBefore: null, hasMore: false, window: { start: 0, end: 0 } };

export async function registerRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { cfg, registry, runs, shells, throttle } = ctx;
  const authRequired = !!cfg.password;

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof BadRequest) return reply.code(400).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.code(500).send({ error: err.message || '服务器内部错误' });
  });

  // 写操作的跨站防护：cookie 是 SameSite=Lax，再加一道 Origin 必须同源。
  // 能驱动 agent 执行命令的接口，被别的网页借用 cookie 发一个 POST 就是远程代码执行。
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const origin = req.headers.origin;
    if (!origin) return;
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      /* 非法 Origin 按跨站处理 */
    }
    if (host !== req.host) return reply.code(403).send({ error: '拒绝跨站请求' });
  });

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/')) return;
    if (OPEN.has(path)) return;
    if (!authRequired) return;
    if (verifySession(req.cookies[COOKIE_NAME], cfg.secret)) return;
    return reply.code(401).send({ error: 'unauthorized' });
  });

  app.get('/api/health', async () => ({
    ok: true,
    version: ctx.version,
    authRequired,
    remote: ctx.remote,
    allowBypass: cfg.allowBypassPermissions,
  }));

  app.get('/api/auth/me', async (req) => ({
    authRequired,
    authenticated: !authRequired || verifySession(req.cookies[COOKIE_NAME], cfg.secret),
  }));

  app.post('/api/auth/login', async (req, reply) => {
    if (!authRequired) return { ok: true };
    const ip = req.ip;
    if (throttle.blocked(ip)) {
      return reply.code(429).send({ error: '尝试次数过多，请 5 分钟后再试' });
    }
    const body = (req.body ?? {}) as { password?: unknown };
    const password = typeof body.password === 'string' ? body.password : '';
    if (!verifyPassword(password, cfg.password)) {
      throttle.fail(ip);
      return reply.code(401).send({ error: '密码不正确' });
    }
    throttle.reset(ip);
    reply.setCookie(COOKIE_NAME, issueSession(cfg.secret), {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: cfg.cookieSecure,
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: '/' });
    return { ok: true };
  });

  app.get('/api/agents', async () => ({
    agents: await registry.agents(),
    stats: registry.stats(),
  }));

  app.get('/api/sessions', async (req) => {
    const q = req.query as { refresh?: string; agent?: string; q?: string };
    const live = runs.list();
    let sessions = await registry.list(q.refresh === '1');
    // 刚从网页新建的会话：文件已经落盘但缓存还没扫到，补扫一次
    if (live.some((r) => r.sessionKey && !sessions.some((s) => s.id === r.sessionKey))) {
      sessions = await registry.list(true);
    }
    const filtered = sessions.filter((s) => {
      if (q.agent && s.agent !== q.agent) return false;
      if (q.q) {
        const needle = q.q.toLowerCase();
        const hay = `${s.title} ${s.cwd} ${s.preview ?? ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    return { sessions: filtered, stats: registry.stats(), runs: live };
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = runs.forSession(id)?.info();
    const session = (await registry.get(id)) ?? (run ? placeholderSummary(run) : undefined);
    if (!session) return reply.code(404).send({ error: '会话不存在' });
    const adapter = registry.adapter(session.agent);
    const openShells = shells.list().filter((sh) => sh.key.startsWith(`${id}:`) && !sh.exited);
    return { session, run, canRun: !!adapter?.run, shells: openShells };
  });

  app.get('/api/sessions/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { before?: string; after?: string; maxBytes?: string };
    // 增量：从上次窗口末尾读到文件末尾。会话页每隔两秒问一次，文件没变时只是一次 stat
    if (q.after !== undefined) {
      const after = Number(q.after);
      if (!Number.isInteger(after) || after < 0) return reply.code(400).send({ error: 'after 必须是非负整数字节偏移' });
      const session = await registry.get(id);
      if (!session?.file) {
        if (runs.forSession(id)) return { ...EMPTY_WINDOW, window: { start: after, end: after } };
        return reply.code(404).send({ error: '会话不存在' });
      }
      const adapter = registry.adapter(session.agent);
      if (!adapter?.replayAfter) return reply.code(400).send({ error: '该 agent 不支持增量读取' });
      const size = adapter.contentLength ? await adapter.contentLength(session) : (await stat(session.file)).size;
      if (size < after) return reply.code(409).send({ error: '会话文件被截断或替换，请刷新页面' });
      if (size === after) return { ...EMPTY_WINDOW, window: { start: after, end: after } };
      return adapter.replayAfter(session, after);
    }
    const before = q.before ? Number(q.before) : undefined;
    const maxBytes = q.maxBytes ? Number(q.maxBytes) : undefined;
    if (before !== undefined && (!Number.isFinite(before) || before < 0)) {
      return reply.code(400).send({ error: 'before 必须是正整数字节偏移' });
    }
    const window = await registry.events(id, {
      before,
      maxBytes: maxBytes && maxBytes > 0 ? Math.min(maxBytes, 16 * 1024 * 1024) : undefined,
    });
    if (!window) {
      if (runs.forSession(id)) return EMPTY_WINDOW;
      return reply.code(404).send({ error: '会话不存在' });
    }
    return window;
  });

  /* ── 实时运行 ─────────────────────────────────────────── */

  app.get('/api/runs', async () => ({ runs: runs.list() }));

  /* ── Shell 模式（WebSocket） ───────────────────────────── */

  app.get('/api/shells', async () => ({ shells: shells.list() }));

  app.get('/api/sessions/:id/shell', { websocket: true }, async (socket, req) => {
    const send = (msg: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const fail = (message: string) => {
      send({ type: 'error', message });
      socket.close();
    };

    // 浏览器跨站发起的 WebSocket 也会带上 cookie；这是一个能执行任意命令的终端，必须同源
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try {
        host = new URL(origin).host;
      } catch {
        /* 非法 Origin 按跨站处理 */
      }
      if (host !== req.host) return fail('拒绝跨站连接');
    }

    const { id } = req.params as { id: string };
    const q = req.query as { kind?: string; cols?: string; rows?: string };
    const kind: ShellKind = q.kind === 'shell' ? 'shell' : 'agent';
    const cols = Math.min(Math.max(Number(q.cols) || 100, 20), 500);
    const rows = Math.min(Math.max(Number(q.rows) || 30, 5), 200);

    const session = await registry.get(id);
    if (!session) return fail('会话不存在');
    let cwd: string;
    try {
      cwd = await checkedCwd(cfg, session.cwd);
    } catch (err) {
      return fail((err as Error).message);
    }

    const key = `${id}:${kind}`;
    let file: string;
    let args: string[];
    if (kind === 'agent') {
      const adapter = registry.adapter(session.agent);
      const binary = adapter ? await registry.binaryOf(adapter) : undefined;
      if (!binary) return fail(`找不到 ${adapter?.meta.binary ?? session.agent} 可执行文件`);
      const active = runs.forSession(id);
      if (!shells.get(key) && active && active.state !== 'exited') {
        return fail('这个会话正在网页里运行（输入框那边的进程）。先点「结束进程」，再打开终端，免得两个进程同时写同一个会话');
      }
      if (!adapter?.resumeArgs) return fail(`${adapter?.meta.name ?? session.agent} 不支持在终端里续接`);
      file = binary;
      args = adapter.resumeArgs(session);
    } else {
      file = process.env.SHELL || '/bin/bash';
      args = ['-l'];
    }

    const shell = shells.open({ key, kind, file, args, cwd, title: session.title, cols, rows });
    send({ type: 'ready', shell: shell.info() });
    const detach = shell.attach(send);

    socket.on('message', (raw: Buffer) => {
      let msg: { type?: string; data?: unknown; cols?: unknown; rows?: unknown };
      try {
        msg = JSON.parse(raw.toString('utf8')) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === 'input' && typeof msg.data === 'string') shell.write(msg.data);
      else if (msg.type === 'resize') shell.resize(Number(msg.cols) || cols, Number(msg.rows) || rows);
      else if (msg.type === 'kill') shell.kill();
    });
    socket.on('close', detach);
  });

  app.get('/api/agents/:id/models', async (req, reply) => {
    const adapter = registry.adapter((req.params as { id: string }).id);
    if (!adapter?.models) return { models: [] };
    try {
      return { models: await adapter.models(await registry.binaryOf(adapter)) };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  // 运行中切换权限模式：同样不重启进程
  app.post('/api/runs/:id/permission-mode', async (req, reply) => {
    const run = runs.get((req.params as { id: string }).id);
    if (!run || run.state === 'exited') return reply.code(404).send({ error: '运行不存在或已结束' });
    if (!run.handle.setPermissionMode) return reply.code(400).send({ error: '该 agent 不支持运行中切换权限模式' });
    const mode = modeOf((req.body as { mode?: unknown } | undefined)?.mode, cfg);
    return { mode: await run.handle.setPermissionMode(mode) };
  });

  // 运行中切换模型：不重启进程，下一次请求起生效
  app.post('/api/runs/:id/model', async (req, reply) => {
    const run = runs.get((req.params as { id: string }).id);
    if (!run || run.state === 'exited') return reply.code(404).send({ error: '运行不存在或已结束' });
    if (!run.handle.setModel) return reply.code(400).send({ error: '该 agent 不支持运行中切换模型' });
    const model = modelOf((req.body as { model?: unknown } | undefined)?.model);
    const resolved = await run.handle.setModel(model);
    run.model = model;
    return { model, resolved };
  });

  // 新建会话
  app.post('/api/runs', async (req, reply) => {
    const body = (req.body ?? {}) as RunBody & { agent?: unknown; cwd?: unknown; prompt?: unknown };
    const agentId = typeof body.agent === 'string' ? body.agent : 'claude';
    const adapter = registry.adapter(agentId);
    if (!adapter?.run) return reply.code(400).send({ error: `${agentId} 尚未支持实时运行` });
    const binary = await registry.binaryOf(adapter);
    if (adapter.meta.binary && !binary) {
      return reply.code(400).send({ error: `找不到 ${adapter.meta.binary} 可执行文件` });
    }
    const prompt = promptOf(body.prompt);
    const cwd = await checkedCwd(cfg, body.cwd);
    const run = runs.start({ adapter, binary, cwd, prompt, title: oneLine(prompt, 80), ...runOptions(body, cfg), allowBypass: cfg.allowBypassPermissions });
    try {
      await withTimeout(run.handle.sessionId, SESSION_ID_TIMEOUT_MS, 'agent 启动超时');
    } catch (err) {
      run.handle.stop();
      return reply.code(502).send({ error: (err as Error).message });
    }
    registry.invalidate();
    return { run: run.info() };
  });

  // 往已有会话发消息：有活着的进程就直接写 stdin，否则 --resume 起一个
  app.post('/api/sessions/:id/send', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as RunBody & { text?: unknown };
    const text = promptOf(body.text);
    if (shells.get(`${id}:agent`)) {
      return reply.code(409).send({ error: '这个会话正在网页终端里运行 claude，先在终端里退出（/exit）再在这里发消息' });
    }
    const active = runs.forSession(id);
    if (active && active.state !== 'exited') {
      active.handle.send(text);
      return { run: active.info() };
    }

    const session = await registry.get(id);
    if (!session) return reply.code(404).send({ error: '会话不存在' });
    const adapter = registry.adapter(session.agent);
    if (!adapter?.run) return reply.code(400).send({ error: `${adapter?.meta.name ?? session.agent} 尚未支持实时运行` });
    const binary = await registry.binaryOf(adapter);
    if (adapter.meta.binary && !binary) {
      return reply.code(400).send({ error: `找不到 ${adapter.meta.binary} 可执行文件` });
    }
    const cwd = await checkedCwd(cfg, session.cwd);
    const run = runs.start({
      adapter,
      binary,
      cwd,
      prompt: text,
      title: session.title,
      resumeSessionId: session.sessionId,
      startTurn: session.turns,
      ...runOptions(body, cfg),
      allowBypass: cfg.allowBypassPermissions,
    });
    return { run: run.info() };
  });

  // 实时事件：SSE。比 WebSocket 少一个依赖，自动重连，反代也友好；上行走普通 POST
  app.get('/api/runs/:id/stream', (req, reply) => {
    const { id } = req.params as { id: string };
    const run = runs.get(id);
    if (!run) return reply.code(404).send({ error: '运行不存在或已过期' });

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      unsubscribe();
      res.end();
    };
    const unsubscribe = run.subscribe((msg) => {
      if (closed) return;
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
      // 进程结束后关流；客户端看到 exited 不再重连
      if (msg.type === 'state' && msg.state === 'exited') setImmediate(close);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.raw.on('close', close);
  });

  app.post('/api/runs/:id/approve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { requestId?: unknown; decision?: unknown; answers?: unknown };
    if (typeof body.requestId !== 'string' || !DECISIONS.has(body.decision as ApprovalDecision)) {
      return reply.code(400).send({ error: '需要 requestId 与 decision（allow / allow_session / deny）' });
    }
    if (!runs.respond(id, body.requestId, body.decision as ApprovalDecision, answersOf(body.answers))) {
      return reply.code(409).send({ error: '这条审批已经处理过或已失效' });
    }
    return { ok: true };
  });

  app.post('/api/runs/:id/interrupt', async (req, reply) => {
    const run = runs.get((req.params as { id: string }).id);
    if (!run || run.state === 'exited') return reply.code(404).send({ error: '运行不存在或已结束' });
    run.handle.interrupt();
    return { ok: true };
  });

  app.post('/api/runs/:id/stop', async (req, reply) => {
    const run = runs.get((req.params as { id: string }).id);
    if (!run) return reply.code(404).send({ error: '运行不存在' });
    run.handle.stop();
    return { ok: true };
  });
}
