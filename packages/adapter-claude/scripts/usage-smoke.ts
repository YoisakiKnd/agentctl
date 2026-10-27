/**
 * 用量冒烟：每个 Claude 会话的按天用量 vs refine 的累计花费。
 * 两者用同一套 cost-state 记账，差值只应来自"还没记账、按单价估算"的尾部回复。
 */
import { ClaudeAdapter } from '../src/index.ts';

const a = new ClaudeAdapter();
const sessions = (await a.discover()).sort((x, y) => x.mtime - y.mtime);
const started = Date.now();
let usageTotal = 0;
let ledgerTotal = 0;
let bad = 0;
for (const s of sessions) {
  const t = Date.now();
  const buckets = await a.usage(s);
  const refined = await a.refine(s);
  const cost = buckets.reduce((sum, b) => sum + (b.costUsd ?? 0), 0);
  const ledger = refined.costUsd ?? 0;
  usageTotal += cost;
  ledgerTotal += ledger;
  // 按天的总数不能比记账少（只会多出估算部分）
  const ok = cost + 0.005 >= ledger;
  if (!ok) bad += 1;
  console.log(
    `${ok ? 'ok ' : 'BAD'} ${s.sessionId.slice(0, 8)} ${(s.sizeBytes / 1e6).toFixed(0).padStart(4)}MB ${String(Date.now() - t).padStart(4)}ms ` +
      `按天 $${cost.toFixed(2)} 记账 $${ledger.toFixed(2)} ${new Set(buckets.map((b) => b.day)).size} 天`,
  );
}
console.log(`\n${sessions.length} 个会话 ${Date.now() - started}ms · 按天合计 $${usageTotal.toFixed(2)} · 记账合计 $${ledgerTotal.toFixed(2)}`);
if (bad) {
  console.error(`${bad} 个会话按天合计少于记账`);
  process.exit(1);
}
