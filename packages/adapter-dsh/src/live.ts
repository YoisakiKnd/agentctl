/**
 * DSH 实时运行：`dsh --profile acp`（Agent Client Protocol，JSON-RPC over stdio）。
 *
 * 为什么不用 `--profile sdk`：SDK 只能新建会话（对已有 id 报 "already exists"），也没有取消与审批。
 * ACP 有 session/resume、session/cancel、session/request_permission。
 *
 * ACP 推送的 session/update 和会话文件不是同一套记录，没法按 uid 与磁盘回放去重，所以这里
 * 只拿它做三件事：打字机草稿、审批卡、运行状态。时间线上的正式事件全部来自会话文件的增量追尾
 * （DSH 每条记录都会立刻追加一帧），这样实时与回放天然一致。
 */
import {
  oneLine,
  spawnJsonRpc,
  type ApprovalDecision,
  type ModelInfo,
  type RunHandle,
  type RunRequest,
  type RunSink,
  type RunState,
  type UnifiedEvent,
} from '@agentctl/core';

type Rec = Record<string, unknown>;

const IDLE_EXIT_MS = 30 * 60_000;
const STDERR_KEEP = 4096;

interface Pending {
  rpcId: number | string;
  options: { optionId: string; kind: string }[];
  event: UnifiedEvent;
}

/** ACP 的 configOptions → 模型列表；模型值是 '["provider","model"]' 这样的 JSON 字符串 */
function modelsOf(configOptions: unknown): { models: ModelInfo[]; current?: string } {
  const opts = Array.isArray(configOptions) ? (configOptions as Rec[]) : [];
  const model = opts.find((o) => o.id === 'model' || o.category === 'model');
  const effort = opts.find((o) => o.id === 'reasoning_effort' || o.category === 'thought_level');
  const flat = (o: Rec | undefined) =>
    (Array.isArray(o?.options) ? (o.options as Rec[]) : []).flatMap((g) =>
      Array.isArray(g.options) ? (g.options as Rec[]).map((x) => ({ ...x, group: g.name })) : [g],
    );
  const efforts = flat(effort)
    .map((e) => e.value)
    .filter((v): v is string => typeof v === 'string');
  const models: ModelInfo[] = flat(model)
    .filter((m) => typeof m.value === 'string')
    .map((m) => ({
      value: m.value as string,
      displayName: typeof m.name === 'string' ? m.name : (m.value as string),
      description: typeof m.group === 'string' ? m.group : undefined,
      effortLevels: efforts.length ? efforts : undefined,
    }));
  return { models, current: typeof model?.currentValue === 'string' ? model.currentValue : undefined };
}

export function startDshRun(req: RunRequest, sink: RunSink): RunHandle {
  const rpc = spawnJsonRpc(req.binary ?? 'dsh', ['--profile', 'acp'], req.cwd);
  const { child } = rpc;

  let sessionId = req.resumeSessionId ?? '';
  let resolveSid!: (id: string) => void;
  let rejectSid!: (err: Error) => void;
  const sessionIdPromise = new Promise<string>((res, rej) => {
    resolveSid = res;
    rejectSid = rej;
  });
  sessionIdPromise.catch(() => undefined);

  const pending = new Map<string, Pending>();
  const queue: string[] = [];
  let ready = false;
  let prompting = false;
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
    agent: 'dsh',
    sessionId,
    turn: 0,
    seq: seq++,
    ts: new Date().toISOString(),
    item,
    uid,
    transient: true,
  });
  const fail = (text: string) =>
    sink({ type: 'event', event: transient({ kind: 'notice', level: 'error', code: 'error', text }, `err:${seq}`) });

  const resolveApproval = (key: string, approved: boolean) => {
    const p = pending.get(key);
    if (!p || p.event.item.kind !== 'approval') return;
    pending.delete(key);
    sink({ type: 'event', event: { ...p.event, item: { ...p.event.item, state: approved ? 'approved' : 'denied' } } });
  };

  const drain = () => {
    if (!ready || prompting) return;
    const text = queue.shift();
    if (text === undefined) {
      setState('idle');
      return;
    }
    prompting = true;
    setState('running');
    rpc
      .request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
      .then((r) => {
        if (r.stopReason === 'refusal') fail('模型拒绝了这次请求');
      })
      .catch((err: Error) => fail(`本轮失败：${oneLine(err.message, 300)}`))
      .finally(() => {
        prompting = false;
        for (const key of [...pending.keys()]) resolveApproval(key, false);
        sink({ type: 'delta_reset' });
        drain();
      });
  };

  rpc.onNotification = (method, params) => {
    if (method !== 'session/update') return;
    const u = (params.update ?? {}) as Rec;
    const content = (u.content ?? {}) as Rec;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (typeof content.text === 'string') sink({ type: 'delta', block: 'text', text: content.text });
        return;
      case 'agent_thought_chunk':
        if (typeof content.text === 'string') sink({ type: 'delta', block: 'thinking', text: content.text });
        return;
      case 'tool_call':
        // 正文块结束、开始调工具：草稿交给磁盘上的正式消息
        sink({ type: 'delta_reset' });
        return;
      default:
        return;
    }
  };

  rpc.onServerRequest = (id, method, params) => {
    if (method !== 'session/request_permission') {
      // 我们声明了不提供文件系统 / 终端能力，其余请求一律拒绝
      rpc.replyError(id, `agentctl 不支持 ${method}`);
      return;
    }
    const key = `perm:${String(id)}`;
    const tool = (params.toolCall ?? {}) as Rec;
    const options = (Array.isArray(params.options) ? params.options : []) as Rec[];
    const event = transient(
      {
        kind: 'approval',
        requestId: key,
        tool: typeof tool.title === 'string' ? tool.title : 'tool',
        detail: typeof (tool.rawInput as Rec | undefined)?.description === 'string' ? String((tool.rawInput as Rec).description) : '',
        input: tool.rawInput,
        choices: ['allow', 'allow_session', 'deny'],
        state: 'pending',
      },
      `approval:${key}`,
    );
    pending.set(key, {
      rpcId: id,
      options: options.map((o) => ({ optionId: String(o.optionId ?? ''), kind: String(o.kind ?? '') })),
      event,
    });
    sink({ type: 'event', event });
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
      const reason = spawnError?.message ?? (code ? oneLine(stderrTail, 400) : '');
      if (reason) fail(`进程退出：${reason}`);
      rejectSid(new Error(reason || 'agent 进程在分配会话前退出'));
      state = 'exited';
      sink({ type: 'state', state, sessionId: sessionId || undefined, exitCode: code, error: reason || undefined });
      resolve({ code, signal });
    };
    child.on('error', (err) => finish(null, null, err));
    child.on('exit', (code, signal) => finish(code, signal));
  });

  const setConfig = async (configId: string, value: string) => {
    const r = await rpc.request('session/set_config_option', { sessionId, configId, value });
    return modelsOf(r.configOptions);
  };

  const handle: RunHandle = {
    sessionId: sessionIdPromise,
    send(text: string) {
      if (exited) throw new Error('agent 进程已退出');
      queue.push(text);
      setState('running');
      drain();
    },
    respond(requestId: string, decision: ApprovalDecision) {
      const p = pending.get(requestId);
      if (!p) return false;
      const want = decision === 'deny' ? ['reject_once', 'reject_always'] : decision === 'allow_session' ? ['allow_always', 'allow_once'] : ['allow_once', 'allow_always'];
      const option = want.map((k) => p.options.find((o) => o.kind === k)).find(Boolean);
      rpc.reply(p.rpcId, option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } });
      resolveApproval(requestId, decision !== 'deny');
      return true;
    },
    async setModel(model: string) {
      const { current } = await setConfig('model', model);
      sink({ type: 'config', model: current ?? model });
      return current ?? model;
    },
    interrupt() {
      for (const key of [...pending.keys()]) handle.respond(key, 'deny');
      queue.length = 0;
      if (sessionId && prompting) rpc.notify('session/cancel', { sessionId });
    },
    stop() {
      if (exited) return;
      child.stdin.end();
      setTimeout(() => {
        if (!exited) child.kill('SIGTERM');
      }, 1500).unref();
    },
    exited: exitedPromise,
  };

  void (async () => {
    try {
      await rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      const res = req.resumeSessionId
        ? await rpc.request('session/resume', { sessionId: req.resumeSessionId, cwd: req.cwd, mcpServers: [] })
        : await rpc.request('session/new', { cwd: req.cwd, mcpServers: [] });
      if (typeof res.sessionId === 'string') sessionId = res.sessionId;
      resolveSid(sessionId);
      let { models, current } = modelsOf(res.configOptions);
      // 启动时指定的模型 / 推理强度：会话建立后再设
      if (req.model && req.model !== 'default' && req.model !== current) ({ models, current } = await setConfig('model', req.model));
      if (req.effort) await setConfig('reasoning_effort', req.effort).catch(() => undefined);
      sink({ type: 'config', model: current, models });
      sink({ type: 'state', state, sessionId });
      ready = true;
      drain();
    } catch (err) {
      fail(`启动失败：${(err as Error).message}`);
      handle.stop();
    }
  })();

  handle.send(req.prompt);
  return handle;
}
