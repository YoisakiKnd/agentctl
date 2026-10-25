/**
 * 冒烟脚本：不启动 server，直接验证适配器对本机真实会话的解析与性能。
 * 用法：pnpm smoke
 */
import { ClaudeAdapter } from '../src/index.ts';
import { AGENT_LABEL } from '@agentctl/core';

const adapter = new ClaudeAdapter();

const t0 = performance.now();
const sessions = await adapter.discover();
const discoverMs = performance.now() - t0;

console.log(`\n发现 ${sessions.length} 个 Claude 会话，耗时 ${discoverMs.toFixed(0)}ms\n`);
for (const s of sessions.slice(0, 6)) {
  const mb = (s.sizeBytes / 1024 / 1024).toFixed(1);
  console.log(
    `  ${AGENT_LABEL[s.agent].padEnd(12)} ${String(s.turns).padStart(3)} 轮  ${mb.padStart(6)}MB  ` +
      `${(s.costUsd ? `$${s.costUsd.toFixed(2)}` : '   -  ').padStart(7)}  ${s.title.slice(0, 40)}`,
  );
}

const biggest = [...sessions].sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
if (!biggest) {
  console.log('没有会话可回放');
  process.exit(0);
}

console.log(
  `\n回放最大会话：${(biggest.sizeBytes / 1024 / 1024).toFixed(1)}MB  ${biggest.file}`,
);
const t1 = performance.now();
const win = await adapter.replay(biggest);
const replayMs = performance.now() - t1;

const counts = new Map<string, number>();
for (const e of win.events) counts.set(e.item.kind, (counts.get(e.item.kind) ?? 0) + 1);

console.log(
  `首屏窗口：${win.events.length} 条事件，${replayMs.toFixed(0)}ms，` +
    `字节区间 ${win.window.start}..${win.window.end}，hasMore=${win.hasMore}`,
);
console.log('事件类型分布：', Object.fromEntries(counts));

const sample = win.events.filter((e) => e.item.kind !== 'usage').slice(-6);
console.log('\n最后几条事件：');
for (const e of sample) {
  const it = e.item;
  const label =
    it.kind === 'text'
      ? `${it.role}: ${it.text.replace(/\s+/g, ' ').slice(0, 90)}`
      : it.kind === 'tool_call'
        ? `tool_call ${it.name}: ${it.summary ?? ''}`
        : it.kind === 'tool_result'
          ? `tool_result ${it.ok ? 'ok' : 'ERR'}: ${it.output.replace(/\s+/g, ' ').slice(0, 80)}`
          : it.kind === 'thinking'
            ? `thinking: ${it.text.replace(/\s+/g, ' ').slice(0, 70)}`
            : it.kind === 'notice'
              ? `notice: ${it.text}`
              : it.kind;
  console.log(`  [t${e.turn}] ${label}`);
}

// 向前翻一页，验证游标
if (win.nextBefore) {
  const t2 = performance.now();
  const older = await adapter.replay(biggest, { before: win.nextBefore });
  console.log(
    `\n向前翻一页：${older.events.length} 条事件，${(performance.now() - t2).toFixed(0)}ms，` +
      `nextBefore=${older.nextBefore}`,
  );
}

// 后台补全摘要（轮次数 / 花费）
if (adapter.refine) {
  const t3 = performance.now();
  const refined = await adapter.refine(biggest);
  console.log(
    `refine 全量扫描：${(performance.now() - t3).toFixed(0)}ms → ` +
      `turns=${refined.turns} cost=$${refined.costUsd?.toFixed(2)} preview=${refined.preview?.slice(0, 40)}`,
  );
}
