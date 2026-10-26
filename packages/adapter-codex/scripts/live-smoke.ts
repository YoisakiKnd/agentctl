/**
 * 实时运行冒烟：真的起一次 codex app-server，走「提问 → 审批 → 执行 → 续问」，再和磁盘回放对 uid。
 * 会产生一次很小的真实调用（默认最小的模型），以及一个新的 rollout 文件。
 * 用法：pnpm --filter @agentctl/adapter-codex live-smoke <工作目录>
 */
import { mkdirSync } from 'node:fs';
import type { LiveMessage, UnifiedEvent } from '@agentctl/core';
import { CodexAdapter } from '../src/index.ts';

const cwd = process.argv[2];
if (!cwd) throw new Error('需要一个工作目录参数');
mkdirSync(cwd, { recursive: true });

const adapter = new CodexAdapter();
const live: UnifiedEvent[] = [];
let deltas = 0;
let idle = 0;

const handle = adapter.run!(
  { cwd, prompt: 'Run the shell command `echo codex > probe.txt`, then reply with just DONE.', model: process.env.MODEL ?? 'gpt-6-luna' },
  (msg: LiveMessage) => {
    if (msg.type === 'delta') return void (deltas += 1);
    if (msg.type === 'delta_reset') return;
    if (msg.type === 'config') return console.log(`[config] model=${msg.model ?? '-'} mode=${msg.permissionMode ?? '-'}`);
    if (msg.type === 'state') {
      console.log(`[state] ${msg.state}${msg.error ? ` err=${msg.error}` : ''}`);
      if (msg.state === 'idle' && ++idle === 1) handle.send('Now reply with just the word AGAIN.');
      else if (msg.state === 'idle') handle.stop();
      return;
    }
    const e = msg.event;
    live.push(e);
    const it = e.item;
    const brief = it.kind === 'text' ? `${it.role}: ${it.text}` : it.kind === 'tool_call' ? it.summary : it.kind === 'approval' ? `${it.tool} ${it.state} ${JSON.stringify(it.input)}` : it.kind === 'tool_result' ? `${it.ok} ${it.output}` : it.kind === 'notice' ? it.text : '';
    console.log(`  t${e.turn} ${it.kind.padEnd(11)} ${(e.uid ?? '').slice(0, 44).padEnd(44)} ${String(brief).replace(/\s+/g, ' ').slice(0, 70)}`);
    if (it.kind === 'approval' && it.state === 'pending') handle.respond(it.requestId, 'allow');
  },
);

const sid = await handle.sessionId;
await handle.exited;
console.log(`\nthread=${sid} 流式增量 ${deltas} 段`);

// 磁盘回放：同一批 uid 应该都在
const s = (await adapter.discover()).find((x) => x.sessionId === sid);
if (!s) throw new Error('磁盘上没找到这个线程');
const disk = (await adapter.replay(s)).events;
const onDisk = new Set(disk.map((e) => e.uid));
const persistent = live.filter((e) => !e.transient);
const missing = persistent.filter((e) => !onDisk.has(e.uid));
console.log(`磁盘回放 ${disk.length} 条；实时非临时事件 ${persistent.length} 条，磁盘缺失 ${missing.length} 条`, missing.map((e) => e.uid));
console.log('磁盘轮次：', [...new Set(disk.map((e) => e.turn))].join(','), '实时轮次：', [...new Set(persistent.map((e) => e.turn))].join(','));
