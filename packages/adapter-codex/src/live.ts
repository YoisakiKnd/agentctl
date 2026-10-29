/**
 * Codex 实时运行：`codex app-server`（JSON-RPC over stdio，一行一条）。
 *
 * 一个会话一个 app-server 进程：thread/start 或 thread/resume 建立线程，每条用户消息一个 turn/start。
 * 命令 / 文件改动审批、问答都是服务端发来的 JSON-RPC 请求，我们回结果即可。
 *
 * 进程只是驱动，真相仍是 Codex 写的 rollout 文件：实时 item 归一成文件格式后走同一个 parseLine，
 * uid 与磁盘回放一致。用量、本轮耗时这些文件里也会有的东西不从实时流发，免得重复。
 */
import {
  oneLine,
  spawnJsonRpc,
  type ApprovalDecision,
  type ModelInfo,
  type PermissionMode,
  type RunHandle,
  type RunRequest,
  type RunSink,
  type RunState,
  type UnifiedEvent,
  type QuotaSnapshot,
  type QuotaWindow,
} from '@agentctl/core';
import { normalizeLiveItem, parseLine, type ParseCtx } from './parse.ts';

type Rec = Record<string, unknown>;

const IDLE_EXIT_MS = 30 * 60_000;
const STDERR_KEEP = 4096;
const CLIENT_INFO = { name: 'agentctl', title: 'agentctl', version: '0.8.1' };

/** 网页的权限模式 → Codex 的审批策略 + 沙箱。没有 acceptEdits 的对应物，按 auto 处理 */
const POLICY: Record<PermissionMode, { approval: string; sandbox: string; sandboxPolicy: Rec }> = {
  default: { approval: 'untrusted', sandbox: 'workspace-write', sandboxPolicy: workspaceWrite() },
  acceptEdits: { approval: 'on-request', sandbox: 'workspace-write', sandboxPolicy: workspaceWrite() },
  auto: { approval: 'on-request', sandbox: 'workspace-write', sandboxPolicy: workspaceWrite() },
  plan: { approval: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false } },
  bypassPermissions: { approval: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } },
};

function workspaceWrite(): Rec {
  return { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

interface Pending {
  /** JSON-RPC 请求 id（回结果用） */
  rpcId: number | string;
  method: string;
  event: UnifiedEvent;
  /** requestUserInput：问题文本 → 问题 id */
  questionIds?: Map<string, string>;
}

export function startCodexRun(req: RunRequest, sink: RunSink): RunHandle {
  const rpc = spawnJsonRpc(req.binary ?? 'codex', ['app-server'], req.cwd);
  const { child } = rpc;

  let sessionId = req.resumeSessionId ?? '';
  let resolveSid!: (id: string) => void;
  let rejectSid!: (err: Error) => void;
  const sessionIdPromise = new Promise<string>((res, rej) => {
    resolveSid = res;
    rejectSid = rej;
  });
  sessionIdPromise.catch(() => undefined);

  const ctx: ParseCtx = { file: '', sessionId, turn: req.startTurn ?? 0, model: req.model };
  const pending = new Map<string, Pending>();
  /** item/started 时记下的文件改动，审批卡要显示改哪些文件 */
  const startedChanges = new Map<string, Rec>();
  const queue: string[] = [];
  let mode: PermissionMode = req.permissionMode ?? 'default';
  let modeChanged = false;
  let model = req.model && req.model !== 'default' ? req.model : undefined;
  let effort = req.effort;
  let turnId = '';
  let turnRunning = false;
  let ready = false;
  let seq = 0;
  let state: RunState = 'starting';
  let exited = false;
  let stderrTail = '';
  let idleTimer: NodeJS.Timeout | undefined;

  const setState = (next: RunState, extra: { error?: string; exitCode?: number | null } = {}) => {
    if (state === next && !extra.error) return;
    state = next;
    sink({ type: 'state', state, sessionId: sessionId || undefined, ...extra });
    clearTimeout(idleTimer);
    if (state === 'idle') idleTimer = setTimeout(() => handle.stop(), IDLE_EXIT_MS);
  };

  const transient = (item: UnifiedEvent['item'], uid: string): UnifiedEvent => ({
    agent: 'codex',
    sessionId,
    turn: ctx.turn,
    seq: seq++,
    ts: new Date().toISOString(),
    item,
    uid,
    transient: true,
  });

  const resolveApproval = (key: string, approved: boolean) => {
    const p = pending.get(key);
    if (!p || p.event.item.kind !== 'approval') return;
    pending.delete(key);
    sink({ type: 'event', event: { ...p.event, item: { ...p.event.item, state: approved ? 'approved' : 'denied' } } });
  };

  const startTurn = (text: string) => {
    turnRunning = true;
    setState('running');
    const params: Rec = { threadId: sessionId, input: [{ type: 'text', text, text_elements: [] }] };
    if (model) params.model = model;
    if (effort) params.effort = effort;
    if (modeChanged) {
      params.approvalPolicy = POLICY[mode].approval;
      params.sandboxPolicy = POLICY[mode].sandboxPolicy;
    }
    rpc.request('turn/start', params).catch((err: Error) => {
      turnRunning = false;
      sink({ type: 'event', event: transient({ kind: 'notice', level: 'error', code: 'turn', text: `发送失败：${err.message}` }, `err:${seq}`) });
      setState('idle');
    });
  };

  const drain = () => {
    if (!ready || turnRunning) return;
    const next = queue.shift();
    if (next !== undefined) startTurn(next);
    else setState('idle');
  };

  rpc.onNotification = (method, params) => {
    switch (method) {
      case 'turn/started': {
        const turn = (params.turn ?? {}) as Rec;
        turnId = typeof turn.id === 'string' ? turn.id : turnId;
        ctx.turn += 1;
        turnRunning = true;
        setState('running');
        return;
      }
      case 'item/agentMessage/delta':
        if (typeof params.delta === 'string') sink({ type: 'delta', block: 'text', text: params.delta });
        return;
      case 'item/reasoning/summaryTextDelta':
        if (typeof params.delta === 'string') sink({ type: 'delta', block: 'thinking', text: params.delta });
        return;
      case 'item/started': {
        const item = (params.item ?? {}) as Rec;
        if (item.type === 'fileChange' && typeof item.id === 'string') startedChanges.set(item.id, item);
        return;
      }
      case 'item/completed': {
        const item = (params.item ?? {}) as Rec;
        const normalized = normalizeLiveItem(item);
        if (normalized) {
          const line = { type: 'event_msg', ordinal: seq, timestamp: new Date().toISOString(), payload: { type: 'item_completed', item: normalized } };
          for (const event of parseLine(line, seq++, ctx)) sink({ type: 'event', event });
        }
        if (item.type === 'agentMessage' || item.type === 'reasoning') sink({ type: 'delta_reset' });
        return;
      }
      case 'serverRequest/resolved': {
        // 审批被别处（超时、自动审查）处理掉了
        const id = String(params.requestId ?? '');
        for (const [key, p] of pending) if (String(p.rpcId) === id) resolveApproval(key, true);
        return;
      }
      case 'turn/completed': {
        const turn = (params.turn ?? {}) as Rec;
        turnRunning = false;
        for (const key of [...pending.keys()]) resolveApproval(key, false);
        const err = turn.error as { message?: string } | null | undefined;
        if (turn.status === 'failed' || err) {
          sink({ type: 'event', event: transient({ kind: 'notice', level: 'error', code: 'turn', text: `本轮失败：${oneLine(err?.message ?? String(turn.status), 300)}` }, `fail:${String(turn.id)}`) });
        }
        sink({ type: 'delta_reset' });
        drain();
        return;
      }
      case 'error': {
        const e = (params.error ?? params) as { message?: string };
        if (e.message) sink({ type: 'event', event: transient({ kind: 'notice', level: 'error', code: 'error', text: oneLine(e.message, 300) }, `err:${seq}`) });
        return;
      }
      default:
        return;
    }
  };

  rpc.onServerRequest = (id, method, params) => {
    const key = `${method}:${String(id)}`;
    const itemId = typeof params.itemId === 'string' ? params.itemId : '';
    const reason = typeof params.reason === 'string' ? params.reason : '';

    if (method === 'item/commandExecution/requestApproval') {
      const command = typeof params.command === 'string' ? params.command : '';
      const event = transient(
        {
          kind: 'approval',
          requestId: key,
          tool: 'exec',
          detail: reason,
          input: { command: command.replace(/^\S*\b(?:ba|z)?sh\s+-l?c\s+'([\s\S]*)'$/, '$1'), cwd: params.cwd },
          choices: ['allow', 'allow_session', 'deny'],
          state: 'pending',
        },
        `approval:${key}`,
      );
      pending.set(key, { rpcId: id, method, event });
      sink({ type: 'event', event });
      return;
    }

    if (method === 'item/fileChange/requestApproval') {
      const item = startedChanges.get(itemId);
      const files = Array.isArray(item?.changes) ? (item.changes as Rec[]).map((c) => String(c.path ?? '')) : [];
      const event = transient(
        {
          kind: 'approval',
          requestId: key,
          tool: 'apply_patch',
          detail: reason || (files.length ? `修改 ${files.length} 个文件` : '修改文件'),
          input: { file_path: files.join('\n'), grantRoot: params.grantRoot ?? undefined },
          choices: ['allow', 'allow_session', 'deny'],
          state: 'pending',
        },
        `approval:${key}`,
      );
      pending.set(key, { rpcId: id, method, event });
      sink({ type: 'event', event });
      return;
    }

    if (method === 'item/tool/requestUserInput') {
      // 复用网页上 AskUserQuestion 的问答卡：同样是 questions[{question, header, options}]
      const questionIds = new Map<string, string>();
      const questions = (Array.isArray(params.questions) ? params.questions : []).map((q) => {
        const r = (q ?? {}) as Rec;
        questionIds.set(String(r.question ?? ''), String(r.id ?? ''));
        return {
          question: r.question,
          header: r.header,
          multiSelect: false,
          options: Array.isArray(r.options) ? r.options : [],
        };
      });
      const event = transient(
        { kind: 'approval', requestId: key, tool: 'AskUserQuestion', detail: '', input: { questions }, choices: ['allow', 'deny'], state: 'pending' },
        `approval:${key}`,
      );
      pending.set(key, { rpcId: id, method, event, questionIds });
      sink({ type: 'event', event });
      return;
    }

    // MCP elicitation、权限扩展等网页端还没有界面的请求：明确拒绝，免得 Codex 干等
    rpc.replyError(id, `agentctl 不支持 ${method}`);
  };

  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_KEEP);
  });

  const exitedPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    const finish = (code: number | null, signal: string | null, spawnError?: Error) => {
      if (exited) return;
      exited = true;
      clearTimeout(idleTimer);
      for (const key of [...pending.keys()]) resolveApproval(key, false);
      // app-server 的 stderr 里常驻沙箱警告之类的日志，只有异常退出才拿来当原因
      const reason = spawnError?.message ?? (code ? oneLine(stderrTail.replace(/\x1b\[[0-9;]*m/g, ''), 400) : '');
      if (reason) sink({ type: 'event', event: transient({ kind: 'notice', level: 'error', code: 'exit', text: `进程退出：${reason}` }, `exit:${seq}`) });
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
    send(text: string) {
      if (exited) throw new Error('agent 进程已退出');
      queue.push(text);
      if (!turnRunning) setState('running');
      drain();
    },
    respond(requestId: string, decision: ApprovalDecision, answers?: Record<string, string>) {
      const p = pending.get(requestId);
      if (!p) return false;
      if (p.method === 'item/tool/requestUserInput') {
        if (decision === 'deny' || !answers) {
          rpc.reply(p.rpcId, { answers: {} });
        } else {
          const out: Record<string, { answers: string[] }> = {};
          for (const [question, answer] of Object.entries(answers)) {
            out[p.questionIds?.get(question) ?? question] = { answers: answer.split(', ').filter(Boolean) };
          }
          rpc.reply(p.rpcId, { answers: out });
        }
      } else {
        rpc.reply(p.rpcId, { decision: decision === 'deny' ? 'decline' : decision === 'allow_session' ? 'acceptForSession' : 'accept' });
      }
      resolveApproval(requestId, decision !== 'deny');
      return true;
    },
    async setModel(next: string) {
      // Codex 的模型按轮指定：记下来，下一次 turn/start 带上
      model = next === 'default' ? undefined : next;
      sink({ type: 'config', model: model ?? 'default' });
      return model;
    },
    async setEffort(next: string) {
      // 推理强度和模型一样按轮指定，下一次 turn/start 带上
      effort = next || undefined;
      sink({ type: 'config', effort: next });
      return next;
    },
    async setPermissionMode(next: PermissionMode) {
      mode = next;
      modeChanged = true;
      sink({ type: 'config', permissionMode: mode });
      return mode;
    },
    interrupt() {
      for (const key of [...pending.keys()]) handle.respond(key, 'deny');
      queue.length = 0;
      if (turnId && turnRunning) void rpc.request('turn/interrupt', { threadId: sessionId, turnId }).catch(() => undefined);
    },
    stop() {
      if (exited) return;
      child.stdin.end();
      // app-server 不一定因为 stdin 关闭而退出；稍等它把 rollout 写完再结束
      setTimeout(() => {
        if (!exited) child.kill('SIGTERM');
      }, 1500).unref();
    },
    exited: exitedPromise,
  };

  void (async () => {
    try {
      await rpc.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null });
      rpc.notify('initialized');
      const policy = POLICY[mode];
      const common: Rec = { cwd: req.cwd, approvalPolicy: policy.approval, sandbox: policy.sandbox };
      if (model) common.model = model;
      const res = req.resumeSessionId
        ? await rpc.request('thread/resume', { threadId: req.resumeSessionId, ...common })
        : await rpc.request('thread/start', common);
      const thread = (res.thread ?? {}) as Rec;
      sessionId = typeof thread.id === 'string' ? thread.id : sessionId;
      ctx.sessionId = sessionId;
      resolveSid(sessionId);
      sink({ type: 'config', model: typeof res.model === 'string' ? res.model : model, permissionMode: mode });
      sink({ type: 'state', state, sessionId });
      ready = true;
      drain();
    } catch (err) {
      sink({ type: 'event', event: transient({ kind: 'notice', level: 'error', code: 'start', text: `启动失败：${(err as Error).message}` }, `start:${seq}`) });
      handle.stop();
    }
  })();

  handle.send(req.prompt);
  return handle;
}

/** 起一个 app-server，只做握手 + model/list 就退出。不发消息、不花钱 */
export async function probeCodexModels(binary?: string, timeoutMs = 20_000): Promise<ModelInfo[]> {
  const rpc = spawnJsonRpc(binary ?? 'codex', ['app-server']);
  const timer = setTimeout(() => rpc.child.kill(), timeoutMs);
  try {
    await rpc.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null });
    rpc.notify('initialized');
    const res = await rpc.request('model/list', {});
    const data = Array.isArray(res.data) ? (res.data as Rec[]) : [];
    const models: ModelInfo[] = data
      .filter((m) => m.hidden !== true && typeof m.id === 'string')
      .map((m) => ({
        value: m.id as string,
        displayName: typeof m.displayName === 'string' ? m.displayName : (m.id as string),
        description: typeof m.description === 'string' ? m.description : undefined,
        resolvedModel: typeof m.model === 'string' ? m.model : undefined,
        effortLevels: Array.isArray(m.supportedReasoningEfforts)
          ? m.supportedReasoningEfforts
              .map((e) => (e && typeof e === 'object' ? (e as Rec).reasoningEffort : e))
              .filter((e): e is string => typeof e === 'string')
          : undefined,
      }));
    // 与 Claude 的列表对齐：第一项 default 表示"跟随 Codex 自己的配置"
    const def = data.find((m) => m.isDefault === true);
    return [
      {
        value: 'default',
        displayName: 'Default',
        resolvedModel: typeof def?.model === 'string' ? def.model : undefined,
        effortLevels: models.find((m) => m.value === def?.id)?.effortLevels,
      },
      ...models,
    ];
  } finally {
    clearTimeout(timer);
    rpc.child.stdin.end();
    rpc.child.kill();
  }
}

/** 窗口时长 → 名字；Codex 目前是 300 分钟与 10080 分钟两档 */
function windowLabel(mins: number | undefined): string {
  if (mins === 300) return '5 小时';
  if (mins === 10080) return '每周';
  if (!mins) return '额度';
  return mins % 1440 === 0 ? `${mins / 1440} 天` : mins % 60 === 0 ? `${mins / 60} 小时` : `${mins} 分钟`;
}

/** 套餐额度：app-server 的 account/rateLimits/read，和 Codex 自己 /status 看到的一致；不调用模型 */
export async function probeCodexQuota(binary?: string, timeoutMs = 20_000): Promise<QuotaSnapshot> {
  const rpc = spawnJsonRpc(binary ?? 'codex', ['app-server']);
  const timer = setTimeout(() => rpc.child.kill(), timeoutMs);
  try {
    await rpc.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null });
    rpc.notify('initialized');
    const res = await rpc.request('account/rateLimits/read', {});
    const rl = (res.rateLimits ?? {}) as Rec;
    const windows: QuotaWindow[] = [];
    for (const [id, w] of [['primary', rl.primary], ['secondary', rl.secondary]] as const) {
      const win = w as Rec | null | undefined;
      if (!win || typeof win.usedPercent !== 'number') continue;
      const mins = typeof win.windowDurationMins === 'number' ? win.windowDurationMins : undefined;
      windows.push({
        id: mins === 300 ? 'five_hour' : mins === 10080 ? 'seven_day' : id,
        label: windowLabel(mins),
        usedPercent: win.usedPercent,
        resetsAt: typeof win.resetsAt === 'number' ? new Date(win.resetsAt * 1000).toISOString() : undefined,
        windowMinutes: mins,
      });
    }
    const credits = (rl.credits ?? {}) as Rec;
    return {
      plan: typeof rl.planType === 'string' ? rl.planType : undefined,
      windows,
      credits:
        credits.hasCredits === true || credits.unlimited === true
          ? { enabled: true, balance: typeof credits.balance === 'string' ? credits.balance : undefined, unlimited: credits.unlimited === true }
          : undefined,
      blocked: res.ordinaryUsageAllowed === false || (rl.rateLimitReachedType !== null && rl.rateLimitReachedType !== undefined),
    };
  } finally {
    clearTimeout(timer);
    rpc.child.stdin.end();
    rpc.child.kill();
  }
}
