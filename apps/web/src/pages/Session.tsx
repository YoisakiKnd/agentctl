import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, HttpError } from '../api';
import Composer, { modesFor } from '../components/Composer';
import Timeline from '../components/Timeline';
import { formatBytes, formatCost, homeShorten, timeAgo } from '../format';
import { mergeEvents, useLiveRun } from '../live';
import { sessionHref, shellHref } from '../router';
import type { ApprovalDecision, PermissionMode, RunInfo, RunState, SessionSummary, UnifiedEvent } from '../types';
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

export default function Session({ id }: { id: string }) {
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [canRun, setCanRun] = useState(false);
  const [file, setFile] = useState<FileView>(EMPTY_FILE);
  const [runId, setRunId] = useState<string | null>(null);
  const [runModel, setRunModel] = useState<string | undefined>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState('');
  const [list, setList] = useState<SessionSummary[]>([]);
  const [liveRuns, setLiveRuns] = useState<RunInfo[]>([]);
  const [railOpen, setRailOpen] = useState(false);
  const [unseen, setUnseen] = useState(false);
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
    setFile(EMPTY_FILE);
    setRunId(null);
    setRunModel(undefined);
    setUnseen(false);
    setError('');

    (async () => {
      try {
        const [detail, win] = await Promise.all([api.session(id), api.events(id)]);
        if (cancelled) return;
        setSession(detail.session);
        setCanRun(detail.canRun);
        setAgentShell(!!detail.shells?.some((sh) => sh.kind === 'agent'));
        fileEnd.current = win.window.end;
        lastMetaAt.current = Date.now();
        setFile({ events: win.events, cursor: win.nextBefore, hasMore: win.hasMore });
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
  }, [id]);

  // 页面可见时每 2 秒追一次文件尾；文件没变时服务端只做一次 stat
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible' && anchored.current) void pollTail();
    };
    // 有我们起的进程在跑时加快到 1 秒：DSH 的时间线完全靠追文件
    const timer = setInterval(tick, processAlive ? 1000 : 2000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [pollTail, processAlive]);

  // 侧栏会话列表与运行标记：15 秒刷新一次
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (document.visibilityState !== 'visible') return;
      api
        .sessions()
        .then(({ sessions, runs }) => {
          if (cancelled) return;
          setList(sessions);
          setLiveRuns(runs ?? []);
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id]);

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
    } else if (newest !== lastUid.current) {
      setUnseen(true);
    }
    lastUid.current = newest;
  }, [events, live.draft, toBottom]);

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
    async (text: string, opts: RunOptions) => {
      const { run } = await api.send(id, text, processAlive ? {} : opts);
      stick.current = true;
      setUnseen(false);
      setRunId(run.id);
      setRunModel(run.model);
    },
    [id, processAlive],
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
      <div className="app">
        <header className="topbar">
          <a className="btn btn--ghost btn--sm" href="#/">
            ← 返回
          </a>
          <span className="topbar__meta mono">出错了</span>
        </header>
        <div className="empty empty--error">{error}</div>
      </div>
    );
  }

  const meta = session
    ? [
        AGENT_LABEL[session.agent],
        session.turns > 0 ? `${session.turns} 轮` : null,
        formatCost(session.costUsd) || null,
        session.sizeBytes ? formatBytes(session.sizeBytes) : null,
        timeAgo(session.updatedAt),
      ].filter(Boolean)
    : [];
  const status = stateLabel(runState, pending, canRun);
  const busyIds = new Set(liveRuns.filter((r) => r.state !== 'exited').map((r) => r.sessionKey));

  return (
    <div className="session">
      <aside className={`rail${railOpen ? ' is-open' : ''}`}>
        <div className="rail__head mono">
          <span>会话</span>
          <a className="rail__all" href="#/">
            全部会话
          </a>
        </div>
        <div className="rail__list">
          {list.map((s) => (
            <a
              className={`rail__item${s.id === id ? ' is-active' : ''}`}
              key={s.id}
              href={sessionHref(s.id)}
              style={{ '--agent': `var(--${s.agent})` } as React.CSSProperties}
              onClick={() => setRailOpen(false)}
            >
              <span className="rail__rail" />
              <span className="rail__title">
                {busyIds.has(s.id) ? <span className="live-dot" aria-label="运行中" /> : null}
                {s.title}
              </span>
              <span className="rail__time mono">{timeAgo(s.updatedAt)}</span>
            </a>
          ))}
        </div>
      </aside>

      <main
        className="session__main"
        style={{ '--agent': `var(--${session?.agent ?? 'claude'})` } as React.CSSProperties}
      >
        <header className="session__head">
          <button
            className="btn btn--ghost btn--sm rail-toggle"
            onClick={() => setRailOpen((v) => !v)}
            aria-label="切换会话列表"
          >
            ☰
          </button>
          <a className="btn btn--ghost btn--sm back-link" href="#/">
            ←
          </a>
          <div className="session__titlewrap">
            <h1 className="session__title">{session?.title ?? '加载中…'}</h1>
            <div className="session__meta num">
              {meta.map((m) => (
                <span key={m}>{m}</span>
              ))}
            </div>
          </div>
          {session ? (
            <a
              className={`btn btn--sm term-link${agentShell ? ' is-live' : ''}`}
              // DSH 没有可续接的 TUI，直接给会话目录里的 shell
              href={shellHref(id, session.agent === 'dsh' ? 'shell' : 'agent')}
              title="打开真终端：在网页里续接这个会话（claude --resume / codex resume），或在会话目录开 shell"
            >
              {agentShell ? <span className="live-dot" aria-hidden="true" /> : null}
              终端
            </a>
          ) : null}
          {processAlive && live.permissionMode && live.permissionMode !== 'default' ? (
            <span className={`mode-badge${live.permissionMode === 'bypassPermissions' ? ' is-danger' : ''}`}>
              {modesFor(session?.agent ?? 'claude').find((m) => m.value === live.permissionMode)?.label ?? live.permissionMode}
            </span>
          ) : null}
          {status.text ? (
            <span className={`session__mode${status.live ? ' is-live' : ''}`}>
              {status.live ? <span className="live-dot" aria-hidden="true" /> : null}
              {status.text}
            </span>
          ) : null}
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
          {file.hasMore ? (
            <button className="more" onClick={() => void loadOlder()} disabled={loadingOlder}>
              {loadingOlder ? '加载中…' : '加载更早的内容'}
            </button>
          ) : (
            <div className="timeline__start mono">— 会话开始 —</div>
          )}
          {error ? <div className="empty empty--error">{error}</div> : null}
          <div ref={rows}>
            <Timeline events={events} onDecide={runId ? decide : undefined} draft={live.draft} />
            {live.error && runState === 'exited' ? <div className="notice notice--error">{live.error}</div> : null}
          </div>
          {unseen ? (
            <button className="jump" onClick={jumpToLatest}>
              ↓ 有新内容
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
          />
        ) : (
          <footer className="session__foot">
            <span className="session__path mono" title={session?.file}>
              {session ? homeShorten(session.file) : ''}
            </span>
            <span className="session__note">这个 agent 还不能在输入框里对话，可以点右上角「终端」续接</span>
          </footer>
        )}
      </main>
    </div>
  );
}
