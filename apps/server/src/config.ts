import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import yaml from 'js-yaml';

export interface AgentConfig {
  enabled: boolean;
  /** 覆盖默认数据目录（支持 ~ 展开） */
  projectsDir?: string;
}

export interface Config {
  host: string;
  port: number;
  /** scrypt 哈希，由 `pnpm passwd` 写入；空表示未启用密码 */
  password?: string;
  /** cookie 签名密钥，首次启动自动生成 */
  secret: string;
  /** 放在 HTTPS 反代后面时打开 */
  cookieSecure: boolean;
  /** 允许浏览的目录白名单；空表示不限制（仅本机模式） */
  allowedRoots: string[];
  /**
   * 网页端能否使用 bypassPermissions（跳过一切权限检查）。
   * 能登录的人本来就能在审批卡上点"允许"，所以默认开；想把网页端限制为必须审批时设为 false。
   */
  allowBypassPermissions: boolean;
  tls?: { cert: string; key: string };
  agents: Record<string, AgentConfig>;
}

export const HOME = homedir();
export const CONFIG_DIR = process.env.AGENTCTL_HOME ?? join(HOME, '.agentctl');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.yaml');
export const DB_PATH = join(CONFIG_DIR, 'index.db');

export function expandHome(p: string): string {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return join(HOME, p.slice(2));
  return p;
}

function defaults(): Config {
  return {
    host: '127.0.0.1',
    port: 8787,
    secret: randomBytes(32).toString('base64url'),
    cookieSecure: false,
    allowedRoots: [],
    allowBypassPermissions: true,
    agents: {
      claude: { enabled: true },
      codex: { enabled: true },
    },
  };
}

export function loadConfig(): Config {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  let cfg: Config;
  if (!existsSync(CONFIG_PATH)) {
    cfg = defaults();
    saveConfig(cfg);
  } else {
    const parsed = (yaml.load(readFileSync(CONFIG_PATH, 'utf8')) ?? {}) as Partial<Config>;
    cfg = { ...defaults(), ...parsed, agents: { ...defaults().agents, ...parsed.agents } };
    if (!parsed.secret) saveConfig(cfg);
  }
  // 临时覆盖，只作用于本次进程、不写回文件：AGENTCTL_HOST=0.0.0.0 pnpm start
  if (process.env.AGENTCTL_HOST) cfg.host = process.env.AGENTCTL_HOST;
  if (process.env.AGENTCTL_PORT) cfg.port = Number(process.env.AGENTCTL_PORT);
  return cfg;
}

export function saveConfig(cfg: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const header =
    '# agentctl 配置\n' +
    '# 远程访问（host 非 127.0.0.1）必须先用 `pnpm passwd` 设置密码。\n';
  writeFileSync(CONFIG_PATH, header + yaml.dump(cfg, { lineWidth: 120 }), { mode: 0o600 });
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** 只允许白名单内的绝对路径（远程模式的安全底线） */
export function isPathAllowed(cfg: Config, target: string): boolean {
  if (cfg.allowedRoots.length === 0) return true;
  const abs = resolve(expandHome(target));
  return cfg.allowedRoots.some((root) => {
    const r = resolve(expandHome(root));
    return abs === r || abs.startsWith(`${r}/`);
  });
}

export function resolveProjectDir(cfg: Config, agentId: string, fallback: string): string {
  const configured = cfg.agents[agentId]?.projectsDir;
  if (!configured) return fallback;
  const p = expandHome(configured);
  return isAbsolute(p) ? p : resolve(CONFIG_DIR, p);
}
