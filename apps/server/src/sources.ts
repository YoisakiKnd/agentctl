import type { QuotaSnapshot, QuotaWindow } from '@agentctl/core';
import type { StoredRow } from './db.ts';

/**
 * 自定义订阅源：除 Claude、Codex 之外想一起盯着的额度 / 余额。
 *
 * - json：任意返回 JSON 的接口，按字段路径取「已用百分比」（或 已用 / 剩余 + 总量）与重置时间，
 *   或取一个余额数字；
 * - deepseek：DeepSeek 开放平台余额（GET /user/balance），只需要 API Key。
 */

export type SourceKind = 'json' | 'deepseek';

export interface SourceSnapshot extends QuotaSnapshot {
  balance?: { amount: number; unit?: string; lowBelow?: number };
}

const TIMEOUT_MS = 15_000;
const MASK = '••••';

/** 'a.b.0.c' 或 'a.b[0].c' */
export function getPath(obj: unknown, path: string): unknown {
  if (!path.trim()) return undefined;
  let cur: unknown = obj;
  for (const part of path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** 秒、毫秒时间戳或日期字符串 → ISO */
function isoOf(v: unknown): string | undefined {
  const n = num(v);
  if (n !== undefined) return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return undefined;
}

function parseHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(raw ?? '').split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (/^[A-Za-z0-9-]+$/.test(k) && v) out[k] = v;
  }
  return out;
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `：${text.slice(0, 160)}` : ''}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('返回的不是 JSON');
  }
}

/** 拉一次并解析；raw 给「测试」按钮看接口原样返回了什么 */
export async function fetchSource(row: StoredRow): Promise<{ snapshot: SourceSnapshot; raw: unknown }> {
  const c = row.config as Record<string, unknown>;
  const lowBelow = num(c.lowBelow);
  if (row.kind === 'deepseek') {
    const raw = await getJson('https://api.deepseek.com/user/balance', { authorization: `Bearer ${String(c.apiKey ?? '')}` });
    const info = getPath(raw, 'balance_infos.0') as Record<string, unknown> | undefined;
    const amount = num(info?.total_balance);
    if (amount === undefined) throw new Error('返回里没有 balance_infos[0].total_balance');
    return {
      snapshot: { windows: [], balance: { amount, unit: typeof info?.currency === 'string' ? info.currency : undefined, lowBelow }, blocked: getPath(raw, 'is_available') === false },
      raw,
    };
  }

  const raw = await getJson(String(c.url ?? ''), parseHeaders(c.headers));
  if (c.mode === 'balance') {
    const amount = num(getPath(raw, String(c.balancePath ?? '')));
    if (amount === undefined) throw new Error(`按「${String(c.balancePath)}」取不到数字`);
    const unit = c.unitPath ? String(getPath(raw, String(c.unitPath)) ?? '') : typeof c.unit === 'string' ? c.unit : undefined;
    return { snapshot: { windows: [], balance: { amount, unit: unit || undefined, lowBelow } }, raw };
  }

  let used = num(getPath(raw, String(c.usedPercentPath ?? '')));
  if (used !== undefined && c.fraction === true) used *= 100;
  if (used === undefined) {
    const limit = num(getPath(raw, String(c.limitPath ?? '')));
    const usedAbs = num(getPath(raw, String(c.usedPath ?? '')));
    const remaining = num(getPath(raw, String(c.remainingPath ?? '')));
    if (limit && usedAbs !== undefined) used = (usedAbs / limit) * 100;
    else if (limit && remaining !== undefined) used = (1 - remaining / limit) * 100;
  }
  if (used === undefined) throw new Error('取不到已用百分比：检查「已用百分比」或「已用 / 剩余 + 总量」的字段路径');
  const w: QuotaWindow = {
    id: 'main',
    // 没起名字时留空：提醒文案自己会写成「XX 额度已刷新」，不会变成「额度额度」
    label: typeof c.label === 'string' ? c.label.trim() : '',
    usedPercent: Math.round(used * 10) / 10,
    resetsAt: c.resetsAtPath ? isoOf(getPath(raw, String(c.resetsAtPath))) : undefined,
  };
  return { snapshot: { windows: [w], plan: typeof c.plan === 'string' && c.plan ? c.plan : undefined, blocked: used >= 100 }, raw };
}

const STRING_KEYS = ['url', 'headers', 'mode', 'label', 'plan', 'usedPercentPath', 'usedPath', 'remainingPath', 'limitPath', 'resetsAtPath', 'balancePath', 'unitPath', 'unit', 'apiKey'];

/** 只收认识的字段；接口地址必须是 http(s) */
export function cleanSourceConfig(kind: string, input: Record<string, unknown>, prev?: Record<string, unknown>): Record<string, unknown> {
  if (kind !== 'json' && kind !== 'deepseek') throw new Error('订阅源类型只能是 json / deepseek');
  const out: Record<string, unknown> = {};
  for (const k of STRING_KEYS) {
    const v = input[k];
    if (typeof v !== 'string') continue;
    if (v.length > 4000) throw new Error(`${k} 太长`);
    // 打码的值没改过：沿用原来的
    if ((k === 'apiKey' || k === 'headers') && v.includes(MASK) && prev) out[k] = prev[k];
    else out[k] = v.trim();
  }
  if (input.fraction === true) out.fraction = true;
  const low = num(input.lowBelow);
  if (low !== undefined) out.lowBelow = low;
  const interval = num(input.intervalMin);
  if (interval !== undefined) out.intervalMin = Math.min(Math.max(Math.round(interval), 1), 24 * 60);
  if (kind === 'deepseek' && !out.apiKey) throw new Error('请填写 DeepSeek API Key');
  if (kind === 'json') {
    if (!/^https?:\/\//.test(String(out.url ?? ''))) throw new Error('接口地址必须是 http(s):// 开头');
    if (out.mode !== 'balance') out.mode = 'percent';
    if (out.mode === 'balance' && !out.balancePath) throw new Error('请填写余额的字段路径');
    if (out.mode === 'percent' && !out.usedPercentPath && !(out.limitPath && (out.usedPath || out.remainingPath))) {
      throw new Error('请填写「已用百分比」的字段路径，或者「总量」加「已用 / 剩余」');
    }
  }
  return out;
}

/** 接口返回时把密钥打码：API Key 与请求头的值 */
export function maskSourceConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out = { ...config };
  if (typeof out.apiKey === 'string' && out.apiKey) out.apiKey = MASK + out.apiKey.slice(-4);
  if (typeof out.headers === 'string' && out.headers) {
    out.headers = out.headers
      .split('\n')
      .map((l) => {
        const i = l.indexOf(':');
        return i > 0 ? `${l.slice(0, i)}: ${MASK}${l.slice(i + 1).trim().slice(-4)}` : l;
      })
      .join('\n');
  }
  return out;
}
