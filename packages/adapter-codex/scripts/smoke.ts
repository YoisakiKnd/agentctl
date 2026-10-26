/**
 * 冒烟：不启动 server，直接验证 Codex 适配器对本机真实会话的解析。
 * 用法：pnpm --filter @agentctl/adapter-codex smoke
 */
import { CodexAdapter } from '../src/index.ts';

const adapter = new CodexAdapter();
const t0 = performance.now();
const sessions = await adapter.discover();
console.log(`\n发现 ${sessions.length} 个 Codex 会话，耗时 ${(performance.now() - t0).toFixed(0)}ms\n`);
for (const s of sessions) {
  console.log(
    `  ${String(s.turns).padStart(3)} 轮 ${(s.sizeBytes / 1024).toFixed(0).padStart(6)}KB  ${(s.model ?? '-').padEnd(14)}` +
      ` ${s.subagent ? `[${s.subagent}] ` : ''}${s.title.slice(0, 40)}  · ${s.cwd}`,
  );
}

for (const s of sessions) {
  const t1 = performance.now();
  const win = await adapter.replay(s);
  const counts: Record<string, number> = {};
  for (const e of win.events) counts[e.item.kind] = (counts[e.item.kind] ?? 0) + 1;
  const uids = new Set(win.events.map((e) => e.uid));
  const turns = [...new Set(win.events.map((e) => e.turn))];
  console.log(
    `\n${s.title.slice(0, 30)}：${win.events.length} 条事件 ${(performance.now() - t1).toFixed(0)}ms，` +
      `uid 唯一=${uids.size === win.events.length}，轮次 ${turns[0]}..${turns[turns.length - 1]}`,
  );
  console.log('  ', JSON.stringify(counts));
  for (const e of win.events.filter((x) => x.item.kind !== 'usage').slice(-4)) {
    const it = e.item;
    const brief =
      it.kind === 'text' ? `${it.role}: ${it.text}` : it.kind === 'tool_call' ? `${it.name} ${it.summary ?? ''}` :
      it.kind === 'tool_result' ? `${it.ok ? 'ok' : 'ERR'} ${it.output}` : it.kind === 'diff' ? it.files.map((f) => `${f.path} +${f.added}-${f.removed}`).join(', ') :
      it.kind === 'notice' ? it.text : it.kind === 'thinking' ? it.text : '';
    console.log(`    t${e.turn} ${it.kind.padEnd(11)} ${brief.replace(/\s+/g, ' ').slice(0, 90)}`);
  }
}
