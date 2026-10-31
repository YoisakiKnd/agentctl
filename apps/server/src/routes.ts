import { createReadStream } from 'node:fs';
import { access, constants, mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { oneLine, searchQuery, type ApprovalDecision, type Attachment, type EventWindow, type PermissionMode, type QuestionAnswers, type SearchHit, type SessionSummary } from '@agentctl/core';
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
import type { RunPrefs } from './db.ts';
import type { RunInfo, RunManager, SendMode } from './runs.ts';
import type { ShellKind, ShellManager } from './shells.ts';
import { usageReport } from './usage.ts';
import type { QuotaService } from './quota.ts';
import { CHANNEL_FIELDS, EVENTS, maskConfig, type NotifyService } from './notify.ts';
import { MAX_UPLOAD_BYTES, UPLOADS_DIR, findUpload, resolveAttachments, saveUpload } from './uploads.ts';

export interface Ctx {
  cfg: Config;
  registry: Registry;
  runs: RunManager;
  shells: ShellManager;
  quota: QuotaService;
  notify: NotifyService;
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

/** 提问的回答：{ 问题: [答案…] }；单个字符串也收（当作一个答案） */
function answersOf(value: unknown): QuestionAnswers | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequest('answers 必须是对象');
  const out: QuestionAnswers = {};
  for (const [k, v] of Object.entries(value)) {
    const list = typeof v === 'string' ? [v] : v;
    if (!Array.isArray(list) || k.length > 2000 || list.length > 50 || list.some((a) => typeof a !== 'string' || a.length > 10_000)) {
      throw new BadRequest('answers 格式不合法');
    }
    out[k] = list as string[];
  }
  return out;
}

function sendModeOf(value: unknown): SendMode {
  if (value === undefined || value === 'queue') return 'queue';
  if (value === 'steer') return 'steer';
  throw new BadRequest('mode 只能是 queue 或 steer');
}

const SHELL_HEARTBEAT_MS = 20_000;
const clampCols = (v: unknown) => Math.min(Math.max(Number(v) || 100, 20), 500);
const clampRows = (v: unknown) => Math.min(Math.max(Number(v) || 30, 5), 200);

const MAX_TAGS = 12;

/** 标签：去首尾空白、去重，单个不超过 32 字，不含逗号（前端用逗号分隔输入） */
function tagsOf(value: unknown): string[] {
  if (!Array.isArray(value)) throw new BadRequest('tags 必须是字符串数组');
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') throw new BadRequest('tags 必须是字符串数组');
    const t = v.replace(/[\p{Cc},，]/gu, ' ').trim();
    if (!t) continue;
    if (t.length > 32) throw new BadRequest('单个标签不能超过 32 个字');
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > MAX_TAGS) throw new BadRequest(`最多 ${MAX_TAGS} 个标签`);
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

/**
 * 请求里没带的选项沿用会话上次的（刷新、换设备、进程退出后再发消息，模式都不变）；
 * 带了就以请求为准，'default' / 空串表示明确回到默认。
 * 服务端后来禁用了 bypass 的话，存着的 bypass 不再生效。
 */
function effectiveOptions(body: RunBody, prefs: RunPrefs, cfg: Config) {
  const pick = (k: keyof RunBody & keyof RunPrefs) => (body[k] !== undefined ? body[k] : prefs[k]);
  let permissionMode = pick('permissionMode');
  if (permissionMode === 'bypassPermissions' && !cfg.allowBypassPermissions && body.permissionMode === undefined) permissionMode = undefined;
  const opts = runOptions({ model: pick('model'), effort: pick('effort'), permissionMode }, cfg);
  if (opts.model === 'default') delete opts.model;
  return opts;
}

/** 文字和附件至少有一样；只有附件时文字为空串，适配器会只发附件清单 */
async function messageOf(text: unknown, rawAttachments: unknown): Promise<{ text: string; attachments: Attachment[] }> {
  let attachments: Attachment[];
  try {
    attachments = await resolveAttachments(rawAttachments);
  } catch (err) {
    throw new BadRequest((err as Error).message);
  }
  if (text !== undefined && typeof text !== 'string') throw new BadRequest('消息必须是文字');
  const value = text ?? '';
  if (!value.trim() && !attachments.length) throw new BadRequest('消息不能为空');
  if (value.length > MAX_PROMPT_CHARS) throw new BadRequest(`消息过长（上限 ${MAX_PROMPT_CHARS} 字符）`);
  return { text: value.trim() ? value : '', attachments };
}

/** 运行的标题：文字的第一行；只有附件时用附件名 */
function titleOf(text: string, attachments: Attachment[]): string {
  return oneLine(text, 80) || oneLine(attachments.map((a) => a.name).join('、'), 80);
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

interface DirInfo {
  /** 展开 ~ 之后的绝对路径 */
  path: string;
  exists: boolean;
  /** 不存在时：能不能新建（最近的已存在祖先是目录，且解开符号链接后仍在白名单内） */
  creatable: boolean;
  error?: string;
}

/** 看一个工作目录：存不存在、能不能新建。不改任何东西 */
async function inspectDir(cfg: Config, raw: unknown): Promise<DirInfo> {
  if (typeof raw !== 'string' || !raw.trim()) return { path: '', exists: false, creatable: false, error: '缺少工作目录' };
  const path = expandHome(raw.trim()).replace(/\/+$/, '') || '/';
  if (!isAbsolute(path)) return { path, exists: false, creatable: false, error: '工作目录必须是绝对路径' };
  try {
    const real = await realpath(path);
    if (!(await stat(real)).isDirectory()) return { path, exists: false, creatable: false, error: '这个路径是文件，不是目录' };
    if (!isPathAllowed(cfg, real)) return { path, exists: true, creatable: false, error: '该目录不在 allowedRoots 白名单内' };
    return { path, exists: true, creatable: false };
  } catch {
    /* 不存在：往上找最近的已存在祖先 */
  }
  let parent = dirname(path);
  while (parent !== dirname(parent)) {
    try {
      await stat(parent);
      break;
    } catch {
      parent = dirname(parent);
    }
  }
  try {
    const real = await realpath(parent);
    if (!(await stat(real)).isDirectory()) return { path, exists: false, creatable: false, error: `${parent} 不是目录` };
    // 按解开符号链接后的真实位置判断白名单，防止借符号链接把目录建到白名单外
    if (!isPathAllowed(cfg, join(real, relative(parent, path)))) {
      return { path, exists: false, creatable: false, error: '该目录不在 allowedRoots 白名单内' };
    }
    // 服务进程没有写权限的地方（/proc、别人的目录）建不了
    try {
      await access(real, constants.W_OK);
    } catch {
      return { path, exists: false, creatable: false, error: `没有权限在 ${parent} 下新建目录` };
    }
    return { path, exists: false, creatable: true };
  } catch {
    return { path, exists: false, creatable: false, error: `目录不存在：${raw}` };
  }
}

/** 新建工作目录（含中间目录）；只在用户确认过的新建会话请求里调用 */
async function createDir(cfg: Config, raw: unknown): Promise<void> {
  const info = await inspectDir(cfg, raw);
  if (info.exists) return;
  if (!info.creatable) throw new BadRequest(info.error ?? '不能在这里新建目录');
  try {
    await mkdir(info.path, { recursive: true, mode: 0o755 });
  } catch (err) {
    throw new BadRequest(`新建目录失败：${(err as Error).message}`);
  }
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

const SEARCH_MAX_HITS = 200;
const SEARCH_PER_SESSION = 20;
const SEARCH_BUDGET_MS = 15_000;

const EMPTY_WINDOW: EventWindow = { events: [], nextBefore: null, hasMore: false, window: { start: 0, end: 0 } };

export async function registerRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { cfg, registry, runs, shells, throttle } = ctx;
  const authRequired = !!cfg.password;

  /** 进程报出的模型列表记下来，给下次进程不在时的下拉框用 */
  const rememberRunModels = (run: ReturnType<RunManager['start']>) => {
    const agent = run.info().agent;
    run.subscribe((msg) => {
      if (msg.type === 'config' && msg.models?.length) registry.rememberModels(agent, msg.models);
    });
  };

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
        const hay = `${s.title} ${s.cwd} ${s.preview ?? ''} ${(s.tags ?? []).join(' ')}`.toLowerCase();
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
    const raw = registry.prefs(session);
    const prefs = raw.permissionMode === 'bypassPermissions' && !cfg.allowBypassPermissions ? { ...raw, permissionMode: undefined } : raw;
    return { session, run, prefs, canRun: !!adapter?.run, canResumeInTerminal: !!adapter?.resumeArgs, shells: openShells };
  });

  app.get('/api/sessions/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { before?: string; after?: string; through?: string; maxBytes?: string };
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
    const through = q.through !== undefined ? Number(q.through) : undefined;
    if (through !== undefined && (!Number.isInteger(through) || through < 0)) {
      return reply.code(400).send({ error: 'through 必须是非负整数字节偏移' });
    }
    const maxBytes = q.maxBytes ? Number(q.maxBytes) : undefined;
    if (before !== undefined && (!Number.isFinite(before) || before < 0)) {
      return reply.code(400).send({ error: 'before 必须是正整数字节偏移' });
    }
    const window = await registry.events(id, {
      before,
      through,
      maxBytes: maxBytes && maxBytes > 0 ? Math.min(maxBytes, 16 * 1024 * 1024) : undefined,
    });
    if (!window) {
      if (runs.forSession(id)) return EMPTY_WINDOW;
      return reply.code(404).send({ error: '会话不存在' });
    }
    return window;
  });

  /* ── 注解：置顶 / 标签 / 改标题 ─────────────────────────── */

  // 只存在 agentctl 的索引库里，不碰 agent 的会话文件；字段缺省表示不改
  app.post('/api/sessions/:id/annotation', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await registry.get(id);
    if (!session) return reply.code(404).send({ error: '会话不存在' });
    const body = (req.body ?? {}) as { pinned?: unknown; tags?: unknown; title?: unknown };
    const next = { ...registry.annotation(id) };
    if (body.pinned !== undefined) {
      if (typeof body.pinned !== 'boolean') throw new BadRequest('pinned 必须是布尔值');
      next.pinned = body.pinned;
    }
    if (body.tags !== undefined) next.tags = tagsOf(body.tags);
    if (body.title !== undefined) {
      if (body.title !== null && typeof body.title !== 'string') throw new BadRequest('title 必须是字符串');
      const title = typeof body.title === 'string' ? oneLine(body.title, 200).trim() : '';
      // 清空或改回原标题都等于"不再覆盖"
      next.title = title && title !== (session.originalTitle ?? session.title) ? title : undefined;
    }
    registry.setAnnotation(id, next);
    return { session: await registry.get(id) };
  });

  app.get('/api/tags', async () => {
    await registry.list();
    return { tags: registry.tags() };
  });

  /* ── 套餐额度 ─────────────────────────────────────────── */

  // 内置的每 10 分钟后台问一次，自定义订阅源按各自间隔；refresh=1 立刻去问（30 秒内重复刷新会直接用缓存）
  app.get('/api/quota', async (req) => {
    const q = req.query as { refresh?: string };
    return {
      agents: await ctx.quota.list(q.refresh === '1'),
      warnPercent: Math.min(Math.max(Number(cfg.quotaWarnPercent) || 80, 1), 100),
      settings: ctx.quota.settings(),
    };
  });

  app.post('/api/quota/settings', async (req) => {
    try {
      return { settings: ctx.quota.saveSettings((req.body ?? {}) as Record<string, never>) };
    } catch (err) {
      throw new BadRequest((err as Error).message);
    }
  });

  // 自定义订阅源：新增 / 修改（带 id）
  app.post('/api/quota/sources', async (req) => {
    const body = (req.body ?? {}) as { id?: unknown; kind?: unknown; name?: unknown; config?: unknown; enabled?: unknown };
    try {
      const row = ctx.quota.saveSource({
        id: typeof body.id === 'string' ? body.id : undefined,
        kind: typeof body.kind === 'string' ? body.kind : undefined,
        name: typeof body.name === 'string' ? body.name : undefined,
        config: body.config && typeof body.config === 'object' ? (body.config as Record<string, unknown>) : undefined,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      });
      return { id: `custom:${row.id}` };
    } catch (err) {
      throw new BadRequest((err as Error).message);
    }
  });

  app.delete('/api/quota/sources/:id', async (req) => {
    ctx.quota.deleteSource((req.params as { id: string }).id);
    return { ok: true };
  });

  // 测试一份配置：真的去拉一次接口，返回解析结果与原始返回（不保存）
  app.post('/api/quota/sources/test', async (req, reply) => {
    const body = (req.body ?? {}) as { id?: unknown; kind?: unknown; config?: unknown };
    try {
      return await ctx.quota.testSource({
        id: typeof body.id === 'string' ? body.id : undefined,
        kind: String(body.kind ?? ''),
        config: body.config && typeof body.config === 'object' ? (body.config as Record<string, unknown>) : {},
      });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /* ── 提醒渠道 ─────────────────────────────────────────── */

  app.get('/api/notify/channels', async () => ({
    channels: ctx.notify.channels().map((c) => ({ ...c, config: maskConfig(c.kind, c.config) })),
    fields: CHANNEL_FIELDS,
    events: EVENTS,
  }));

  app.post('/api/notify/channels', async (req) => {
    const body = (req.body ?? {}) as { id?: unknown; kind?: unknown; name?: unknown; config?: unknown; events?: unknown; enabled?: unknown };
    try {
      const row = ctx.notify.saveChannel({
        id: typeof body.id === 'string' ? body.id : undefined,
        kind: String(body.kind ?? ''),
        name: typeof body.name === 'string' ? body.name : undefined,
        config: body.config && typeof body.config === 'object' ? (body.config as Record<string, unknown>) : {},
        events: body.events,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      });
      return { channel: { ...row, config: maskConfig(row.kind, row.config) } };
    } catch (err) {
      throw new BadRequest((err as Error).message);
    }
  });

  app.delete('/api/notify/channels/:id', async (req) => {
    ctx.notify.deleteChannel((req.params as { id: string }).id);
    return { ok: true };
  });

  // 发一条测试消息，只发给这个渠道
  app.post('/api/notify/channels/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!ctx.notify.channels().some((c) => c.id === id)) return reply.code(404).send({ error: '渠道不存在' });
    const log = await ctx.notify.send({ event: 'test', title: 'agentctl 测试消息', body: '能看到这条，说明提醒渠道配置正确。' }, id);
    return { deliveries: log.deliveries };
  });

  // 提醒记录：网页轮询它弹 toast / 浏览器通知（after = 上次看到的最大 id）
  app.get('/api/notifications', async (req) => {
    const after = Number((req.query as { after?: string }).after ?? 0);
    return { items: ctx.notify.log(Number.isFinite(after) && after > 0 ? after : 0) };
  });

  /* ── 用量统计 ─────────────────────────────────────────── */

  // 第一次要把所有会话完整扫一遍（本机 ~500MB 约 2 秒），之后只重算变过的会话
  app.get('/api/usage', async (req, reply) => {
    const q = req.query as { days?: string; agent?: string };
    const days = q.days === undefined ? 30 : Number(q.days);
    if (!Number.isInteger(days) || days < 0 || days > 3650) return reply.code(400).send({ error: 'days 必须是 0–3650 的整数' });
    const started = Date.now();
    const all = await registry.usage();
    return { ...usageReport(all, days, q.agent || undefined), ms: Date.now() - started };
  });

  /* ── 全文搜索 ─────────────────────────────────────────── */

  // 不建索引，按最近活动顺序逐个会话扫文件；命中够数或超时就停，告诉前端结果不完整
  app.get('/api/search', async (req, reply) => {
    const qs = req.query as { q?: string; agent?: string };
    const text = (qs.q ?? '').trim();
    if (!text) return reply.code(400).send({ error: '搜索词不能为空' });
    if (text.length > 200) return reply.code(400).send({ error: '搜索词太长' });
    const query = searchQuery(text);
    const started = Date.now();
    const results: { session: SessionSummary; hits: SearchHit[] }[] = [];
    let total = 0;
    let truncated = false;
    for (const session of await registry.list()) {
      if (qs.agent && session.agent !== qs.agent) continue;
      if (total >= SEARCH_MAX_HITS || Date.now() - started > SEARCH_BUDGET_MS) {
        truncated = true;
        break;
      }
      const adapter = registry.adapter(session.agent);
      if (!adapter?.search || !session.file) continue;
      try {
        const hits = await adapter.search(session, query, Math.min(SEARCH_PER_SESSION, SEARCH_MAX_HITS - total));
        if (hits.length) {
          results.push({ session, hits });
          total += hits.length;
        }
      } catch (err) {
        app.log.warn({ err, session: session.id }, 'search failed');
      }
    }
    return { results, total, truncated, ms: Date.now() - started };
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

    // 下面有好几处 await；这期间浏览器已经能发消息了（比如刚连上就敲的字），先攒着，终端起来后按顺序处理
    let shell: ReturnType<ShellManager['open']> | undefined;
    const early: Buffer[] = [];
    let detach = () => {};
    const handle = (raw: Buffer) => {
      if (!shell) {
        if (early.length < 256) early.push(raw);
        return;
      }
      let msg: { type?: string; data?: unknown; cols?: unknown; rows?: unknown };
      try {
        msg = JSON.parse(raw.toString('utf8')) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === 'input' && typeof msg.data === 'string') shell.write(msg.data);
      else if (msg.type === 'resize') shell.resize(clampCols(msg.cols), clampRows(msg.rows));
      else if (msg.type === 'kill') shell.kill();
      // ping 只是让服务端知道浏览器还在，不用回
    };
    socket.on('message', handle);

    // 心跳：Tailscale / 手机网络切换时连接常常"半死"——两边都以为还连着。
    // 服务端每 20 秒发一次协议级 ping，两轮收不到 pong 就断开；同时发一条应用层 ping，浏览器靠它判断连接是否还活着
    let alive = true;
    socket.on('pong', () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      try {
        socket.ping();
      } catch {
        /* 已经断了，close 事件会清理 */
      }
      send({ type: 'ping' });
    }, SHELL_HEARTBEAT_MS);
    socket.on('close', () => {
      clearInterval(heartbeat);
      detach();
    });
    socket.on('error', () => socket.terminate());

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
    const cols = clampCols(q.cols);
    const rows = clampRows(q.rows);

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
    if (socket.readyState !== socket.OPEN) return;

    const opened = shells.open({ key, kind, file, args, cwd, title: session.title, cols, rows });
    shell = opened;
    send({ type: 'ready', shell: opened.info() });
    detach = opened.attach((msg) => {
      send(msg);
      // 进程退出：告诉页面后关掉连接，别让它以为还能输入
      if (msg.type === 'exit') setTimeout(() => socket.close(), 200);
    }, cols, rows);
    for (const raw of early.splice(0)) handle(raw);
  });

  app.get('/api/agents/:id/models', async (req, reply) => {
    const adapter = registry.adapter((req.params as { id: string }).id);
    // 没有离线取模型列表办法的 agent（DSH）：用上次运行时进程报的
    if (!adapter?.models) {
      const cached = adapter ? registry.cachedModels(adapter.id) : [];
      // 第一项「默认」= 不指定，跟随 agent 自己的配置（和其他 agent 的列表对齐）
      return { models: cached.length ? [{ value: 'default', displayName: 'Default', effortLevels: cached[0].effortLevels }, ...cached] : [] };
    }
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
    const applied = await run.handle.setPermissionMode(mode);
    const key = run.info().sessionKey;
    if (key) registry.savePrefs(key, { permissionMode: applied });
    return { mode: applied };
  });

  // 运行中切换推理强度：DSH、Codex 下一轮生效；Claude 记下来下次启动时生效。空串回到默认
  app.post('/api/runs/:id/effort', async (req, reply) => {
    const run = runs.get((req.params as { id: string }).id);
    if (!run || run.state === 'exited') return reply.code(404).send({ error: '运行不存在或已结束' });
    const raw = (req.body as { effort?: unknown } | undefined)?.effort;
    if (typeof raw !== 'string' || (raw !== '' && !EFFORT_RE.test(raw))) throw new BadRequest('effort 不合法');
    const key = run.info().sessionKey;
    // Claude 的强度是启动参数（--effort），进程活着时改不了：先记下，下次启动进程时用
    if (!run.handle.setEffort) {
      if (key) registry.savePrefs(key, { effort: raw || undefined });
      return { effort: raw, pending: true };
    }
    const effort = await run.handle.setEffort(raw);
    if (key) registry.savePrefs(key, { effort: effort || undefined });
    return { effort };
  });

  // 运行中切换模型：不重启进程，下一次请求起生效
  app.post('/api/runs/:id/model', async (req, reply) => {
    const run = runs.get((req.params as { id: string }).id);
    if (!run || run.state === 'exited') return reply.code(404).send({ error: '运行不存在或已结束' });
    if (!run.handle.setModel) return reply.code(400).send({ error: '该 agent 不支持运行中切换模型' });
    const model = modelOf((req.body as { model?: unknown } | undefined)?.model);
    const resolved = await run.handle.setModel(model);
    run.model = model;
    const key = run.info().sessionKey;
    if (key) registry.savePrefs(key, { model: model === 'default' ? undefined : model });
    return { model, resolved };
  });

  // 新建会话页输入目录时实时检查：存在？不存在的话能不能新建
  app.get('/api/fs/check', async (req) => inspectDir(cfg, (req.query as { path?: string }).path));

  // 下拉框一改就记下（不必等发消息）：浏览器重启、换设备后仍是上次的选择
  app.post('/api/sessions/:id/prefs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = await registry.get(id);
    if (!session) return reply.code(404).send({ error: '会话不存在' });
    const opts = effectiveOptions((req.body ?? {}) as RunBody, {}, cfg);
    const patch = { model: opts.model, effort: opts.effort, permissionMode: opts.permissionMode };
    registry.savePrefs(id, patch);
    registry.saveDefaults(session.agent, patch);
    return { prefs: registry.prefs(session) };
  });

  // 每个 agent 上次用的选项：新建会话页的默认值，也是没记过选项的会话的默认值
  app.get('/api/run-defaults', async () => ({ defaults: registry.allDefaults() }));

  app.post('/api/run-defaults/:agent', async (req, reply) => {
    const { agent } = req.params as { agent: string };
    if (!registry.adapter(agent)) return reply.code(404).send({ error: '没有这个 agent' });
    const opts = effectiveOptions((req.body ?? {}) as RunBody, {}, cfg);
    registry.saveDefaults(agent, { model: opts.model, effort: opts.effort, permissionMode: opts.permissionMode });
    return { ok: true };
  });

  // 附件目录先建好：Claude 每次启动都会 --add-dir 它，不存在会报错
  await mkdir(UPLOADS_DIR, { recursive: true, mode: 0o700 });
  // 附件上传：请求体就是文件字节（application/octet-stream），文件名和类型放在查询参数里。
  // 单独开一个子作用域注册二进制解析器，别的接口仍只收 JSON
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) =>
      done(null, body),
    );
    scope.post('/api/uploads', async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: '附件要以 application/octet-stream 上传' });
      const q = req.query as { name?: unknown; type?: unknown };
      const u = await saveUpload(req.body, q.name, q.type);
      return { id: u.id, name: u.name, mime: u.mime, bytes: u.bytes, path: u.path };
    });
  });

  // 取回附件（时间线里的缩略图、下载）。只把认识的位图当图片内联显示，
  // 其余一律按下载处理并禁止嗅探，免得上传的 HTML / SVG 在本站域名下执行脚本
  app.get('/api/uploads/:id/:name', async (req, reply) => {
    const { id, name } = req.params as { id: string; name: string };
    const u = await findUpload(id);
    if (!u || u.name !== name) return reply.code(404).send({ error: '附件不存在' });
    const image = u.mime.startsWith('image/');
    reply
      .header('content-type', image ? u.mime : 'application/octet-stream')
      .header('content-length', u.bytes)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('content-disposition', `${image ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(u.name)}`);
    return reply.send(createReadStream(u.path));
  });

  // 新建会话
  app.post('/api/runs', async (req, reply) => {
    const body = (req.body ?? {}) as RunBody & { agent?: unknown; cwd?: unknown; prompt?: unknown; createDir?: unknown; attachments?: unknown };
    const agentId = typeof body.agent === 'string' ? body.agent : 'claude';
    const adapter = registry.adapter(agentId);
    if (!adapter?.run) return reply.code(400).send({ error: `${agentId} 尚未支持实时运行` });
    const binary = await registry.binaryOf(adapter);
    if (adapter.meta.binary && !binary) {
      return reply.code(400).send({ error: `找不到 ${adapter.meta.binary} 可执行文件` });
    }
    const { text: prompt, attachments } = await messageOf(body.prompt, body.attachments);
    // 目录不存在：网页上确认过「在这里新建项目」才建，否则告诉网页去问用户
    const dir = await inspectDir(cfg, body.cwd);
    if (!dir.exists && dir.creatable) {
      if (body.createDir !== true) return reply.code(409).send({ error: `目录不存在：${dir.path}`, code: 'cwd_missing', path: dir.path });
      await createDir(cfg, body.cwd);
    }
    const cwd = await checkedCwd(cfg, body.cwd);
    const opts = effectiveOptions(body, {}, cfg);
    const run = runs.start({
      adapter,
      binary,
      cwd,
      prompt,
      attachments,
      uploadsDir: UPLOADS_DIR,
      title: titleOf(prompt, attachments),
      ...opts,
      allowBypass: cfg.allowBypassPermissions,
    });
    rememberRunModels(run);
    try {
      await withTimeout(run.handle.sessionId, SESSION_ID_TIMEOUT_MS, 'agent 启动超时');
    } catch (err) {
      run.handle.stop();
      return reply.code(502).send({ error: (err as Error).message });
    }
    const key = run.info().sessionKey;
    if (key) registry.savePrefs(key, opts);
    registry.saveDefaults(agentId, opts);
    registry.invalidate();
    return { run: run.info() };
  });

  // 往已有会话发消息：有活着的进程就直接写 stdin，否则 --resume 起一个
  app.post('/api/sessions/:id/send', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as RunBody & { text?: unknown; attachments?: unknown; mode?: unknown };
    const mode = sendModeOf(body.mode);
    const { text, attachments } = await messageOf(body.text, body.attachments);
    if (shells.get(`${id}:agent`)) {
      return reply.code(409).send({ error: '这个会话正在网页终端里运行 claude，先在终端里退出（/exit）再在这里发消息' });
    }
    const active = runs.forSession(id);
    if (active && active.state !== 'exited') {
      active.send(text, attachments, mode);
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
    const opts = effectiveOptions(body, registry.prefs(session), cfg);
    const run = runs.start({
      adapter,
      binary,
      cwd,
      prompt: text,
      attachments,
      uploadsDir: UPLOADS_DIR,
      title: session.title,
      resumeSessionId: session.sessionId,
      startTurn: session.turns,
      ...opts,
      allowBypass: cfg.allowBypassPermissions,
    });
    rememberRunModels(run);
    registry.savePrefs(id, { model: opts.model, effort: opts.effort, permissionMode: opts.permissionMode });
    registry.saveDefaults(session.agent, { model: opts.model, effort: opts.effort, permissionMode: opts.permissionMode });
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
    // 排队的消息不再自动发出，交还给点「打断」的那个页面放回输入框
    const queued = run.takeQueue();
    run.handle.interrupt();
    return { ok: true, queued };
  });

  app.delete('/api/runs/:id/queue/:qid', async (req, reply) => {
    const { id, qid } = req.params as { id: string; qid: string };
    const item = runs.get(id)?.unqueue(qid);
    if (!item) return reply.code(404).send({ error: '这条消息已经发出或被撤回了' });
    return { item };
  });

  app.post('/api/runs/:id/queue/:qid/steer', async (req, reply) => {
    const { id, qid } = req.params as { id: string; qid: string };
    const run = runs.get(id);
    if (!run || run.state === 'exited') return reply.code(404).send({ error: '运行不存在或已结束' });
    try {
      if (!run.steerQueued(qid)) return reply.code(404).send({ error: '这条消息已经发出或被撤回了' });
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
    return { ok: true };
  });

  app.post('/api/runs/:id/stop', async (req, reply) => {
    const run = runs.get((req.params as { id: string }).id);
    if (!run) return reply.code(404).send({ error: '运行不存在' });
    run.handle.stop();
    return { ok: true };
  });
}
