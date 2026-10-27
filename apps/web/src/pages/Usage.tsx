import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { formatTokens, projectName, timeAgo } from '../format';
import { navigate, sessionHref, usageHref } from '../router';
import type { AgentId, UsageReport, UsageTotals } from '../types';
import { AGENT_LABEL } from '../types';

/** 堆叠顺序固定：颜色跟着 agent 走，筛选后剩下的不会变色 */
const AGENTS: AgentId[] = ['claude', 'codex', 'dsh', 'pi', 'cursor'];
const RANGES: { days: number; label: string }[] = [
  { days: 7, label: '7 天' },
  { days: 30, label: '30 天' },
  { days: 90, label: '90 天' },
  { days: 0, label: '全部' },
];

type Metric = 'cost' | 'tokens';

/** 图表与表格的 token 口径：新输入 + 输出。缓存读写量大但便宜，另列 */
const io = (t: UsageTotals) => t.inputTokens + t.outputTokens;

function money(usd: number | undefined): string {
  if (usd === undefined) return '—';
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  return usd >= 1000 ? `$${Math.round(usd).toLocaleString()}` : `$${usd.toFixed(2)}`;
}

function dayLabel(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/** 把轴的最大值取整到 1/2/5 × 10^n，刻度落在整数上 */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

interface Column {
  day: string;
  parts: { agent: AgentId; value: number; totals: UsageTotals }[];
  total: number;
}

function DailyChart({ report, metric }: { report: UsageReport; metric: Metric }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const columns = useMemo<Column[]>(() => {
    const byDay = new Map<string, Column>();
    for (const day of report.days) byDay.set(day, { day, parts: [], total: 0 });
    for (const d of report.daily) {
      const col = byDay.get(d.day);
      if (!col) continue;
      const value = metric === 'cost' ? (d.costUsd ?? 0) : io(d);
      if (value <= 0) continue;
      col.parts.push({ agent: d.agent, value, totals: d });
      col.total += value;
    }
    for (const col of byDay.values()) col.parts.sort((a, b) => AGENTS.indexOf(a.agent) - AGENTS.indexOf(b.agent));
    return [...byDay.values()];
  }, [report, metric]);

  const present = AGENTS.filter((a) => columns.some((c) => c.parts.some((p) => p.agent === a)));
  const max = niceMax(Math.max(0, ...columns.map((c) => c.total)));
  const fmt = (v: number) => (metric === 'cost' ? money(v) : formatTokens(Math.round(v)));
  // 刻度是整数，不必带两位小数
  const tick = (v: number) => (metric === 'cost' && max >= 10 ? `$${Math.round(v)}` : fmt(v));

  const H = 200;
  const axisW = 52;
  const plotW = Math.max(0, width - axisW);
  const slot = columns.length ? plotW / columns.length : 0;
  const barW = Math.min(24, Math.max(1, slot - 2));
  const ticks = [0, max / 2, max];
  // 横轴标签挑着标，保证相邻两个之间至少 44px；从最右（今天）往回数，今天一定有标签
  const every = Math.max(1, Math.ceil(44 / Math.max(slot, 1)));
  const labeled = (i: number) => (columns.length - 1 - i) % every === 0;

  const hv = hover !== null ? columns[hover] : null;

  return (
    <div className="chart">
      <div className="chart__legend">
        {present.map((a) => (
          <span key={a} className="chart__key">
            <span className="chart__swatch" style={{ background: `var(--${a})` }} />
            {AGENT_LABEL[a]}
          </span>
        ))}
        {metric === 'cost' ? <span className="chart__note">Codex、DSH 不记账，不在花费图里</span> : null}
      </div>
      <div className="chart__plot" ref={box} onMouseLeave={() => setHover(null)}>
        {width > 0 ? (
          <svg width={width} height={H + 24} role="img" aria-label={`每日${metric === 'cost' ? '花费' : 'token'}，按 agent 堆叠`}>
            {ticks.map((t) => {
              const y = H - (t / max) * H + 0.5;
              return (
                <g key={t}>
                  <line x1={axisW} x2={width} y1={y} y2={y} className="chart__grid" />
                  <text x={axisW - 8} y={y + 4} className="chart__tick" textAnchor="end">
                    {tick(t)}
                  </text>
                </g>
              );
            })}
            {columns.map((c, i) => {
              const x = axisW + i * slot + (slot - barW) / 2;
              let y = H;
              const segs = c.parts.map((p, j) => {
                const h = (p.value / max) * H;
                // 段与段之间留 2px 底色缝；太矮的段不留缝，免得整段消失
                const gap = j > 0 && h > 3 ? 2 : 0;
                const top = y - h;
                const seg = { agent: p.agent, y: top, h: Math.max(0, h - gap), last: j === c.parts.length - 1 };
                y = top;
                return seg;
              });
              return (
                <g key={c.day} className={hover === i ? 'is-hover' : undefined}>
                  {segs.map((s) =>
                    s.last ? (
                      <path key={s.agent} d={roundTop(x, s.y, barW, s.h)} fill={`var(--${s.agent})`} />
                    ) : (
                      <rect key={s.agent} x={x} y={s.y} width={barW} height={s.h} fill={`var(--${s.agent})`} />
                    ),
                  )}
                  {labeled(i) ? (
                    <text x={axisW + i * slot + slot / 2} y={H + 17} className="chart__tick" textAnchor="middle">
                      {dayLabel(c.day)}
                    </text>
                  ) : null}
                  {/* 命中区比柱子大：整列都能触发 */}
                  <rect
                    x={axisW + i * slot}
                    y={0}
                    width={slot}
                    height={H}
                    fill="transparent"
                    onMouseEnter={() => setHover(i)}
                    onClick={() => setHover(i)}
                  />
                </g>
              );
            })}
            <line x1={axisW} x2={width} y1={H + 0.5} y2={H + 0.5} className="chart__axis" />
          </svg>
        ) : null}
        {hv && hover !== null ? (
          <div
            className="chart__tip"
            // 放在柱子旁边而不是压在柱子上：右半边的列往左放，左半边的往右放
            style={(() => {
              const x = axisW + hover * slot + slot / 2;
              return x > width / 2 ? { right: width - x + slot / 2 + 8 } : { left: x + slot / 2 + 8 };
            })()}
          >
            <div className="chart__tipday num">{hv.day}</div>
            {hv.parts.length ? (
              hv.parts.map((p) => (
                <div key={p.agent} className="chart__tiprow num">
                  <span className="chart__swatch" style={{ background: `var(--${p.agent})` }} />
                  <span>{AGENT_LABEL[p.agent]}</span>
                  <span className="chart__tipval">{fmt(p.value)}</span>
                </div>
              ))
            ) : (
              <div className="is-faint">没有用量</div>
            )}
            {hv.parts.length > 1 ? (
              <div className="chart__tiprow chart__tiptotal num">
                <span />
                <span>合计</span>
                <span className="chart__tipval">{fmt(hv.total)}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 只圆顶上两个角（4px），底部贴基线是方的 */
function roundTop(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function TotalsRow({ label, t, extra, rail }: { label: React.ReactNode; t: UsageTotals; extra?: React.ReactNode; rail?: AgentId }) {
  return (
    <tr>
      <th scope="row">
        <span className="utable__name">
          {rail ? <span className="chart__swatch" style={{ background: `var(--${rail})` }} /> : null}
          {label}
        </span>
      </th>
      {extra}
      <td className="num">{t.messages.toLocaleString()}</td>
      <td className="num">{formatTokens(t.inputTokens)}</td>
      <td className="num">{formatTokens(t.outputTokens)}</td>
      <td className="num utable__dim">{formatTokens(t.cacheRead)}</td>
      <td className="num utable__dim">{formatTokens(t.cacheWrite)}</td>
      <td className="num">{money(t.costUsd)}</td>
    </tr>
  );
}

const HEAD = (
  <>
    <th scope="col">回复</th>
    <th scope="col">输入</th>
    <th scope="col">输出</th>
    <th scope="col">缓存读</th>
    <th scope="col">缓存写</th>
    <th scope="col">花费</th>
  </>
);

/** 用量统计：所有 agent 按天、按模型、按会话 */
export default function Usage({ days, agent }: { days: number; agent?: string }) {
  const [data, setData] = useState<UsageReport | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [metric, setMetric] = useState<Metric>('cost');
  const [table, setTable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError('');
    api
      .usage(days, agent)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        // 只看不记账的 agent 时花费图是空的，直接切到 token
        if (d.totals.costUsd === undefined) setMetric('tokens');
      })
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : '加载失败'))
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
  }, [days, agent]);

  const t = data?.totals;
  const rangeLabel = RANGES.find((r) => r.days === days)?.label ?? `${days} 天`;
  const hasCost = t?.costUsd !== undefined;
  const activeDays = data ? new Set(data.daily.map((d) => d.day)).size : 0;

  return (
    <div className="shell">
      <aside className="spine">
        <div className="spine__brand">agentctl</div>
        <nav className="spine__agents">
          <a className="nav" href="#/">
            <span className="nav__label">会话</span>
          </a>
          <span className="nav is-active" style={{ '--agent': 'var(--text)' } as React.CSSProperties}>
            <span className="nav__label">用量</span>
          </span>
        </nav>
      </aside>

      <main className="board">
        <header className="board__head">
          <h1 className="board__title">用量统计</h1>
          <div className="usage__ranges" role="group" aria-label="时间范围">
            {RANGES.map((r) => (
              <button
                key={r.days}
                type="button"
                className={`chip chip--btn${r.days === days ? ' is-on' : ''}`}
                onClick={() => navigate(usageHref(r.days, agent).slice(1))}
              >
                {r.label}
              </button>
            ))}
          </div>
        </header>

        <div className="search__filters">
          {[undefined, ...AGENTS.filter((a) => a !== 'cursor')].map((a) => (
            <button
              key={a ?? 'all'}
              type="button"
              className={`chip chip--btn${agent === a ? ' is-on' : ''}`}
              onClick={() => navigate(usageHref(days, a).slice(1))}
            >
              {a ? AGENT_LABEL[a] : '全部 agent'}
            </button>
          ))}
        </div>

        {error ? <div className="empty empty--error">{error}</div> : null}
        {busy && !data ? <div className="search__status">正在统计所有会话，第一次要完整扫一遍，可能要几秒…</div> : null}

        {data && t ? (
          <div className={busy ? 'is-stale' : undefined}>
            <dl className="tiles">
              <div className="tile tile--hero">
                <dt>花费 · {rangeLabel}</dt>
                <dd className="num">{money(t.costUsd)}</dd>
              </div>
              <div className="tile">
                <dt>输入 + 输出</dt>
                <dd className="num">{formatTokens(io(t))}</dd>
              </div>
              <div className="tile">
                <dt>缓存读</dt>
                <dd className="num">{formatTokens(t.cacheRead)}</dd>
              </div>
              <div className="tile">
                <dt>回复</dt>
                <dd className="num">{t.messages.toLocaleString()}</dd>
              </div>
              <div className="tile">
                <dt>会话 · 活跃天数</dt>
                <dd className="num">
                  {t.sessions} · {activeDays}
                </dd>
              </div>
            </dl>

            <section className="section">
              <div className="section__head">
                <h2 className="section__title">每天</h2>
                <div className="usage__metric" role="group" aria-label="指标">
                  <button
                    type="button"
                    className={`chip chip--btn${metric === 'cost' ? ' is-on' : ''}`}
                    onClick={() => setMetric('cost')}
                    disabled={!hasCost}
                  >
                    花费
                  </button>
                  <button
                    type="button"
                    className={`chip chip--btn${metric === 'tokens' ? ' is-on' : ''}`}
                    onClick={() => setMetric('tokens')}
                  >
                    token（输入 + 输出）
                  </button>
                  <button type="button" className="linkbtn" onClick={() => setTable((v) => !v)}>
                    {table ? '看图' : '看表格'}
                  </button>
                </div>
              </div>
              {table ? (
                <div className="utable__wrap">
                  <table className="utable">
                    <thead>
                      <tr>
                        <th scope="col">日期</th>
                        <th scope="col">agent</th>
                        {HEAD}
                      </tr>
                    </thead>
                    <tbody>
                      {[...data.daily].reverse().map((d) => (
                        <TotalsRow
                          key={`${d.day}|${d.agent}`}
                          label={<span className="num">{d.day}</span>}
                          t={d}
                          extra={<td>{AGENT_LABEL[d.agent]}</td>}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <DailyChart report={data} metric={metric} />
              )}
            </section>

            <section className="section">
              <div className="section__head">
                <h2 className="section__title">按 agent</h2>
              </div>
              <div className="utable__wrap">
                <table className="utable">
                  <thead>
                    <tr>
                      <th scope="col">agent</th>
                      <th scope="col">会话</th>
                      {HEAD}
                    </tr>
                  </thead>
                  <tbody>
                    {data.agents.map((a) => (
                      <TotalsRow key={a.agent} label={AGENT_LABEL[a.agent]} rail={a.agent} t={a} extra={<td className="num">{a.sessions}</td>} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="section">
              <div className="section__head">
                <h2 className="section__title">按模型</h2>
              </div>
              <div className="utable__wrap">
                <table className="utable">
                  <thead>
                    <tr>
                      <th scope="col">模型</th>
                      {HEAD}
                    </tr>
                  </thead>
                  <tbody>
                    {data.models.map((m) => (
                      <TotalsRow key={`${m.agent}|${m.model}`} label={<span className="mono">{m.model}</span>} rail={m.agent} t={m} />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="section">
              <div className="section__head">
                <h2 className="section__title">用得最多的会话</h2>
                <span className="section__hint">{rangeLabel}内，前 {data.sessions.length} 个</span>
              </div>
              {data.sessions.map((s) => (
                <a className="urow" key={s.id} href={sessionHref(s.id)} style={{ '--agent': `var(--${s.agent})` } as React.CSSProperties}>
                  <span className="sess__rail" aria-hidden="true" />
                  <span className="urow__title">{s.title}</span>
                  <span className="urow__val num">{s.costUsd !== undefined ? money(s.costUsd) : `${formatTokens(io(s))} token`}</span>
                  <span className="urow__meta num">
                    {AGENT_LABEL[s.agent]} · {projectName(s.cwd)} · {s.messages} 次回复 · {timeAgo(s.updatedAt)}
                  </span>
                </a>
              ))}
            </section>

            <p className="usage__foot">
              数字来自各 agent 自己写在会话文件里的记录：Claude 用它自己记的花费，按每条回复的 token 摊到各天，还没记账的部分按实际单价估算；Pi
              每条回复自带花费；Codex、DSH 只记 token。缓存读写单独列出，不计入「输入 + 输出」。
              <span className="is-faint"> · 统计耗时 {(data.ms / 1000).toFixed(1)}s</span>
            </p>
          </div>
        ) : null}
      </main>
    </div>
  );
}
