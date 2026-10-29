import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { ClaudeAdapter } from '@agentctl/adapter-claude';
import { CodexAdapter } from '@agentctl/adapter-codex';
import { DshAdapter } from '@agentctl/adapter-dsh';
import { PiAdapter } from '@agentctl/adapter-pi';
import type { AgentAdapter } from '@agentctl/core';
import { CONFIG_PATH, expandHome, isLoopback, loadConfig, saveConfig, DB_PATH } from './config.ts';
import { hashPassword, LoginThrottle } from './auth.ts';
import { IndexDb } from './db.ts';
import { Registry } from './registry.ts';
import { registerRoutes } from './routes.ts';
import { QuotaService } from './quota.ts';
import { NotifyService } from './notify.ts';
import { RunManager } from './runs.ts';
import { ShellManager } from './shells.ts';

const VERSION = '0.8.1';

interface ServeOptions {
  host?: string;
  port?: number;
}

function parseArgs(argv: string[]): { cmd: string; rest: string[]; opts: ServeOptions } {
  const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'serve';
  const rest = cmd === argv[0] ? argv.slice(1) : argv;
  const opts: ServeOptions = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--host') opts.host = rest[++i];
    else if (a.startsWith('--host=')) opts.host = a.slice(7);
    else if (a === '--port') opts.port = Number(rest[++i]);
    else if (a.startsWith('--port=')) opts.port = Number(a.slice(7));
  }
  return { cmd, rest, opts };
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

async function cmdPasswd(args: string[]): Promise<void> {
  const cfg = loadConfig();
  let password = args.find((a) => !a.startsWith('-')) ?? process.env.AGENTCTL_PASSWORD ?? '';
  if (!password) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    password = (await rl.question('设置访问密码（输入内容会显示）：')).trim();
    rl.close();
  }
  if (password.length < 6) {
    console.error('密码至少 6 位。');
    process.exit(1);
  }
  cfg.password = hashPassword(password);
  saveConfig(cfg);
  console.log(`已写入 ${CONFIG_PATH}`);
  console.log('下次启动生效；已有登录会话在重启后仍然有效。');
}

async function cmdServe(opts: ServeOptions): Promise<void> {
  const cfg = loadConfig();
  if (opts.host) cfg.host = opts.host;
  if (opts.port) cfg.port = opts.port;
  const remote = !isLoopback(cfg.host);

  if (remote && !cfg.password) {
    console.error(
      [
        '',
        '拒绝启动：当前绑定的是非本机地址，但没有设置访问密码。',
        '',
        '  先执行：pnpm passwd',
        '  再启动：AGENTCTL_HOST=0.0.0.0 pnpm start',
        '',
        '（暴露一个能执行 agent 的控制台到局域网/公网，必须有密码。）',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  // 新增 agent：在这里加一个实现即可；config.yaml 里 agents.<id>.enabled: false 可以关掉
  const adapters: AgentAdapter[] = [new ClaudeAdapter(), new CodexAdapter(), new DshAdapter(), new PiAdapter()].filter(
    (a) => cfg.agents[a.id]?.enabled !== false,
  );
  const db = new IndexDb(DB_PATH);
  const registry = new Registry(adapters, db);
  // 进程结束后会话文件变了（轮次、花费），让列表重扫
  const notify = new NotifyService(db);
  const quota = new QuotaService({ registry, db, notify, warnPercent: () => Math.min(Math.max(Number(cfg.quotaWarnPercent) || 80, 1), 100) });
  const runs = new RunManager(
    () => registry.invalidate(),
    (run) => quota.touch(run.agent),
  );
  const shells = new ShellManager();
  const throttle = new LoginThrottle();

  const tls = cfg.tls
    ? {
        key: readFileSync(resolve(expandHome(cfg.tls.key))),
        cert: readFileSync(resolve(expandHome(cfg.tls.cert))),
      }
    : undefined;

  // https 与 http 在 Fastify 里是两个重载，返回的 server 泛型不同；
  // 这里只用到 register / listen / close，统一收敛成 FastifyInstance。
  // forceCloseConnections：SSE 是长连接，不强关的话 Ctrl+C 要等它们自己断
  const base = {
    logger: { level: process.env.AGENTCTL_LOG ?? 'warn' },
    trustProxy: true,
    forceCloseConnections: true,
  };
  const app = (
    tls ? Fastify({ ...base, https: tls }) : Fastify(base)
  ) as FastifyInstance;

  await app.register(cookie);
  // 终端输入输出要双向低延迟，用 WebSocket；单帧上限给粘贴大段文本留余地
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  await registerRoutes(app, { cfg, registry, runs, shells, quota, notify, throttle, version: VERSION, remote });

  const webDist = resolve(import.meta.dirname, '../../../apps/web/dist');
  if (existsSync(join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async (_req, reply) => {
      reply.type('text/html; charset=utf-8');
      return `<!doctype html><meta charset="utf-8"><title>agentctl</title>
<body style="font:15px/1.6 ui-monospace,monospace;background:#1B1F2A;color:#E8E4DA;padding:48px;max-width:60ch">
<h1 style="font-size:20px">agentctl · 前端尚未构建</h1>
<p>API 已经可用。先构建前端：</p>
<pre style="background:#222836;padding:16px;border:1px solid #2E3644">pnpm build</pre>
<p>然后刷新本页。</p>
<p style="color:#98A0B0">健康检查：<a href="/api/health" style="color:#C4663F">/api/health</a></p>`;
    });
  }

  // 预热：先把会话列表扫出来，首屏打开就有内容
  void registry.list(true).catch((err) => app.log.error(err));
  // 用量要全量扫所有会话：启动后稍等再在后台算一遍，打开用量页时多半已经有缓存
  quota.start();
  setTimeout(() => void registry.usage().catch((err) => app.log.error(err)), 20_000).unref();

  await app.listen({ host: cfg.host, port: cfg.port });

  const scheme = tls ? 'https' : 'http';
  const lines = [
    '',
    `  agentctl ${VERSION}  ·  ${remote ? '远程模式' : '本机模式'}  ·  ${tls ? 'TLS 已启用' : 'HTTP 明文'}`,
    '',
  ];
  // 只打印真正在服务的地址：绑了具体网卡就别把其他网卡也列出来
  if (!remote) {
    lines.push(`  本机     ${scheme}://127.0.0.1:${cfg.port}`);
  } else if (cfg.host === '0.0.0.0' || cfg.host === '::') {
    for (const ip of lanAddresses()) lines.push(`  局域网   ${scheme}://${ip}:${cfg.port}`);
  } else {
    lines.push(`  访问     ${scheme}://${cfg.host}:${cfg.port}`);
  }
  lines.push(
    '',
    `  配置     ${CONFIG_PATH}`,
    `  索引     ${DB_PATH}  (可随时删除，会自动重建)`,
    `  鉴权     ${cfg.password ? '密码已启用' : '未启用（仅本机）'}`,
    '',
  );
  if (remote && !tls) {
    lines.push(
      '  提示：跨公网访问请套一层 HTTPS 反代，或用 Tailscale/WireGuard 之类隧道；',
      '        明文 HTTP 传密码等于没设密码。',
      '',
    );
  }
  console.log(lines.join('\n'));

  const shutdown = async () => {
    runs.stopAll();
    shells.killAll();
    quota.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function main(): Promise<void> {
  const { cmd, rest, opts } = parseArgs(process.argv.slice(2));
  switch (cmd) {
    case 'serve':
      await cmdServe(opts);
      return;
    case 'passwd':
    case 'password':
      await cmdPasswd(rest);
      return;
    case 'status': {
      const cfg = loadConfig();
      console.log(`配置：${CONFIG_PATH}`);
      console.log(`监听：${cfg.host}:${cfg.port}`);
      console.log(`密码：${cfg.password ? '已设置' : '未设置'}`);
      console.log(`网页端 bypassPermissions：${cfg.allowBypassPermissions ? '允许' : '禁止'}`);
      return;
    }
    case '--help':
    case '-h':
    case 'help':
      console.log(
        [
          'agentctl —— 多智能体会话管理台',
          '',
          '  agentctl [serve] [--host 0.0.0.0] [--port 8787]   启动 Web 控制台',
          '  pnpm passwd [密码]                               设置访问密码',
          '  agentctl status                                   查看配置与监听地址',
          '',
          `配置目录：${process.env.AGENTCTL_HOME ?? '~/.agentctl'}`,
        ].join('\n'),
      );
      return;
    default:
      console.error(`未知命令：${cmd}（试试 agentctl --help）`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
