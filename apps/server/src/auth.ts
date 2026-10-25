import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16384;
const KEYLEN = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('base64url');
  const hash = scryptSync(password, salt, KEYLEN, { N: SCRYPT_N }).toString('base64url');
  return `scrypt$${SCRYPT_N}$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const [, n, salt, expected] = parts;
  const actual = scryptSync(password, salt, KEYLEN, { N: Number(n) }).toString('base64url');
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const COOKIE_NAME = 'agentctl_session';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** 会话票据：`<过期时间戳>.<签名>`，无状态，重启不掉线 */
export function issueSession(secret: string): string {
  const exp = String(Date.now() + SESSION_TTL_MS);
  return `${exp}.${sign(exp, secret)}`;
}

export function verifySession(value: string | undefined, secret: string): boolean {
  if (!value) return false;
  const idx = value.lastIndexOf('.');
  if (idx <= 0) return false;
  const exp = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  const expected = sign(exp, secret);
  if (sig.length !== expected.length) return false;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const expMs = Number(exp);
  return Number.isFinite(expMs) && expMs > Date.now();
}

/** 登录失败限速：同一 IP 5 分钟内最多 5 次 */
export class LoginThrottle {
  private readonly hits = new Map<string, number[]>();
  private readonly windowMs = 5 * 60 * 1000;
  private readonly max = 5;

  blocked(ip: string): boolean {
    const now = Date.now();
    const list = (this.hits.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    this.hits.set(ip, list);
    return list.length >= this.max;
  }

  fail(ip: string): void {
    const now = Date.now();
    const list = (this.hits.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.hits.set(ip, list);
  }

  reset(ip: string): void {
    this.hits.delete(ip);
  }
}
