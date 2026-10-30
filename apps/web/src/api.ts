import type {
  AgentId,
  AgentInfo,
  ApprovalDecision,
  EventWindow,
  Me,
  ModelInfo,
  SearchResult,
  PermissionMode,
  RunInfo,
  SessionSummary,
  Stats,
  UsageReport,
  QuotaReport,
  RunPrefs,
  ChannelField,
  NotifyChannel,
  NotifyItem,
} from './types';

/** 上传好的附件（服务端存成了本地文件） */
export interface UploadInfo {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  path: string;
}

export interface RunOptions {
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  if (res.status === 401) {
    // 会话过期：回到登录页，保留当前位置
    if (location.hash !== '#/login') location.hash = '#/login';
    throw new HttpError(401, '需要登录');
  }
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* 响应不是 JSON，保留状态码 */
    }
    throw new HttpError(res.status, detail);
  }
  return (await res.json()) as T;
}

export const api = {
  me: () => request<Me>('/api/auth/me'),
  login: (password: string) =>
    request<{ ok: boolean }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  agents: () => request<{ agents: AgentInfo[]; stats: Stats }>('/api/agents'),
  sessions: (opts: { refresh?: boolean; agent?: string; q?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.refresh) params.set('refresh', '1');
    if (opts.agent) params.set('agent', opts.agent);
    if (opts.q) params.set('q', opts.q);
    const qs = params.toString();
    return request<{ sessions: SessionSummary[]; stats: Stats; runs: RunInfo[] }>(
      `/api/sessions${qs ? `?${qs}` : ''}`,
    );
  },
  session: (id: string) =>
    request<{
      session: SessionSummary;
      run?: RunInfo;
      prefs?: RunPrefs;
      canRun: boolean;
      canResumeInTerminal?: boolean;
      shells?: { kind: 'agent' | 'shell' }[];
    }>(
      `/api/sessions/${encodeURIComponent(id)}`,
    ),
  events: (id: string, before?: number) => {
    const qs = before ? `?before=${before}` : '';
    return request<EventWindow>(`/api/sessions/${encodeURIComponent(id)}/events${qs}`);
  },

  /** 跳转：窗口以 at 所在的那一行结尾 */
  eventsThrough: (id: string, at: number) =>
    request<EventWindow>(`/api/sessions/${encodeURIComponent(id)}/events?through=${at}`),
  search: (q: string, agent?: string, signal?: AbortSignal) => {
    const p = new URLSearchParams({ q });
    if (agent) p.set('agent', agent);
    return request<SearchResult>(`/api/search?${p}`, { signal });
  },
  /** 增量：从字节游标 after 读到文件末尾 */
  eventsAfter: (id: string, after: number) =>
    request<EventWindow>(`/api/sessions/${encodeURIComponent(id)}/events?after=${after}`),
  usage: (days: number, agent?: string) => {
    const p = new URLSearchParams({ days: String(days) });
    if (agent) p.set('agent', agent);
    return request<UsageReport>(`/api/usage?${p}`);
  },
  /** 置顶 / 标签 / 改标题；不传的字段不改，title 传空串表示恢复原标题 */
  annotate: (id: string, patch: { pinned?: boolean; tags?: string[]; title?: string }) =>
    request<{ session: SessionSummary }>(`/api/sessions/${encodeURIComponent(id)}/annotation`, {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
  /** 套餐额度；force 让服务端立刻去问 CLI（30 秒内重复会用缓存） */
  quota: (force?: boolean) => request<QuotaReport>(`/api/quota${force ? '?refresh=1' : ''}`),
  quotaSettings: (patch: { resetMinUsed?: number; disabled?: string[] }) =>
    request<{ settings: QuotaReport['settings'] }>('/api/quota/settings', { method: 'POST', body: JSON.stringify(patch) }),
  saveSource: (body: { id?: string; kind?: string; name?: string; config?: Record<string, unknown>; enabled?: boolean }) =>
    request<{ id: string }>('/api/quota/sources', { method: 'POST', body: JSON.stringify(body) }),
  deleteSource: (id: string) => request<{ ok: boolean }>(`/api/quota/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testSource: (body: { id?: string; kind: string; config: Record<string, unknown> }) =>
    request<{ snapshot: { windows: QuotaWindowLite[]; balance?: { amount: number; unit?: string } }; raw: string }>('/api/quota/sources/test', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  channels: () => request<{ channels: NotifyChannel[]; fields: Record<string, ChannelField[]>; events: { id: string; label: string }[] }>('/api/notify/channels'),
  saveChannel: (body: { id?: string; kind?: string; name?: string; config?: Record<string, string>; events?: string[]; enabled?: boolean }) =>
    request<{ channel: NotifyChannel }>('/api/notify/channels', { method: 'POST', body: JSON.stringify(body) }),
  deleteChannel: (id: string) => request<{ ok: boolean }>(`/api/notify/channels/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testChannel: (id: string) =>
    request<{ deliveries: NotifyItem['deliveries'] }>(`/api/notify/channels/${encodeURIComponent(id)}/test`, { method: 'POST' }),
  notifications: (after = 0) => request<{ items: NotifyItem[] }>(`/api/notifications${after ? `?after=${after}` : ''}`),
  tags: () => request<{ tags: { tag: string; count: number }[] }>('/api/tags'),
  models: (agent: string) => request<{ models: ModelInfo[] }>(`/api/agents/${agent}/models`),
  setModel: (runId: string, model: string) =>
    request<{ model: string; resolved?: string }>(`/api/runs/${runId}/model`, {
      method: 'POST',
      body: JSON.stringify({ model }),
    }),
  /** 下拉框一改就存：这个会话的选项，同时也成为这个 agent 的默认 */
  savePrefs: (id: string, opts: RunOptions) =>
    request<{ prefs: RunPrefs }>(`/api/sessions/${encodeURIComponent(id)}/prefs`, { method: 'POST', body: JSON.stringify(opts) }),
  runDefaults: () => request<{ defaults: Record<string, RunPrefs> }>('/api/run-defaults'),
  saveRunDefaults: (agent: AgentId, opts: RunOptions) =>
    request<{ ok: boolean }>(`/api/run-defaults/${agent}`, { method: 'POST', body: JSON.stringify(opts) }),
  checkDir: (path: string, signal?: AbortSignal) =>
    request<{ path: string; exists: boolean; creatable: boolean; error?: string }>(`/api/fs/check?${new URLSearchParams({ path })}`, { signal }),
  startRun: (body: { agent?: AgentId; cwd: string; prompt: string; createDir?: boolean; attachments?: string[] } & RunOptions) =>
    request<{ run: RunInfo }>('/api/runs', { method: 'POST', body: JSON.stringify(body) }),
  send: (sessionId: string, text: string, opts: RunOptions = {}, attachments: string[] = []) =>
    request<{ run: RunInfo }>(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
      method: 'POST',
      body: JSON.stringify({ text, ...opts, ...(attachments.length ? { attachments } : {}) }),
    }),
  /** 请求体就是文件字节；一律按 octet-stream 发，免得 .json 之类被服务端当成 JSON 解析 */
  upload: (file: File, signal?: AbortSignal) =>
    request<UploadInfo>(`/api/uploads?${new URLSearchParams({ name: file.name, type: file.type })}`, {
      method: 'POST',
      body: file,
      headers: { 'content-type': 'application/octet-stream' },
      signal,
    }),
  approve: (runId: string, requestId: string, decision: ApprovalDecision, answers?: Record<string, string>) =>
    request<{ ok: boolean }>(`/api/runs/${runId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ requestId, decision, answers }),
    }),
  setEffort: (runId: string, effort: string) =>
    request<{ effort: string; pending?: boolean }>(`/api/runs/${runId}/effort`, { method: 'POST', body: JSON.stringify({ effort }) }),
  setPermissionMode: (runId: string, mode: PermissionMode) =>
    request<{ mode: PermissionMode }>(`/api/runs/${runId}/permission-mode`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),
  health: () =>
    request<{ ok: boolean; version: string; authRequired: boolean; remote: boolean; allowBypass?: boolean }>(
      '/api/health',
    ),
  interrupt: (runId: string) =>
    request<{ ok: boolean }>(`/api/runs/${runId}/interrupt`, { method: 'POST' }),
  stop: (runId: string) => request<{ ok: boolean }>(`/api/runs/${runId}/stop`, { method: 'POST' }),
  streamUrl: (runId: string) => `/api/runs/${runId}/stream`,
};

export interface QuotaWindowLite {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt?: string;
}

export { HttpError };
