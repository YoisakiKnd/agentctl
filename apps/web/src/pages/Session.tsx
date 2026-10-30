import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, HttpError } from '../api';
import { PinButton, TagEditor, TitleEditor } from '../components/Annotate';
import Icon from '../components/Icon';
import AppShell, { DrawerButton } from '../components/Layout';
import { QuotaAlert } from '../components/Quota';
import { AgentBadge } from '../components/AgentBadge';
import Composer, { modesFor } from '../components/Composer';
import Timeline from '../components/Timeline';
import { formatBytes, formatCost, homeShorten, timeAgo } from '../format';
import { mergeEvents, useLiveRun } from '../live';
import { navigate, sessionHref, shellHref } from '../router';
import type { ApprovalDecision, PermissionMode, RunPrefs, RunState, SessionSummary, UnifiedEvent } from '../types';
import { AGENT_LABEL } from '../types';
import type { RunOptions } from '../api';

const AUTO_LOAD_THRESHOLD = 160;
/** 离底部这么近就算"在看最新"，新事件到达时自动跟随 */
const STICK_THRESHOLD = 96;

interface FileView {
  events: UnifiedEvent[];
  cursor: number | null;
  hasMore: boolean;
}

const EMPTY_FILE: FileView = { events: [], cursor: null, hasMore: false };

function stateLabel(state: RunState | null, pending: number, canRun: boolean): { text: string; live: boolean } {
  if (pending > 0) return { text: `等待审批 · ${pending}`, live: true };
  switch (state) {
    case 'starting':
      return { text: '启动中', live: true };
    case 'running':
      return { text: '运行中', live: true };
    case 'idle':
      return { text: '进程待命', live: false };
    case 'exited':
      return { text: '进程已结束', live: false };
    default:
      return { text: canRun ? '' : '只读', live: false };
  }
}

export default function Session({ id, at }: { id: string; at?: number }) {
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [canRun, setCanRun] = useState(false);
  /** 能在网页终端里打开这个 agent 自己的 TUI 续接（claude --resume / codex resume） */
  const [canResume, setCanResume] = useState(false);
  const [file, setFile] = useState<FileView>(EMPTY_FILE);
  const [runId, setRunId] = useState<string | null>(null);
  const [runModel, setRunModel] = useState<string | undefined>();
  /** 会话上次用的模型 / 强度 / 权限模式：刷新、换设备后输入框下拉框沿用它 */
  const [prefs, setPrefs] = useState<RunPrefs | undefined>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState('');
  const [unseen, setUnseen] = useState(false);
  /** 搜索跳转模式下，命中位置之后还有没加载的内容 */
  const [forwardMore, setForwardMore] = useState(false);
  const jumped = useRef(false);
  /** 这个会话正在网页终端里跑 claude TUI */
  const [agentShell, setAgentShell] = useState(false);

  const scroller = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLDivElement>(null);
  const anchored = useRef(false);
  const stick = useRef(true);
  /** 最近一次用户主动滚动（滚轮 / 触摸 / 键盘）的时间；只有用户滚动才允许解除"贴底" */
  const lastInput = useRef(0);
  /** 文件已读到的字节位置，增量轮询从这里接着读 */
  const fileEnd = useRef(0);
  const polling = useRef(false);
  const lastMetaAt = useRef(0);
  const lastUid = useRef<string | undefined>(undefined);
  const maxTurn = useRef(0);

  const live = useLiveRun(runId);
  const events = useMemo(() => mergeEvents(file.events, live.events), [file.events, live.events]);
  const pending = useMemo(
    () => events.filter((e) => e.item.kind === 'approval' && e.item.state === 'pending').length,
    [events],
  );
  useEffect(() => {
    maxTurn.current = file.events.reduce((m, e) => Math.max(m, e.turn), 0);
  }, [file.events]);
  const runState = live.state;
  const processAlive = runState === 'starting' || runState === 'running' || runState === 'idle';

  const loadOlder = useCallback(async () => {
    const el = scroller.current;
    if (!el || !file.cursor || loadingOlder) return;
    setLoadingOlder(true);
    const prevHeight = el.scrollHeight;
    try {
      const win = await api.events(id, file.cursor);
      setFile((cur) => ({ events: [...win.events, ...cur.events], cursor: win.nextBefore, hasMore: win.hasMore }));
      // 插入更早内容后要把视口钉在原地，否则读者会被弹走
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight - prevHeight;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载更早内容失败');
    } finally {
      setLoadingOlder(false);
    }
  }, [file.cursor, id, loadingOlder]);

  const refreshMeta = useCallback(() => {
    lastMetaAt.current = Date.now();
    void api
      .session(id)
      .then((d) => {
        setSession(d.session);
        setPrefs(d.prefs);
        setAgentShell(!!d.shells?.some((sh) => sh.kind === 'agent'));
      })
      .catch(() => undefined);
  }, [id]);

  /**
   * 增量追文件尾：不管会话是网页里跑的还是终端里跑的，agent 写进文件的新行都会出现。
   * 实时流里已有的同一条（uid 相同）由 mergeEvents 以磁盘为准去重。
   */
  const pollTail = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const win = await api.eventsAfter(id, fileEnd.current);
      if (win.window.end <= fileEnd.current && win.events.length === 0) return;
      fileEnd.current = win.window.end;
      if (win.events.length) {
        const newTurn = win.events.some((e) => e.turn > maxTurn.current);
        setFile((cur) => {
          const have = new Set(cur.events.map((e) => e.uid ?? `seq:${e.seq}`));
          const fresh = win.events.filter((e) => !have.has(e.uid ?? `seq:${e.seq}`));
          return fresh.length ? { ...cur, events: [...cur.events, ...fresh] } : cur;
        });
        // 轮次 / 花费 / 体积跟着变：新一轮立刻刷新头部，其余节流
        if (newTurn || Date.now() - lastMetaAt.current > 10_000) refreshMeta();
      }
    } catch (err) {
      // 文件被截断或替换（409）：整窗重读
      if (err instanceof HttpError && err.status === 409) {
        const win = await api.events(id).catch(() => null);
        if (win) {
          fileEnd.current = win.window.end;
          setFile({ events: win.events, cursor: win.nextBefore, hasMore: win.hasMore });
        }
      }
    } finally {
      polling.current = false;
    }
  }, [id, refreshMeta]);

  useEffect(() => {
    let cancelled = false;
    anchored.current = false;
    stick.current = true;
    fileEnd.current = 0;
    lastUid.current = undefined;
    setSession(null);
    setPrefs(undefined);
    setFile(EMPTY_FILE);
    setRunId(null);
    setRunModel(undefined);
    setUnseen(false);
    setError('');

    jumped.current = false;
    setForwardMore(false);

    (async () => {
      try {
        // 搜索跳转：窗口以命中那一行结尾，再往后补一页，命中处前后都有上下文
        const [detail, win] = await Promise.all([
          api.session(id),
          at !== undefined ? api.eventsThrough(id, at) : api.events(id),
        ]);
        const fwd = at !== undefined ? await api.eventsAfter(id, win.window.end) : null;
        if (cancelled) return;
        setSession(detail.session);
        setPrefs(detail.prefs);
        setCanRun(detail.canRun);
        setCanResume(!!detail.canResumeInTerminal);
        setAgentShell(!!detail.shells?.some((sh) => sh.kind === 'agent'));
        fileEnd.current = fwd ? fwd.window.end : win.window.end;
        lastMetaAt.current = Date.now();
        if (fwd) {
          // 不贴底：读者要看的是命中处
          anchored.current = true;
          stick.current = false;
          setForwardMore(fwd.hasMore);
        }
        setFile({ events: fwd ? [...win.events, ...fwd.events] : win.events, cursor: win.nextBefore, hasMore: win.hasMore });
        // 还活着（或刚结束）的运行：接上它的事件流
        if (detail.run) {
          setRunId(detail.run.id);
          setRunModel(detail.run.model);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载会话失败');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id, at]);

  // 跳转后把命中那一条滚到视口中间。content-visibility 下前面的行高度是估算的，
  // 真实高度回填后位置会漂，所以稍后再校正一次
  useEffect(() => {
    if (at === undefined || jumped.current || file.events.length === 0) return;
    const el = scroller.current?.querySelector(`[data-seq="${at}"]`);
    if (!el) return;
    jumped.current = true;
    // 比视口还高的条目（长回复）从顶部开始显示，否则关键词可能落在视口之外
    const block = () =>
      el.getBoundingClientRect().height > (scroller.current?.clientHeight ?? 0) * 0.8 ? 'start' : 'center';
    el.scrollIntoView({ block: block() });
    const t = setTimeout(() => el.scrollIntoView({ block: block() }), 350);
    return () => clearTimeout(t);
  }, [at, file.events]);

  const loadForward = useCallback(async () => {
    const win = await api.eventsAfter(id, fileEnd.current);
    fileEnd.current = win.window.end;
    setForwardMore(win.hasMore);
    setFile((cur) => ({ ...cur, events: [...cur.events, ...win.events] }));
  }, [id]);

  // 页面可见时每 2 秒追一次文件尾；文件没变时服务端只做一次 stat。
  // 搜索跳转模式下不追：否则会一页页读到文件末尾，把读者从命中处带走
  useEffect(() => {
    const tick = () => {
      if (at !== undefined) return;
      if (document.visibilityState === 'visible' && anchored.current) void pollTail();
    };
    // 有我们起的进程在跑时加快到 1 秒：DSH 的时间线完全靠追文件
    const timer = setInterval(tick, processAlive ? 1000 : 2000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [pollTail, processAlive, at]);

  // 进程结束：立刻对齐一次磁盘，并刷新轮次 / 花费
  useEffect(() => {
    if (runState !== 'exited') return;
    void pollTail();
    refreshMeta();
  }, [runState, pollTail, refreshMeta]);

  const toBottom = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  // 首次渲染后滚到最新一条；之后只要读者停在底部，新事件来了就跟着走，否则亮起"有新内容"
  useEffect(() => {
    if (events.length === 0) return;
    const newest = events[events.length - 1].uid ?? String(events[events.length - 1].seq);
    if (!anchored.current || stick.current) {
      anchored.current = true;
      toBottom();
    } else if (newest !== lastUid.current && at === undefined) {
      setUnseen(true);
    }
    lastUid.current = newest;
  }, [events, live.draft, toBottom, at]);

  // Markdown 渲染、content-visibility 的真实高度回填都会在事件到达之后才撑高内容，
  // 只靠上面的 effect 会停在"差一点到底"的位置，所以盯着内容高度继续贴底
  useEffect(() => {
    const r = rows.current;
    if (!r) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) toBottom();
    });
    ro.observe(r);
    return () => ro.disconnect();
  }, [toBottom]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    if (atBottom) {
      stick.current = true;
      setUnseen(false);
    } else if (Date.now() - lastInput.current < 1000) {
      // 布局抖动引起的滚动不算，只有用户自己往上翻才解除贴底
      stick.current = false;
    }
    if (file.hasMore && !loadingOlder && el.scrollTop < AUTO_LOAD_THRESHOLD) void loadOlder();
  }, [file.hasMore, loadingOlder, loadOlder]);

  const markInput = useCallback(() => {
    lastInput.current = Date.now();
  }, []);

  const jumpToLatest = useCallback(() => {
    stick.current = true;
    setUnseen(false);
    toBottom();
  }, [toBottom]);

  const send = useCallback(
    async (text: string, opts: RunOptions, attachments: string[]) => {
      const { run } = await api.send(id, text, processAlive ? {} : opts, attachments);
      // 从搜索结果跳进来的：发了消息就回到正常的"跟随最新"视图
      if (at !== undefined) {
        navigate(sessionHref(id).slice(1));
        return;
      }
      stick.current = true;
      setUnseen(false);
      setRunId(run.id);
      setRunModel(run.model);
    },
    [id, processAlive, at],
  );

  const setModel = useCallback(
    async (model: string) => {
      if (!runId) return;
      await api.setModel(runId, model);
      setRunModel(model);
    },
    [runId],
  );

  const decide = useCallback(
    async (requestId: string, decision: ApprovalDecision, answers?: Record<string, string>) => {
      if (!runId) throw new Error('没有正在进行的运行');
      await api.approve(runId, requestId, decision, answers);
    },
    [runId],
  );

  const setEffort = useCallback(
    async (effort: string) => {
      if (!runId) return;
      await api.setEffort(runId, effort);
      // Claude 的进程不会报强度，页面上以记下的为准
      setPrefs((cur) => ({ ...cur, effort: effort || undefined }));
    },
    [runId],
  );

  const setPermissionMode = useCallback(
    async (mode: PermissionMode) => {
      if (!runId) return;
      await api.setPermissionMode(runId, mode);
    },
    [runId],
  );

  // 没有我们的进程、文件却在最近一分钟被写过：多半是终端里正开着这个会话
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(t);
  }, []);
  const externalWriteAgo = session && runState === null ? Math.round((now - session.mtime) / 1000) : Infinity;
  const warning = agentShell
    ? '这个会话正在网页终端里运行。要在这里发消息，先在终端里退出（/exit）。'
    : externalWriteAgo < 60
      ? `这个会话 ${Math.max(externalWriteAgo, 1)} 秒前刚被写入，可能正在终端里使用。两边同时发消息会让记录交错。`
      : undefined;

  if (error && !session) {
    return (
      <AppShell active="session" currentId={id} title="出错了">
        <div className="empty empty--error">
          <Icon name="alert" size={28} />
          <p className="empty__title">打不开这个会话</p>
          <p className="empty__body">{error}</p>
        </div>
      </AppShell>
    );
  }

  const meta = session
    ? [
        session.turns > 0 ? `${session.turns} 轮` : null,
        formatCost(session.costUsd) || null,
        session.sizeBytes ? formatBytes(session.sizeBytes) : null,
        timeAgo(session.updatedAt),
      ].filter(Boolean)
    : [];
  const status = stateLabel(runState, pending, canRun);
  const terminalHref = shellHref(id, canResume ? 'agent' : 'shell');

  return (
    <AppShell active="session" currentId={id} bare topbar={false}>
      <div className="sview" style={{ '--agent': `var(--${session?.agent ?? 'claude'})` } as React.CSSProperties}>
        <header className="shead">
          <DrawerButton />
          {session ? <AgentBadge agent={session.agent} /> : null}
          <div className="shead__text">
            {session ? <TitleEditor key={session.id} session={session} onChange={setSession} /> : <h1 className="session__title">加载中…</h1>}
            <div className="shead__meta num">
              {session ? <span className="shead__agent">{AGENT_LABEL[session.agent]}</span> : null}
              {meta.map((m) => (
                <span key={m}>{m}</span>
              ))}
              {session ? (
                <span className="shead__path mono" title={session.cwd}>
                  {homeShorten(session.cwd)}
                </span>
              ) : null}
            </div>
            {session ? (
              <div className="shead__tags">
                <TagEditor key={session.id} session={session} onChange={setSession} />
              </div>
            ) : null}
          </div>
          <div className="shead__actions">
            {status.text ? (
              <span className={`status${status.live ? ' is-live' : ''}`}>
                {status.live ? <span className="live-dot" aria-hidden="true" /> : null}
                {status.text}
              </span>
            ) : null}
            {processAlive && live.permissionMode && live.permissionMode !== 'default' ? (
              <span className={`pill${live.permissionMode === 'bypassPermissions' ? ' pill--danger' : ''}`}>
                {modesFor(session?.agent ?? 'claude').find((m) => m.value === live.permissionMode)?.label ?? live.permissionMode}
              </span>
            ) : null}
            {session ? <PinButton session={session} onChange={setSession} /> : null}
            {session ? (
              <a
                className={`btn btn--sm term-link${agentShell ? ' is-live' : ''}`}
                // 没有可续接的 TUI（DSH、Pi），直接给会话目录里的 shell
                href={terminalHref}
                title="打开真终端：在网页里续接这个会话（claude --resume / codex resume），或在会话目录开 shell"
              >
                {agentShell ? <span className="live-dot" aria-hidden="true" /> : <Icon name="terminal" size={14} />}
                <span className="term-link__label">终端</span>
              </a>
            ) : null}
          </div>
        </header>

        <div
          className="timeline"
          ref={scroller}
          onScroll={onScroll}
          onWheel={markInput}
          onTouchMove={markInput}
          onKeyDown={markInput}
          onMouseDown={markInput}
        >
          <div className="timeline__inner">
            {file.hasMore ? (
              <button className="more" onClick={() => void loadOlder()} disabled={loadingOlder}>
                {loadingOlder ? '加载中…' : '加载更早的内容'}
              </button>
            ) : session ? (
              <div className="timeline__start">会话开始</div>
            ) : null}
            {error ? <div className="empty empty--error">{error}</div> : null}
            <div ref={rows}>
              <Timeline events={events} onDecide={runId ? decide : undefined} draft={live.draft} highlight={at} />
              {at !== undefined ? (
                <div className="jumpbar">
                  <Icon name="search" size={14} />
                  <span>正在查看搜索命中的位置</span>
                  {forwardMore ? (
                    <button className="linkbtn" onClick={() => void loadForward()}>
                      加载后面的内容
                    </button>
                  ) : null}
                  <a className="linkbtn" href={sessionHref(id)}>
                    回到最新
                  </a>
                </div>
              ) : null}
              {live.error && runState === 'exited' ? <div className="notice notice--error">{live.error}</div> : null}
            </div>
          </div>
          {unseen ? (
            <button className="jump" onClick={jumpToLatest}>
              <Icon name="chevronDown" size={14} />
              有新内容
            </button>
          ) : null}
        </div>

        {canRun && session ? (
          <Composer
            key={id}
            agent={session.agent}
            path={session.cwd}
            state={runState}
            pending={pending}
            processAlive={processAlive}
            onSend={send}
            onInterrupt={runId ? () => api.interrupt(runId).then(() => undefined) : undefined}
            onStop={runId ? () => api.stop(runId).then(() => undefined) : undefined}
            runModel={live.model ?? runModel}
            runModels={live.models}
            onSetModel={runId ? setModel : undefined}
            runPermissionMode={live.permissionMode ?? undefined}
            onSetPermissionMode={runId ? setPermissionMode : undefined}
            warning={warning}
            notice={<QuotaAlert agent={session.agent} />}
            initialOpts={prefs}
            runEffort={live.effort ?? prefs?.effort ?? null}
            effortPending={session.agent === 'claude'}
            onSaveOpts={(o) => {
              void api.savePrefs(id, o).catch(() => undefined);
            }}
            onSetEffort={runId ? setEffort : undefined}
          />
        ) : session ? (
          <footer className="readonly">
            <Icon name="terminal" size={14} />
            <span>{canResume ? '这个 agent 还不能在输入框里对话，可以用右上角的「终端」续接' : '这个 agent 目前只能回放'}</span>
          </footer>
        ) : null}
      </div>
    </AppShell>
  );
}
