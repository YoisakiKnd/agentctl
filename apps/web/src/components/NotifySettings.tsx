import { useEffect, useState } from 'react';
import { api } from '../api';
import { quotaStore, useQuota } from '../store';
import type { ChannelField, ChannelKind, NotifyChannel, NotifyItem, QuotaEntry } from '../types';
import Icon from './Icon';
import { browserNotifySupported } from './Notifier';
import { QuotaAgent } from './Quota';

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} title={label} className={`switch${on ? ' is-on' : ''}`} disabled={disabled} onClick={() => onChange(!on)}>
      <span className="switch__knob" />
    </button>
  );
}

const errText = (err: unknown) => (err instanceof Error ? err.message : '操作失败');

/* ── 订阅源 ───────────────────────────────────────────────── */

type SourceKind = 'json' | 'deepseek';

interface SourceDraft {
  id?: string;
  kind: SourceKind;
  name: string;
  config: Record<string, string | boolean>;
}

const EMPTY_JSON: SourceDraft = {
  kind: 'json',
  name: '',
  config: { mode: 'percent', url: '', headers: '', label: '', usedPercentPath: '', usedPath: '', remainingPath: '', limitPath: '', resetsAtPath: '', intervalMin: '10' },
};

const DEEPSEEK: SourceDraft = { kind: 'deepseek', name: 'DeepSeek 余额', config: { apiKey: '', lowBelow: '10', intervalMin: '30' } };

function draftOf(q: QuotaEntry): SourceDraft {
  const c = { ...(q.config ?? {}) } as Record<string, unknown>;
  const config: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(c)) if (k !== 'kind') config[k] = typeof v === 'boolean' ? v : String(v ?? '');
  return { id: q.id, kind: q.kind === 'deepseek' ? 'deepseek' : 'json', name: q.name, config };
}

/** 文本框：label + 输入，配置里的一个字段 */
function Text({
  d,
  set,
  k,
  label,
  placeholder,
  mono,
  hint,
}: {
  d: SourceDraft;
  set: (d: SourceDraft) => void;
  k: string;
  label: string;
  placeholder?: string;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <label className="field">
      <span className="field__label">
        {label}
        {hint ? <span className="field__hint">{hint}</span> : null}
      </span>
      <input
        className={`input${mono ? ' mono' : ''}`}
        value={String(d.config[k] ?? '')}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        onChange={(e) => set({ ...d, config: { ...d.config, [k]: e.target.value } })}
      />
    </label>
  );
}

function SourceForm({ initial, onDone }: { initial: SourceDraft; onDone: () => void }) {
  const [d, setD] = useState<SourceDraft>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [test, setTest] = useState<{ text: string; raw: string } | null>(null);
  const json = d.kind === 'json';
  const balance = json && d.config.mode === 'balance';

  const payload = () => ({ id: d.id, kind: d.kind, config: d.config as Record<string, unknown> });

  const runTest = async () => {
    setBusy(true);
    setError('');
    setTest(null);
    try {
      const r = await api.testSource(payload());
      const text = r.snapshot.balance
        ? `余额 ${r.snapshot.balance.amount} ${r.snapshot.balance.unit ?? ''}`
        : r.snapshot.windows
            .map((w) => `${w.label || '额度'}：已用 ${w.usedPercent}%${w.resetsAt ? `，${new Date(w.resetsAt).toLocaleString('zh-CN', { hour12: false })} 重置` : ''}`)
            .join('；');
      setTest({ text, raw: r.raw });
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api.saveSource({ ...payload(), name: d.name });
      await quotaStore.refresh();
      onDone();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="subform">
      {!d.id ? (
        <div className="segmented segmented--sm">
          <button type="button" className={json ? 'is-on' : ''} onClick={() => setD(EMPTY_JSON)}>
            自定义 JSON 接口
          </button>
          <button type="button" className={!json ? 'is-on' : ''} onClick={() => setD(DEEPSEEK)}>
            DeepSeek 余额
          </button>
        </div>
      ) : null}
      <div className="formgrid">
        <label className="field">
          <span className="field__label">名称</span>
          <input className="input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="例如：百炼 token plan" />
        </label>
        <Text d={d} set={setD} k="intervalMin" label="多久查一次（分钟）" placeholder="10" />
      </div>

      {!json ? (
        <div className="formgrid">
          <Text d={d} set={setD} k="apiKey" label="API Key" placeholder="sk-…" mono hint="只存在本机索引库里" />
          <Text d={d} set={setD} k="lowBelow" label="余额低于多少提醒" placeholder="10" />
        </div>
      ) : (
        <>
          <Text d={d} set={setD} k="url" label="接口地址（GET，返回 JSON）" placeholder="https://…" mono />
          <label className="field">
            <span className="field__label">
              请求头<span className="field__hint">一行一个「名称: 值」；修改时整段重填</span>
            </span>
            <textarea
              className="input mono"
              rows={2}
              value={String(d.config.headers ?? '')}
              placeholder="Authorization: Bearer sk-…"
              spellCheck={false}
              onChange={(e) => setD({ ...d, config: { ...d.config, headers: e.target.value } })}
            />
          </label>
          <div className="segmented segmented--sm">
            <button type="button" className={!balance ? 'is-on' : ''} onClick={() => setD({ ...d, config: { ...d.config, mode: 'percent' } })}>
              额度百分比（会刷新的套餐）
            </button>
            <button type="button" className={balance ? 'is-on' : ''} onClick={() => setD({ ...d, config: { ...d.config, mode: 'balance' } })}>
              余额
            </button>
          </div>
          <p className="field__note">字段路径用点号，数组用下标，例如 <span className="mono">data.quota.used</span>、<span className="mono">items[0].remaining</span>。</p>
          {balance ? (
            <div className="formgrid formgrid--3">
              <Text d={d} set={setD} k="balancePath" label="余额字段" mono />
              <Text d={d} set={setD} k="unitPath" label="单位字段（可选）" mono />
              <Text d={d} set={setD} k="lowBelow" label="低于多少提醒" />
            </div>
          ) : (
            <>
              <div className="formgrid formgrid--3">
                <Text d={d} set={setD} k="label" label="窗口名" placeholder="每月" />
                <Text d={d} set={setD} k="usedPercentPath" label="已用百分比字段" mono hint="二选一" />
                <label className="field field--check">
                  <input
                    type="checkbox"
                    checked={d.config.fraction === true}
                    onChange={(e) => setD({ ...d, config: { ...d.config, fraction: e.target.checked } })}
                  />
                  <span>值是 0–1 的比例</span>
                </label>
              </div>
              <div className="formgrid formgrid--3">
                <Text d={d} set={setD} k="limitPath" label="总量字段" mono />
                <Text d={d} set={setD} k="usedPath" label="已用字段" mono hint="或" />
                <Text d={d} set={setD} k="remainingPath" label="剩余字段" mono />
              </div>
              <Text d={d} set={setD} k="resetsAtPath" label="重置时间字段（可选）" mono hint="秒 / 毫秒时间戳或日期字符串；没有时用量骤降 10 个点也算刷新" />
            </>
          )}
        </>
      )}

      {test ? (
        <div className="testresult">
          <div className="testresult__ok">
            <Icon name="check" size={14} />
            {test.text}
          </div>
          <details>
            <summary>接口原样返回</summary>
            <pre className="code">{test.raw}</pre>
          </details>
        </div>
      ) : null}
      {error ? <div className="form__error">{error}</div> : null}
      <div className="subform__actions">
        <button type="button" className="btn btn--sm" onClick={() => void runTest()} disabled={busy}>
          测试
        </button>
        <button type="button" className="btn btn--sm btn--primary" onClick={() => void save()} disabled={busy || !d.name.trim()}>
          保存
        </button>
        <button type="button" className="linkbtn" onClick={onDone}>
          取消
        </button>
      </div>
    </div>
  );
}

export function SourcesSection() {
  const quota = useQuota();
  const [editing, setEditing] = useState<SourceDraft | null>(null);
  const [error, setError] = useState('');
  const data = quota.data;
  const disabled = data?.settings.disabled ?? [];

  const toggle = async (q: QuotaEntry, on: boolean) => {
    setError('');
    try {
      if (q.kind === 'cli') {
        await api.quotaSettings({ disabled: on ? disabled.filter((x) => x !== q.id) : [...disabled, q.id] });
      } else {
        await api.saveSource({ id: q.id, enabled: on });
      }
      await quotaStore.refresh();
    } catch (err) {
      setError(errText(err));
    }
  };

  const remove = async (q: QuotaEntry) => {
    if (!confirm(`删除订阅源「${q.name}」？`)) return;
    await api.deleteSource(q.id).catch((err: unknown) => setError(errText(err)));
    await quotaStore.refresh();
  };

  return (
    <section className="card section">
      <div className="section__head">
        <h2 className="section__title">订阅源</h2>
        <span className="section__hint num">
          要盯着的额度。Claude、Codex 由命令行自己查（不花钱）；其他套餐、余额可以接任意返回 JSON 的接口。用到 {data?.warnPercent ?? 80}% 在页面上提醒（
          <span className="mono">quotaWarnPercent</span>）
        </span>
      </div>
      {error ? <div className="form__error">{error}</div> : null}
      <div className="rowlist">
        {data?.agents.map((q) => (
          <div className={`srcrow${q.enabled ? '' : ' is-off'}`} key={q.id}>
            <div className="srcrow__main">
              <QuotaAgent q={q} warn={data.warnPercent} />
            </div>
            <div className="srcrow__actions">
              <span className="srcrow__kind">{q.kind === 'cli' ? '内置' : q.kind === 'deepseek' ? 'DeepSeek' : 'JSON 接口'}</span>
              {q.kind !== 'cli' ? (
                <>
                  <button type="button" className="iconbtn iconbtn--xs" onClick={() => setEditing(draftOf(q))} aria-label="编辑">
                    <Icon name="pencil" size={13} />
                  </button>
                  <button type="button" className="iconbtn iconbtn--xs" onClick={() => void remove(q)} aria-label="删除">
                    <Icon name="x" size={13} />
                  </button>
                </>
              ) : null}
              <Switch on={q.enabled} label={q.enabled ? '停用这个订阅源' : '启用这个订阅源'} onChange={(on) => void toggle(q, on)} />
            </div>
            {editing?.id === q.id ? <SourceForm initial={editing} onDone={() => setEditing(null)} /> : null}
          </div>
        ))}
      </div>
      {editing && !editing.id ? (
        <SourceForm initial={editing} onDone={() => setEditing(null)} />
      ) : (
        <button type="button" className="btn btn--sm addbtn" onClick={() => setEditing(EMPTY_JSON)}>
          <Icon name="plus" size={14} />
          添加订阅源
        </button>
      )}
    </section>
  );
}

/* ── 提醒渠道 ─────────────────────────────────────────────── */

const KIND_LABEL: Record<ChannelKind, string> = { ntfy: 'ntfy', bark: 'Bark', telegram: 'Telegram', webhook: 'Webhook', browser: '浏览器通知' };
const KINDS: ChannelKind[] = ['ntfy', 'bark', 'telegram', 'webhook', 'browser'];

interface ChannelMeta {
  fields: Record<string, ChannelField[]>;
  events: { id: string; label: string }[];
}

function ChannelForm({ initial, meta, onDone }: { initial: Partial<NotifyChannel>; meta: ChannelMeta; onDone: () => void }) {
  const [kind, setKind] = useState<ChannelKind>(initial.kind ?? 'ntfy');
  const [name, setName] = useState(initial.name ?? '');
  const [config, setConfig] = useState<Record<string, string>>(initial.config ?? {});
  const [events, setEvents] = useState<string[]>(initial.events ?? ['reset']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied');

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api.saveChannel({ id: initial.id, kind, name: name || KIND_LABEL[kind], config, events });
      onDone();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };

  return (
    <div className="subform">
      {!initial.id ? (
        <div className="segmented segmented--sm">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={k === kind ? 'is-on' : ''}
              onClick={() => {
                setKind(k);
                setConfig({});
              }}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      ) : null}
      <div className="formgrid">
        <label className="field">
          <span className="field__label">名称</span>
          <input className="input" value={name} placeholder={KIND_LABEL[kind]} onChange={(e) => setName(e.target.value)} />
        </label>
        {(meta.fields[kind] ?? []).map((f) => (
          <label className="field" key={f.key}>
            <span className="field__label">{f.label}</span>
            <input
              className={`input${f.secret || f.key !== 'server' ? ' mono' : ''}`}
              type={f.secret && !String(config[f.key] ?? '').startsWith('••••') ? 'password' : 'text'}
              value={config[f.key] ?? ''}
              placeholder={f.placeholder}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}
            />
          </label>
        ))}
      </div>
      {kind === 'browser' ? (
        <div className="field__note">
          {browserNotifySupported() ? (
            perm === 'granted' ? (
              '这个浏览器已允许通知。只有打开着 agentctl 页面（可以在后台）时才会弹。'
            ) : (
              <button type="button" className="btn btn--sm" onClick={() => void Notification.requestPermission().then(setPerm)}>
                允许这个浏览器弹通知
              </button>
            )
          ) : (
            '当前是 http 地址，浏览器不允许网页弹系统通知（需要 HTTPS 或 localhost）。页面内仍会在右下角提示；要推到手机，用 ntfy / Bark / Telegram。'
          )}
        </div>
      ) : null}
      <div className="field">
        <span className="field__label">提醒哪些事</span>
        <div className="pillrow">
          {meta.events.map((e) => (
            <label key={e.id} className={`pill pill--btn${events.includes(e.id) ? ' is-on' : ''}`}>
              <input
                type="checkbox"
                className="visually-hidden"
                checked={events.includes(e.id)}
                onChange={(ev) => setEvents(ev.target.checked ? [...events, e.id] : events.filter((x) => x !== e.id))}
              />
              {e.label}
            </label>
          ))}
        </div>
      </div>
      {error ? <div className="form__error">{error}</div> : null}
      <div className="subform__actions">
        <button type="button" className="btn btn--sm btn--primary" onClick={() => void save()} disabled={busy}>
          保存
        </button>
        <button type="button" className="linkbtn" onClick={onDone}>
          取消
        </button>
      </div>
    </div>
  );
}

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

export function ChannelsSection() {
  const quota = useQuota();
  const [channels, setChannels] = useState<NotifyChannel[]>([]);
  const [meta, setMeta] = useState<ChannelMeta | null>(null);
  const [editing, setEditing] = useState<Partial<NotifyChannel> | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const [log, setLog] = useState<NotifyItem[]>([]);
  const [minUsed, setMinUsed] = useState('');
  const [error, setError] = useState('');

  const load = () => {
    api
      .channels()
      .then((r) => {
        setChannels(r.channels);
        setMeta({ fields: r.fields, events: r.events });
      })
      .catch((err: unknown) => setError(errText(err)));
    api
      .notifications()
      .then((r) => setLog(r.items.slice(0, 20)))
      .catch(() => undefined);
  };
  useEffect(load, []);
  useEffect(() => {
    if (quota.data) setMinUsed(String(quota.data.settings.resetMinUsed));
  }, [quota.data?.settings.resetMinUsed]);

  const test = async (c: NotifyChannel) => {
    setResults((r) => ({ ...r, [c.id]: '发送中…' }));
    try {
      const { deliveries } = await api.testChannel(c.id);
      const d = deliveries?.[0];
      setResults((r) => ({ ...r, [c.id]: !d ? '没有发出' : d.ok ? (c.kind === 'browser' ? '已记录，网页会在几十秒内弹出' : '已发送，去看看收到没有') : `失败：${d.error}` }));
      load();
    } catch (err) {
      setResults((r) => ({ ...r, [c.id]: `失败：${errText(err)}` }));
    }
  };

  const toggle = async (c: NotifyChannel, on: boolean) => {
    await api.saveChannel({ id: c.id, enabled: on, config: c.config, events: c.events }).catch((err: unknown) => setError(errText(err)));
    load();
  };

  const remove = async (c: NotifyChannel) => {
    if (!confirm(`删除提醒渠道「${c.name}」？`)) return;
    await api.deleteChannel(c.id).catch((err: unknown) => setError(errText(err)));
    load();
  };

  const saveMinUsed = async () => {
    const n = Number(minUsed);
    if (!Number.isFinite(n)) return;
    await api.quotaSettings({ resetMinUsed: n }).catch((err: unknown) => setError(errText(err)));
    await quotaStore.refresh();
  };

  const eventLabel = (id: string) => meta?.events.find((e) => e.id === id)?.label ?? id;

  return (
    <>
      <section className="card section">
        <div className="section__head">
          <h2 className="section__title">提醒</h2>
          <span className="section__hint">套餐刷新、额度快用完、余额不足时推送。页面右下角总会提示，下面的渠道把它发到别处。</span>
        </div>
        <label className="field field--inline">
          <span className="field__label">刷新前至少用到</span>
          <input className="input input--narrow num" value={minUsed} onChange={(e) => setMinUsed(e.target.value)} onBlur={() => void saveMinUsed()} inputMode="numeric" />
          <span className="field__hint">% 才提醒刷新（没怎么用的窗口滚动重置不打扰）</span>
        </label>
        {error ? <div className="form__error">{error}</div> : null}
        <div className="rowlist">
          {channels.map((c) => (
            <div className={`chrow${c.enabled ? '' : ' is-off'}`} key={c.id}>
              <div className="chrow__main">
                <div className="chrow__name">
                  {c.name}
                  <span className="srcrow__kind">{KIND_LABEL[c.kind]}</span>
                </div>
                <div className="pillrow">
                  {c.events.map((e) => (
                    <span key={e} className="pill pill--quiet">
                      {eventLabel(e)}
                    </span>
                  ))}
                  {results[c.id] ? <span className="chrow__result">{results[c.id]}</span> : null}
                </div>
              </div>
              <div className="srcrow__actions">
                <button type="button" className="btn btn--sm" onClick={() => void test(c)}>
                  测试
                </button>
                <button type="button" className="iconbtn iconbtn--xs" onClick={() => setEditing(c)} aria-label="编辑">
                  <Icon name="pencil" size={13} />
                </button>
                <button type="button" className="iconbtn iconbtn--xs" onClick={() => void remove(c)} aria-label="删除">
                  <Icon name="x" size={13} />
                </button>
                <Switch on={c.enabled} label={c.enabled ? '停用这个渠道' : '启用这个渠道'} onChange={(on) => void toggle(c, on)} />
              </div>
              {editing?.id === c.id && meta ? (
                <ChannelForm
                  initial={editing}
                  meta={meta}
                  onDone={() => {
                    setEditing(null);
                    load();
                  }}
                />
              ) : null}
            </div>
          ))}
          {!channels.length ? <p className="section__empty">还没有提醒渠道：现在只在页面右下角提示。</p> : null}
        </div>
        {editing && !editing.id && meta ? (
          <ChannelForm
            initial={editing}
            meta={meta}
            onDone={() => {
              setEditing(null);
              load();
            }}
          />
        ) : (
          <button type="button" className="btn btn--sm addbtn" onClick={() => setEditing({})} disabled={!meta}>
            <Icon name="plus" size={14} />
            添加提醒渠道
          </button>
        )}
      </section>

      {log.length ? (
        <section className="card section">
          <div className="section__head">
            <h2 className="section__title">最近提醒</h2>
          </div>
          <div className="rowlist">
            {log.map((i) => (
              <div className="logrow" key={i.id}>
                <span className="logrow__time num">{ago(i.at)}</span>
                <div className="logrow__main">
                  <div className="logrow__title">{i.title}</div>
                  <div className="logrow__body">{i.body}</div>
                </div>
                <div className="logrow__deliv">
                  {i.deliveries?.map((d) => (
                    <span key={d.channel} className={`pill${d.ok ? ' pill--quiet' : ' pill--danger'}`} title={d.error}>
                      {d.ok ? <Icon name="check" size={11} /> : <Icon name="x" size={11} />}
                      {d.channel}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
