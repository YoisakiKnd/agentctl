import type {
  AgentInfo,
  ApprovalDecision,
  EventWindow,
  Me,
  ModelInfo,
  PermissionMode,
  RunInfo,
  SessionSummary,
  Stats,
} from './types';

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
    request<{ session: SessionSummary; run?: RunInfo; canRun: boolean; shells?: { kind: 'agent' | 'shell' }[] }>(
      `/api/sessions/${encodeURIComponent(id)}`,
    ),
  events: (id: string, before?: number) => {
    const qs = before ? `?before=${before}` : '';
    return request<EventWindow>(`/api/sessions/${encodeURIComponent(id)}/events${qs}`);
  },

  /** 增量：从字节游标 after 读到文件末尾 */
  eventsAfter: (id: string, after: number) =>
    request<EventWindow>(`/api/sessions/${encodeURIComponent(id)}/events?after=${after}`),
  models: (agent: string) => request<{ models: ModelInfo[] }>(`/api/agents/${agent}/models`),
  setModel: (runId: string, model: string) =>
    request<{ model: string; resolved?: string }>(`/api/runs/${runId}/model`, {
      method: 'POST',
      body: JSON.stringify({ model }),
    }),
  startRun: (body: { cwd: string; prompt: string } & RunOptions) =>
    request<{ run: RunInfo }>('/api/runs', { method: 'POST', body: JSON.stringify(body) }),
  send: (sessionId: string, text: string, opts: RunOptions = {}) =>
    request<{ run: RunInfo }>(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
      method: 'POST',
      body: JSON.stringify({ text, ...opts }),
    }),
  approve: (runId: string, requestId: string, decision: ApprovalDecision, answers?: Record<string, string>) =>
    request<{ ok: boolean }>(`/api/runs/${runId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ requestId, decision, answers }),
    }),
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

export { HttpError };
