/**
 * Claude Code 实时运行：`claude -p --input-format stream-json --output-format stream-json`。
 *
 * 一个会话一个常驻进程：stdin 逐行写用户消息，stdout 逐行读事件，多轮复用同一进程。
 * 工具审批走 `--permission-prompt-tool stdio`：CLI 发 control_request(can_use_tool)，
 * 我们回 control_response —— 与官方 Agent SDK 同一套协议。
 *
 * 进程只是"驱动"，真相仍是它写到 ~/.claude/projects 的 jsonl；
 * 这里吐出的事件与回放同构且 uid 一致，前端可以无缝合并两条数据流。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import {
  isImageAttachment,
  oneLine,
  summarizeToolInput,
  withAttachmentList,
  type ApprovalDecision,
  type Attachment,
  type Item,
  type ModelInfo,
  type QuotaSnapshot,
  type QuotaWindow,
  type PermissionMode,
  type QuestionAnswers,
  type RunHandle,
  type RunRequest,
  type RunSink,
  type RunState,
  type UnifiedEvent,
} from '@agentctl/core';
import { parseLine, turnIndexOf, type ParseCtx } from './parse.ts';

/** 空闲这么久没人说话就关掉进程；会话本身还在磁盘上，下次发消息自动 --resume */
const IDLE_EXIT_MS = 30 * 60_000;
const STDERR_KEEP = 4096;

/** 这些 system 子类型是进程内部状态，时间线上没有阅读价值 */
const QUIET_SYSTEM = new Set(['init', 'status', 'hook_started', 'hook_progress', 'hook_response', 'thinking_tokens']);

/** API 对单张图片的上限是 5MB（base64 前）；再大的只给路径，让 Read 工具自己缩放后再看 */
const INLINE_IMAGE_MAX = 3.75 * 1024 * 1024;

interface Pending {
  toolName: string;
  input: unknown;
  suggestions: unknown[];
  event: UnifiedEvent;
}

export function buildArgs(req: RunRequest): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    // 把我们写进去的用户消息原样回显，带上 uuid，前端才能和磁盘回放去重
    '--replay-user-messages',
    '--permission-prompt-tool',
    'stdio',
  ];
  // 只是"允许进入" bypass：默认模式下照样逐个审批，但之后可以在运行中切过去
  if (req.allowBypass) args.push('--allow-dangerously-skip-permissions');
  if (req.resumeSessionId) args.push('--resume', req.resumeSessionId);
  if (req.model && req.model !== 'default') args.push('--model', req.model);
  if (req.effort) args.push('--effort', req.effort);
  if (req.permissionMode && req.permissionMode !== 'default') {
    args.push('--permission-mode', req.permissionMode);
  }
  // 附件存在工作目录之外，加进来 Read 才不用逐个审批
  if (req.uploadsDir) args.push('--add-dir', req.uploadsDir);
  return args;
}

/**
 * 用户消息的 content：图片作为原生图片块放在前面（API 建议图在文字前），
 * 所有附件的路径都列在文字末尾，agent 需要时能直接读、复制或引用原文件。
 */
export function userContent(text: string, attachments?: Attachment[]): string | unknown[] {
  if (!attachments?.length) return text;
  const blocks: unknown[] = [];
  const inlined = new Set<Attachment>();
  for (const a of attachments) {
    if (!isImageAttachment(a) || a.bytes > INLINE_IMAGE_MAX) continue;
    try {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: readFileSync(a.path).toString('base64') } });
      inlined.add(a);
    } catch {
      /* 读不到就只给路径 */
    }
  }
  const full = withAttachmentList(text, attachments, (a) => inlined.has(a));
  return blocks.length ? [...blocks, { type: 'text', text: full }] : full;
}

export function startClaudeRun(req: RunRequest, sink: RunSink): RunHandle {
  const child = spawn(req.binary ?? 'claude', buildArgs(req), {
    cwd: req.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  let sessionId = req.resumeSessionId ?? '';
  let resolveSid!: (id: string) => void;
  let rejectSid!: (err: Error) => void;
  const sessionIdPromise = new Promise<string>((res, rej) => {
    resolveSid = res;
    rejectSid = rej;
  });
  // 没人 await 时别变成 unhandledRejection
  sessionIdPromise.catch(() => undefined);
  if (sessionId) resolveSid(sessionId);

  const ctx: ParseCtx = { file: '', sessionId, turn: req.startTurn ?? 0 };
  const pending = new Map<string, Pending>();
  let seq = 0;
  // 已发出、还没收到回显的用户消息数。CLI 读到消息时回显它：一轮进行中写进去的消息
  // 会在当前工具结束后并进这一轮（回显在 result 之前），否则下一轮再处理（回显在 result 之后）。
  // 所以 result 到达时还有没回显的，说明 CLI 马上要开新的一轮。
  let awaitingEcho = 0;
  let state: RunState = 'starting';
  let exited = false;
  let stderrTail = '';
  let interrupted = false; // 打断后那一轮会以 error_during_execution 收尾，不算失败
  let idleTimer: NodeJS.Timeout | undefined;
  /** 我们发出的 control_request 等应答（set_model 等） */
  const controls = new Map<string, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();

  const setState = (next: RunState, extra: { error?: string; exitCode?: number | null } = {}) => {
    if (state === next && !extra.error) return;
    state = next;
    sink({ type: 'state', state, sessionId: sessionId || undefined, ...extra });
    clearTimeout(idleTimer);
    if (state === 'idle') idleTimer = setTimeout(() => handle.stop(), IDLE_EXIT_MS);
  };

  const emit = (item: Item, uid: string) => {
    sink({
      type: 'event',
      event: {
        agent: 'claude',
        sessionId,
        turn: ctx.turn,
        seq: seq++,
        ts: new Date().toISOString(),
        item,
        uid,
        transient: true,
      },
    });
  };

  const write = (obj: unknown) => {
    if (exited || !child.stdin.writable) throw new Error('agent 进程已退出');
    child.stdin.write(`${JSON.stringify(obj)}\n`);
  };

  /** 发一个 control_request 并等 CLI 应答（失败时 reject 带上 CLI 的原因） */
  const control = (subtype: string, payload: Record<string, unknown>) => {
    const id = `${subtype}-${seq++}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      controls.set(id, { resolve, reject });
      try {
        write({ type: 'control_request', request_id: id, request: { subtype, ...payload } });
      } catch (err) {
        controls.delete(id);
        reject(err as Error);
      }
    });
  };

  const controlResponse = (requestId: string, response: unknown) =>
    write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });

  const resolveApproval = (requestId: string, approved: boolean) => {
    const p = pending.get(requestId);
    if (!p) return;
    pending.delete(requestId);
    if (p.event.item.kind !== 'approval') return;
    sink({
      type: 'event',
      event: { ...p.event, item: { ...p.event.item, state: approved ? 'approved' : 'denied' } },
    });
  };

  const onLine = (text: string) => {
    let line: Record<string, unknown>;
    try {
      line = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return; // 非 JSON 的杂讯（理论上不会有）
    }
    const type = typeof line.type === 'string' ? line.type : '';

    if (!sessionId && typeof line.session_id === 'string' && line.session_id) {
      sessionId = line.session_id;
      ctx.sessionId = sessionId;
      resolveSid(sessionId);
      sink({ type: 'state', state, sessionId });
    }

    switch (type) {
      case 'stream_event': {
        const ev = line.event as { type?: string; delta?: Record<string, unknown> } | undefined;
        if (ev?.type === 'message_start') sink({ type: 'delta_reset' });
        if (ev?.type === 'content_block_delta' && ev.delta) {
          if (ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') {
            sink({ type: 'delta', block: 'text', text: ev.delta.text });
          } else if (ev.delta.type === 'thinking_delta' && typeof ev.delta.thinking === 'string') {
            sink({ type: 'delta', block: 'thinking', text: ev.delta.thinking });
          }
        }
        return;
      }

      case 'user':
      case 'assistant': {
        const t = turnIndexOf(line);
        if (t !== undefined) ctx.turn = t;
        else if (type === 'user' && awaitingEcho > 0 && isPromptEcho(line)) {
          awaitingEcho -= 1;
          ctx.turn += 1;
        }
        // 流里的行有时不带时间戳，补上，否则前端时间槽会显示 1970
        if (typeof line.timestamp !== 'string') line.timestamp = new Date().toISOString();
        for (const event of parseLine(line, seq++, ctx)) sink({ type: 'event', event });
        if (type === 'assistant') sink({ type: 'delta_reset' });
        if (state === 'starting') setState('running');
        return;
      }

      case 'system': {
        const subtype = typeof line.subtype === 'string' ? line.subtype : '';
        if (subtype === 'init') {
          if (state === 'starting') setState(awaitingEcho > 0 ? 'running' : 'idle');
          sink({
            type: 'config',
            model: typeof line.model === 'string' ? line.model : undefined,
            permissionMode: typeof line.permissionMode === 'string' ? (line.permissionMode as PermissionMode) : undefined,
          });
        }
        if (QUIET_SYSTEM.has(subtype)) return;
        for (const event of parseLine(line, seq++, ctx)) sink({ type: 'event', event });
        return;
      }

      case 'result': {
        const parts: string[] = [];
        if (typeof line.duration_ms === 'number') parts.push(`本轮耗时 ${(line.duration_ms / 1000).toFixed(1)}s`);
        if (typeof line.total_cost_usd === 'number') parts.push(`累计 $${line.total_cost_usd.toFixed(4)}`);
        const failed = line.is_error === true || (typeof line.subtype === 'string' && line.subtype.startsWith('error'));
        if (failed && interrupted) {
          // CLI 会自己写一行 "[Request interrupted by user]"，解析成"已打断"，这里不再重复
        } else if (failed) {
          const reason = typeof line.result === 'string' ? oneLine(line.result, 200) : String(line.subtype ?? '出错');
          emit({ kind: 'notice', level: 'error', code: 'result', text: `本轮失败：${reason}` }, `result:${seq}`);
        } else {
          emit({ kind: 'notice', level: 'info', code: 'turn_duration', text: parts.join(' · ') || '本轮结束' }, `result:${seq}`);
        }
        interrupted = false;
        sink({ type: 'delta_reset' });
        setState(awaitingEcho > 0 ? 'running' : 'idle');
        return;
      }

      case 'control_request': {
        const requestId = typeof line.request_id === 'string' ? line.request_id : '';
        const r = (line.request ?? {}) as Record<string, unknown>;
        if (r.subtype === 'can_use_tool') {
          const toolName = typeof r.tool_name === 'string' ? r.tool_name : 'tool';
          const detail =
            (typeof r.description === 'string' && r.description) || summarizeToolInput(toolName, r.input);
          const event: UnifiedEvent = {
            agent: 'claude',
            sessionId,
            turn: ctx.turn,
            seq: seq++,
            ts: new Date().toISOString(),
            uid: `approval:${requestId}`,
            transient: true,
            item: {
              kind: 'approval',
              requestId,
              tool: toolName,
              detail,
              input: r.input,
              choices: ['allow', 'allow_session', 'deny'],
              state: 'pending',
            },
          };
          pending.set(requestId, {
            toolName,
            input: r.input,
            suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [],
            event,
          });
          sink({ type: 'event', event });
          return;
        }
        // 我们没注册 hook / SDK MCP，其余请求一律明确拒绝，免得 CLI 干等
        write({
          type: 'control_response',
          response: { subtype: 'error', request_id: requestId, error: `agentctl 不支持 ${String(r.subtype)}` },
        });
        return;
      }

      case 'control_response': {
        const r = (line.response ?? {}) as Record<string, unknown>;
        const waiter = typeof r.request_id === 'string' ? controls.get(r.request_id) : undefined;
        if (!waiter) return; // initialize / interrupt 的应答无人等待
        controls.delete(r.request_id as string);
        if (r.subtype === 'success') waiter.resolve((r.response ?? {}) as Record<string, unknown>);
        else waiter.reject(new Error(typeof r.error === 'string' ? r.error : '请求被拒绝'));
        return;
      }

      default:
        // rate_limit_event 等：无需展示
        return;
    }
  };

  createInterface({ input: child.stdout }).on('line', onLine);
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_KEEP);
  });

  const exitedPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    const finish = (code: number | null, signal: string | null, spawnError?: Error) => {
      if (exited) return;
      exited = true;
      clearTimeout(idleTimer);
      for (const id of [...pending.keys()]) resolveApproval(id, false);
      for (const w of controls.values()) w.reject(new Error('agent 进程已退出'));
      controls.clear();
      const reason = spawnError?.message ?? (code ? oneLine(stderrTail, 400) : '');
      if (reason) emit({ kind: 'notice', level: 'error', code: 'exit', text: `进程退出：${reason}` }, `exit:${seq}`);
      rejectSid(new Error(reason || 'agent 进程在分配会话前退出'));
      state = 'exited';
      sink({ type: 'state', state, sessionId: sessionId || undefined, exitCode: code, error: reason || undefined });
      resolve({ code, signal });
    };
    child.on('error', (err) => finish(null, null, err));
    child.on('exit', (code, signal) => finish(code, signal));
  });

  const handle: RunHandle = {
    sessionId: sessionIdPromise,
    send(text: string, attachments?: Attachment[]) {
      write({
        type: 'user',
        message: { role: 'user', content: userContent(text, attachments) },
        parent_tool_use_id: null,
        session_id: sessionId,
      });
      awaitingEcho += 1;
      setState('running');
    },
    // CLI 自己会把一轮进行中写进来的消息并进当前这一轮，引导和发送是同一个动作
    steer(text: string, attachments?: Attachment[]) {
      handle.send(text, attachments);
    },
    respond(requestId: string, decision: ApprovalDecision, answers?: QuestionAnswers) {
      const p = pending.get(requestId);
      if (!p) return false;
      if (decision === 'deny') {
        controlResponse(requestId, { behavior: 'deny', message: '用户在 agentctl 中拒绝了这次调用' });
      } else if (answers) {
        // AskUserQuestion：答案随入参一起回给工具，它会把"问题=答案"交给模型（多个答案用 ", " 连接）
        const input = p.input && typeof p.input === 'object' ? (p.input as Record<string, unknown>) : {};
        const joined = Object.fromEntries(Object.entries(answers).map(([q, a]) => [q, a.join(', ')]));
        controlResponse(requestId, { behavior: 'allow', updatedInput: { ...input, answers: joined } });
      } else {
        // "本会话内允许"：采纳 CLI 给的规则建议，但一律降级到 session 作用域，
        // 绝不替用户把规则写进项目或全局 settings 文件
        const updatedPermissions =
          decision === 'allow_session'
            ? p.suggestions
                .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
                .map((s) => ({ ...s, destination: 'session' }))
            : undefined;
        controlResponse(requestId, { behavior: 'allow', updatedInput: p.input, updatedPermissions });
      }
      resolveApproval(requestId, decision !== 'deny');
      return true;
    },
    async setModel(model: string) {
      const r = await control('set_model', { model });
      const resolved = typeof r.model === 'string' ? r.model : undefined;
      sink({ type: 'config', model: resolved ?? model });
      return resolved;
    },
    async setPermissionMode(mode: PermissionMode) {
      const r = await control('set_permission_mode', { mode });
      const actual = (typeof r.mode === 'string' ? r.mode : mode) as PermissionMode;
      sink({ type: 'config', permissionMode: actual });
      return actual;
    },
    interrupt() {
      for (const id of [...pending.keys()]) handle.respond(id, 'deny');
      interrupted = true;
      write({ type: 'control_request', request_id: `interrupt-${seq}`, request: { subtype: 'interrupt' } });
    },
    stop() {
      if (exited) return;
      child.stdin.end();
      // 正常情况下 stdin 关闭后 CLI 会自行退出；给它几秒收尾写盘
      setTimeout(() => {
        if (!exited) child.kill('SIGTERM');
      }, 5000).unref();
    },
    exited: exitedPromise,
  };

  write({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } });
  handle.send(req.prompt, req.attachments);
  return handle;
}

/** 区分"我们发出的那条提问的回显"与工具结果、系统提醒 */
function isPromptEcho(line: Record<string, unknown>): boolean {
  if (line.isMeta === true) return false;
  const content = (line.message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return true;
  if (!Array.isArray(content)) return false;
  return !content.some((b) => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_result');
}

/**
 * 起一个不发消息的 CLI 进程，只做 initialize 握手拿模型列表就退出。
 * 列表与终端里 /model 一致，包含别名、完整 id 和支持的推理强度。
 */
/**
 * 不发消息地问 CLI 一些事：起一个 stream-json 进程，发几条控制请求，收齐回复就结束。
 * 不产生会话文件、不调用模型。cwd 用家目录，免得落在某个项目里触发信任确认之类的东西。
 */
function controlProbe(binary: string | undefined, requests: Record<string, unknown>[], what: string, timeoutMs = 20_000): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary ?? 'claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      cwd: homedir(),
      env: process.env,
    });
    const replies = new Map<string, Record<string, unknown>>();
    let settled = false;
    const done = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      setTimeout(() => child.kill(), 1000).unref();
      if (err) reject(err);
      else resolve(requests.map((_, i) => replies.get(`probe-${i}`) ?? {}));
    };
    const timer = setTimeout(() => done(new Error(`${what}超时`)), timeoutMs);
    child.on('error', (err) => done(err));
    child.on('exit', () => done(replies.size ? null : new Error(`${what}失败：claude 提前退出`)));
    createInterface({ input: child.stdout }).on('line', (text) => {
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      if (d.type !== 'control_response') return;
      const r = (d.response ?? {}) as { request_id?: string; subtype?: string; error?: string; response?: Record<string, unknown> };
      if (!r.request_id) return;
      if (r.subtype === 'error') return done(new Error(`${what}失败：${r.error ?? '未知错误'}`));
      replies.set(r.request_id, r.response ?? {});
      if (replies.size === requests.length) done(null);
    });
    requests.forEach((request, i) => {
      child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: `probe-${i}`, request })}\n`);
    });
  });
}

export async function probeModels(binary?: string): Promise<ModelInfo[]> {
  const [init] = await controlProbe(binary, [{ subtype: 'initialize' }], '获取模型列表');
  const raw = (Array.isArray(init.models) ? init.models : []) as unknown[];
  return raw
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && typeof (m as { value?: unknown }).value === 'string')
    .map((m) => ({
      value: m.value as string,
      displayName: typeof m.displayName === 'string' ? m.displayName : (m.value as string),
      description: typeof m.description === 'string' ? m.description : undefined,
      resolvedModel: typeof m.resolvedModel === 'string' ? m.resolvedModel : undefined,
      effortLevels: Array.isArray(m.supportedEffortLevels)
        ? m.supportedEffortLevels.filter((x): x is string => typeof x === 'string')
        : undefined,
    }));
}

const LIMIT_LABEL: Record<string, string> = {
  session: '5 小时',
  five_hour: '5 小时',
  weekly_all: '每周',
  seven_day: '每周',
  weekly_opus: '每周 · Opus',
  seven_day_opus: '每周 · Opus',
  weekly_sonnet: '每周 · Sonnet',
  seven_day_sonnet: '每周 · Sonnet',
};

/**
 * 套餐额度：和终端里 /usage 看到的是同一份数据（get_usage 控制请求，SDK 标注为实验接口）。
 * 优先用通用的 limits 列表，没有时退回 rate_limits 里的固定窗口。
 */
export async function probeQuota(binary?: string): Promise<QuotaSnapshot> {
  const [, usage] = await controlProbe(binary, [{ subtype: 'initialize' }, { subtype: 'get_usage', skip_behaviors: true }], '获取套餐额度');
  const rl = (usage.rate_limits ?? {}) as Record<string, unknown>;
  const windows: QuotaWindow[] = [];
  let blocked = false;
  const limits = Array.isArray(rl.limits) ? (rl.limits as Record<string, unknown>[]) : [];
  for (const l of limits) {
    const kind = typeof l.kind === 'string' ? l.kind : '';
    if (typeof l.percent !== 'number' || !kind) continue;
    windows.push({
      // 和 Codex 用同一套键，前端按键对齐两边的窗口
      id: kind === 'session' ? 'five_hour' : kind === 'weekly_all' ? 'seven_day' : kind,
      label: LIMIT_LABEL[kind] ?? kind,
      usedPercent: l.percent,
      resetsAt: typeof l.resets_at === 'string' ? l.resets_at : undefined,
      windowMinutes: l.group === 'session' ? 300 : l.group === 'weekly' ? 10080 : undefined,
    });
    if (l.percent >= 100 || l.severity === 'exceeded' || l.severity === 'blocked') blocked = true;
  }
  if (!windows.length) {
    for (const id of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']) {
      const w = rl[id] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
      if (!w || typeof w.utilization !== 'number') continue;
      windows.push({
        id,
        label: LIMIT_LABEL[id],
        usedPercent: w.utilization,
        resetsAt: typeof w.resets_at === 'string' ? w.resets_at : undefined,
        windowMinutes: id === 'five_hour' ? 300 : 10080,
      });
      if (w.utilization >= 100) blocked = true;
    }
  }
  const extra = (rl.extra_usage ?? {}) as Record<string, unknown>;
  return {
    plan: typeof usage.subscription_type === 'string' ? usage.subscription_type : undefined,
    windows,
    credits: extra.is_enabled === true
      ? { enabled: true, usedPercent: typeof extra.utilization === 'number' ? extra.utilization : undefined }
      : undefined,
    blocked,
  };
}
