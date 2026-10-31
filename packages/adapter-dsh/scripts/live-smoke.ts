/**
 * 实时运行冒烟：起 dsh --profile acp，新建会话 → 切模型 → 续问 → 打断，再看磁盘回放。
 * 会产生几次很小的真实调用，以及一个新的 DSH 会话。
 * 用法：pnpm --filter @agentctl/adapter-dsh live-smoke <工作目录>
 */
import { mkdirSync } from 'node:fs';
import type { LiveMessage } from '@agentctl/core';
import { DshAdapter } from '../src/index.ts';

const cwd = process.argv[2];
if (!cwd) throw new Error('需要一个工作目录参数');
mkdirSync(cwd, { recursive: true });

const adapter = new DshAdapter();
let deltas = 0;
let idle = 0;
const t0 = Date.now();
const log = (s: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);

const handle = adapter.run!({ cwd, prompt: 'Use bash to run: echo dsh-live > d.txt . Then reply with just DONE.' }, (msg: LiveMessage) => {
  if (msg.type === 'delta') return void (deltas += 1);
  if (msg.type === 'delta_reset' || msg.type === 'queue') return;
  if (msg.type === 'config') return log(`[config] model=${msg.model ?? '-'} models=${msg.models?.map((m) => m.displayName).join(', ') ?? '-'}`);
  if (msg.type === 'state') {
    log(`[state] ${msg.state}${msg.error ? ` err=${msg.error}` : ''}`);
    if (msg.state !== 'idle') return;
    idle += 1;
    if (idle === 1) {
      void handle.setModel!('["deepseek-official","deepseek-flash"]').then((m) => {
        log(`setModel → ${m}`);
        handle.send('Reply with just the word AGAIN.');
      });
    } else if (idle === 2) {
      handle.send('Write a 2000-word essay about lighthouses.');
      setTimeout(() => handle.interrupt(), 4000);
    } else handle.stop();
    return;
  }
  const it = msg.event.item;
  log(`event ${it.kind} ${it.kind === 'notice' ? it.text : it.kind === 'approval' ? `${it.tool} ${it.state}` : ''}`);
  if (it.kind === 'approval' && it.state === 'pending') handle.respond(it.requestId, 'allow');
});

const sid = await handle.sessionId;
await handle.exited;
log(`session=${sid} 流式增量 ${deltas} 段`);
const s = (await adapter.discover()).find((x) => x.sessionId === sid);
if (!s) throw new Error('磁盘上没找到这个会话');
const win = await adapter.replay(s);
console.log(`磁盘：${s.turns} 轮，model=${s.model}`);
for (const e of win.events.filter((x) => x.item.kind === 'text' || x.item.kind === 'notice' || x.item.kind === 'tool_call')) {
  const it = e.item;
  console.log(`  t${e.turn} ${it.kind.padEnd(9)} ${it.kind === 'text' ? `${it.role}: ${it.text}` : it.kind === 'tool_call' ? it.summary : it.kind === 'notice' ? it.text : ''}`.replace(/\s+/g, ' ').slice(0, 110));
}
