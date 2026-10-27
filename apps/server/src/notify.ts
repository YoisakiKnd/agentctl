import { randomUUID } from 'node:crypto';
import type { IndexDb, NotifyLog, StoredRow } from './db.ts';

/**
 * 提醒渠道：套餐刷新、额度快用完、余额不足时往外推一条消息。
 * 渠道配置（含 token）只存在本机索引库里；接口返回时密钥打码。
 */

export type NotifyEvent = 'reset' | 'warn' | 'low' | 'test';

export const EVENTS: { id: Exclude<NotifyEvent, 'test'>; label: string }[] = [
  { id: 'reset', label: '套餐刷新' },
  { id: 'warn', label: '额度快用完' },
  { id: 'low', label: '余额不足' },
];

export type ChannelKind = 'ntfy' | 'bark' | 'telegram' | 'webhook' | 'browser';

interface FieldSpec {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
}

/** 每种渠道要填的字段（前端按这个渲染表单） */
export const CHANNEL_FIELDS: Record<ChannelKind, FieldSpec[]> = {
  ntfy: [
    { key: 'server', label: '服务器', placeholder: 'https://ntfy.sh' },
    { key: 'topic', label: '主题（topic）', required: true },
    { key: 'token', label: '访问令牌（可选）', secret: true },
  ],
  bark: [
    { key: 'server', label: '服务器', placeholder: 'https://api.day.app' },
    { key: 'key', label: '设备 Key', required: true, secret: true },
  ],
  telegram: [
    { key: 'token', label: 'Bot Token', required: true, secret: true },
    { key: 'chatId', label: 'Chat ID', required: true },
  ],
  webhook: [
    { key: 'url', label: 'URL（POST JSON）', required: true, secret: true },
  ],
  // 浏览器通知由打开着的网页自己弹，服务端只记一条日志
  browser: [],
};

export interface Message {
  event: NotifyEvent;
  title: string;
  body: string;
  /** 订阅源 id（claude / codex / custom:xxx） */
  source?: string;
  extra?: Record<string, unknown>;
}

const MASK = '••••';

/** 密钥字段只露最后 4 位；保存时值以 •••• 开头表示"没改" */
export function maskConfig(kind: string, config: Record<string, unknown>): Record<string, unknown> {
  const out = { ...config };
  for (const f of CHANNEL_FIELDS[kind as ChannelKind] ?? []) {
    const v = out[f.key];
    if (f.secret && typeof v === 'string' && v) out[f.key] = MASK + v.slice(-4);
  }
  return out;
}

export function mergeSecrets(kind: string, next: Record<string, unknown>, prev: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of CHANNEL_FIELDS[kind as ChannelKind] ?? []) {
    const v = next[f.key];
    if (typeof v === 'string' && v.startsWith(MASK) && prev) out[f.key] = prev[f.key];
    else if (typeof v === 'string') out[f.key] = v.trim();
  }
  return out;
}

const TIMEOUT_MS = 10_000;

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`HTTP ${res.status}${text ? `：${text}` : ''}`);
  }
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

async function deliver(ch: StoredRow, m: Message): Promise<void> {
  const c = ch.config as Record<string, string | undefined>;
  switch (ch.kind as ChannelKind) {
    case 'ntfy': {
      // JSON 发布：标题、正文都能用中文（ntfy 的 Title 头不支持非 ASCII）
      const headers: Record<string, string> = c.token ? { authorization: `Bearer ${c.token}` } : {};
      await post(trimSlash(c.server || 'https://ntfy.sh'), { topic: c.topic, title: m.title, message: m.body, tags: ['agentctl'] }, headers);
      return;
    }
    case 'bark':
      await post(`${trimSlash(c.server || 'https://api.day.app')}/push`, { device_key: c.key, title: m.title, body: m.body, group: 'agentctl' });
      return;
    case 'telegram':
      await post(`https://api.telegram.org/bot${c.token}/sendMessage`, { chat_id: c.chatId, text: `${m.title}\n${m.body}` });
      return;
    case 'webhook':
      await post(String(c.url), { event: m.event, title: m.title, body: m.body, source: m.source, at: new Date().toISOString(), ...m.extra });
      return;
    case 'browser':
      return;
    default:
      throw new Error(`未知渠道类型 ${ch.kind}`);
  }
}

export function validateChannel(kind: string, config: Record<string, unknown>): void {
  const fields = CHANNEL_FIELDS[kind as ChannelKind];
  if (!fields) throw new Error('渠道类型只能是 ntfy / bark / telegram / webhook / browser');
  for (const f of fields) {
    const v = config[f.key];
    if (f.required && (typeof v !== 'string' || !v.trim())) throw new Error(`请填写「${f.label}」`);
    if (typeof v === 'string' && v.length > 2000) throw new Error(`「${f.label}」太长`);
    if ((f.key === 'server' || f.key === 'url') && typeof v === 'string' && v && !/^https?:\/\//.test(v)) {
      throw new Error(`「${f.label}」必须是 http(s):// 开头的地址`);
    }
  }
}

export class NotifyService {
  private readonly db: IndexDb;

  constructor(db: IndexDb) {
    this.db = db;
  }

  channels(): StoredRow[] {
    return this.db.listRows('notify_channel');
  }

  saveChannel(input: { id?: string; kind: string; name?: string; config: Record<string, unknown>; events?: unknown; enabled?: boolean }): StoredRow {
    const prev = input.id ? this.channels().find((c) => c.id === input.id) : undefined;
    if (input.id && !prev) throw new Error('渠道不存在');
    const kind = prev?.kind ?? input.kind;
    const config = mergeSecrets(kind, input.config ?? {}, prev?.config);
    validateChannel(kind, config);
    const events = Array.isArray(input.events)
      ? input.events.filter((e): e is string => EVENTS.some((x) => x.id === e))
      : (prev?.events ?? ['reset']);
    const row: StoredRow = {
      id: prev?.id ?? randomUUID(),
      kind,
      name: (input.name ?? prev?.name ?? kind).toString().slice(0, 60) || kind,
      config,
      events,
      enabled: input.enabled ?? prev?.enabled ?? true,
    };
    this.db.putRow('notify_channel', row);
    return row;
  }

  deleteChannel(id: string): void {
    this.db.deleteRow('notify_channel', id);
  }

  log(after = 0): NotifyLog[] {
    return this.db.listLog(after);
  }

  /** 发到所有订阅了这个事件、且开着的渠道；结果记进日志（网页的通知列表、浏览器通知也从日志里取） */
  async send(m: Message, only?: string): Promise<NotifyLog> {
    const targets = this.channels().filter((c) => (only ? c.id === only : c.enabled && (m.event === 'test' || c.events?.includes(m.event))));
    const entry: Omit<NotifyLog, 'id'> = { at: Date.now(), event: m.event, source: m.source, title: m.title, body: m.body, deliveries: [] };
    const id = this.db.addLog(entry);
    const deliveries = await Promise.all(
      targets.map(async (ch) => {
        try {
          await deliver(ch, m);
          return { channel: ch.name, ok: true };
        } catch (err) {
          // fetch 失败时真正的原因（连不上、证书、DNS）在 cause 里
          const cause = (err as { cause?: { code?: string; message?: string } }).cause;
          const error =
            err instanceof Error
              ? err.name === 'TimeoutError'
                ? '超时'
                : cause
                  ? `${err.message}（${cause.code ?? cause.message}）`
                  : err.message
              : String(err);
          return { channel: ch.name, ok: false, error };
        }
      }),
    );
    this.db.updateLogDeliveries(id, deliveries);
    for (const d of deliveries) if (!d.ok) console.error(`[notify] ${d.channel} 发送失败：${d.error}`);
    return { ...entry, id, deliveries };
  }
}
