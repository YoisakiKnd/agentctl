/**
 * 实时运行冒烟：真的 spawn 一次 claude，走一遍「提问 → 审批 → 工具执行 → 续问」。
 * 会产生一次很小的真实调用（默认 haiku），以及一个新的会话文件。
 * 用法：pnpm --filter @agentctl/adapter-claude live-smoke [工作目录]
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LiveMessage } from '@agentctl/core';
import { ClaudeAdapter } from '../src/index.ts';

const cwd = process.argv[2] ?? join(tmpdir(), 'agentctl-live-smoke');
mkdirSync(cwd, { recursive: true });

const adapter = new ClaudeAdapter();
const seen = new Map<string, number>();
let deltas = 0;
let turnsDone = 0;

const handle = adapter.run(
  {
    cwd,
    prompt: 'Run the bash command `echo agentctl > probe.txt`, then reply with just the word DONE.',
    model: process.env.MODEL ?? 'haiku',
  },
  (msg: LiveMessage) => {
    if (msg.type === 'delta') {
      deltas += 1;
      return;
    }
    if (msg.type === 'delta_reset' || msg.type === 'config') return;
    if (msg.type === 'state') {
      console.log(`[state] ${msg.state}${msg.sessionId ? ` sid=${msg.sessionId}` : ''}${msg.error ? ` err=${msg.error}` : ''}`);
      if (msg.state === 'idle') {
        turnsDone += 1;
        if (turnsDone === 1) handle.send('Now reply with just the word AGAIN.');
        else handle.stop();
      }
      return;
    }
    const { item, uid, turn } = msg.event;
    seen.set(item.kind, (seen.get(item.kind) ?? 0) + 1);
    const brief =
      item.kind === 'text'
        ? `${item.role}: ${item.text.slice(0, 60)}`
        : item.kind === 'tool_call'
          ? `${item.name} ${item.summary ?? ''}`
          : item.kind === 'approval'
            ? `${item.tool} ${item.state} · ${item.detail}`
            : item.kind === 'notice'
              ? item.text
              : item.kind === 'tool_result'
                ? `${item.ok ? 'ok' : 'ERR'} ${item.output.slice(0, 50)}`
                : '';
    console.log(`  t${turn} ${item.kind.padEnd(11)} ${uid}  ${brief}`);
    if (item.kind === 'approval' && item.state === 'pending') handle.respond(item.requestId, 'allow');
  },
);

const sid = await handle.sessionId;
const exit = await handle.exited;
console.log(`\nsessionId=${sid} exit=${exit.code} 流式增量 ${deltas} 段`);
console.log('事件分布：', Object.fromEntries(seen));
