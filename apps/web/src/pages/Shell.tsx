import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { sessionHref, shellHref } from '../router';
import Icon from '../components/Icon';
import { useTheme } from '../theme';
import { AGENT_LABEL, type AgentId } from '../types';

type Status = 'connecting' | 'open' | 'reconnecting' | 'exited' | 'error';

const STATUS_LABEL: Record<Status, string> = {
  connecting: '连接中',
  open: '已连接',
  reconnecting: '重新连接中',
  exited: '已退出',
  error: '出错',
};

/** 手机键盘上没有的键 */
const KEYS: { label: string; seq: string }[] = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
  { label: '^C', seq: '\x03' },
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
  { label: '⇧Tab', seq: '\x1b[Z' },
];

/** 终端配色跟着网页主题走；16 色各给一套深浅两版，保证在各自底色上看得清 */
const PALETTE = {
  dark: {
    background: '#0e1015',
    foreground: '#e6e4df',
    cursor: '#e0663a',
    cursorAccent: '#0e1015',
    selectionBackground: '#33405a',
    black: '#1c2028',
    red: '#e5675e',
    green: '#7fc48f',
    yellow: '#e2b85c',
    blue: '#7aa2f7',
    magenta: '#c49ae8',
    cyan: '#5fc6c0',
    white: '#c9ccd3',
    brightBlack: '#6b7280',
    brightRed: '#f08a82',
    brightGreen: '#9fdcab',
    brightYellow: '#f0cd7c',
    brightBlue: '#9db9fa',
    brightMagenta: '#d9b8f2',
    brightCyan: '#86dcd6',
    brightWhite: '#f2f1ee',
  },
  light: {
    background: '#ffffff',
    foreground: '#1f2329',
    cursor: '#c4552b',
    cursorAccent: '#ffffff',
    selectionBackground: '#cfdcf5',
    black: '#1f2329',
    red: '#c0392b',
    green: '#2e7d4f',
    yellow: '#9a6a00',
    blue: '#2f5fc4',
    magenta: '#8a4bb5',
    cyan: '#1a7f86',
    white: '#6b7280',
    brightBlack: '#8a909c',
    brightRed: '#d9534f',
    brightGreen: '#3c9a63',
    brightYellow: '#b58200',
    brightBlue: '#4876d6',
    brightMagenta: '#a066c7',
    brightCyan: '#2596a0',
    brightWhite: '#3a3f47',
  },
};

/**
 * 真终端：默认打开 `claude --resume <会话>`，也可以在会话目录里开普通 shell。
 * 终端进程在服务端常驻，断线（刷新、手机切后台）后自动重连并回放最近输出。
 */
export default function Shell({ id, kind }: { id: string; kind: 'agent' | 'shell' }) {
  const host = useRef<HTMLDivElement>(null);
  const socket = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [message, setMessage] = useState('');
  const [title, setTitle] = useState('');
  const [line, setLine] = useState('');
  const { theme } = useTheme();

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const narrow = matchMedia('(max-width: 900px)').matches;
    const term = new Terminal({
      fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: narrow ? 12 : 13.5,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      theme: PALETTE[document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'],
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    termRef.current = term;

    let disposed = false;
    let finished = false; // 进程退出或服务端拒绝：不再重连
    let attempt = 0;
    let retryTimer: number | undefined;
    /** 最后一次收到服务端消息的时间；服务端每 20 秒发一次 ping，太久没消息说明连接已经"半死" */
    let lastSeen = Date.now();

    const send = (msg: unknown) => {
      const ws = socket.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    /** 放弃当前连接（不等它慢慢超时），马上重连 */
    const reconnect = (delay: number) => {
      const old = socket.current;
      if (old) {
        old.onclose = null;
        old.onmessage = null;
        old.close();
      }
      clearTimeout(retryTimer);
      setStatus('reconnecting');
      retryTimer = window.setTimeout(connect, delay);
    };

    const connect = () => {
      if (disposed || finished) return;
      lastSeen = Date.now();
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      const qs = new URLSearchParams({ kind, cols: String(term.cols), rows: String(term.rows) });
      const ws = new WebSocket(`${scheme}://${location.host}/api/sessions/${encodeURIComponent(id)}/shell?${qs}`);
      socket.current = ws;
      ws.onmessage = (e: MessageEvent<string>) => {
        lastSeen = Date.now();
        let msg: { type: string; data?: string; code?: number; message?: string; shell?: { title?: string } };
        try {
          msg = JSON.parse(e.data) as typeof msg;
        } catch {
          return;
        }
        switch (msg.type) {
          case 'ping':
            break;
          case 'ready':
            attempt = 0;
            // 服务端接着会发当前屏幕的快照，先清掉旧内容
            term.reset();
            setTitle(msg.shell?.title ?? '');
            setStatus('open');
            setMessage('');
            send({ type: 'resize', cols: term.cols, rows: term.rows });
            break;
          case 'output':
            if (msg.data) term.write(msg.data);
            break;
          case 'exit':
            finished = true;
            setStatus('exited');
            setMessage(`进程已退出（代码 ${msg.code ?? 0}）`);
            break;
          case 'error':
            finished = true;
            setStatus('error');
            setMessage(msg.message ?? '连接被拒绝');
            break;
        }
      };
      ws.onclose = () => {
        if (disposed || finished) return;
        attempt += 1;
        reconnect(Math.min(1000 * attempt, 10_000));
      };
    };

    const watchdog = window.setInterval(() => {
      if (finished || socket.current?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastSeen > 50_000) reconnect(0);
    }, 5000);

    const input = term.onData((data) => send({ type: 'input', data }));
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      send({ type: 'resize', cols: term.cols, rows: term.rows });
    });
    ro.observe(el);
    // 手机从后台回来时 WebSocket 往往已经断了，立刻重连而不是等退避
    // 切后台期间可能早就断了，但浏览器还没察觉：超过一个心跳周期没消息就直接重连
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || finished) return;
      const ws = socket.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING || Date.now() - lastSeen > 25_000) {
        attempt = 0;
        reconnect(0);
      }
    };
    const onOnline = () => {
      if (finished) return;
      attempt = 0;
      reconnect(0);
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    connect();
    term.focus();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      clearInterval(watchdog);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      ro.disconnect();
      input.dispose();
      socket.current?.close();
      term.dispose();
      termRef.current = null;
    };
  }, [id, kind]);

  // 切换主题时终端跟着换色，不重连
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = PALETTE[theme];
  }, [theme]);

  const press = (seq: string) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data: seq }));
    termRef.current?.focus();
  };

  const kill = () => {
    if (!confirm(kind === 'agent' ? '结束这个终端里的 agent 进程？会话已保存，可随时续接。' : '结束这个 shell？')) return;
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'kill' }));
  };

  const live = status === 'open';

  /** 手机输入法（尤其中文）直接往 xterm 里打字不可靠：整行写好再发，末尾补回车 */
  const sendLine = () => {
    const ws = socket.current;
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'input', data: `${line}\r` }));
    setLine('');
  };

  const isAgent = !(id.startsWith('dsh:') || id.startsWith('pi:'));

  return (
    <div className="term">
      <header className="term__bar">
        <a className="iconbtn" href={sessionHref(id)} title="回到时间线" aria-label="回到时间线">
          <Icon name="back" />
        </a>
        <span className="term__title">{title || '终端'}</span>
        <nav className="segmented segmented--sm term__tabs">
          {/* DSH、Pi 没有可续接的 TUI，只给 shell */}
          {isAgent ? (
            <a className={kind === 'agent' ? 'is-on' : ''} href={shellHref(id, 'agent')}>
              {AGENT_LABEL[id.split(':')[0] as AgentId] ?? 'Agent'}
            </a>
          ) : null}
          <a className={kind === 'shell' ? 'is-on' : ''} href={shellHref(id, 'shell')}>
            Shell
          </a>
        </nav>
        <span className={`status${live ? ' is-live' : status === 'reconnecting' || status === 'connecting' ? ' is-pending' : ''}`}>
          {live ? <span className="live-dot" aria-hidden="true" /> : <span className="status__dot" aria-hidden="true" />}
          {STATUS_LABEL[status]}
        </span>
        {live ? (
          <button className="btn btn--sm btn--danger-quiet" onClick={kill}>
            结束
          </button>
        ) : null}
        {status === 'exited' || status === 'error' ? (
          <button className="btn btn--sm" onClick={() => location.reload()}>
            <Icon name="refresh" size={13} />
            重新打开
          </button>
        ) : null}
      </header>
      {message ? <div className={`term__msg${status === 'error' ? ' is-error' : ''}`}>{message}</div> : null}
      <div className="term__screen" ref={host} />
      <div className="term__mobile">
        <div className="term__keys">
          {KEYS.map((k) => (
            <button key={k.label} className="term__key" onClick={() => press(k.seq)} disabled={!live}>
              {k.label}
            </button>
          ))}
        </div>
        <form
          className="term__line"
          onSubmit={(e) => {
            e.preventDefault();
            sendLine();
          }}
        >
          <input
            className="input"
            value={line}
            onChange={(e) => setLine(e.target.value)}
            placeholder="整行输入，发送时自动回车（适合中文输入法）"
            enterKeyHint="send"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={!live}
          />
          <button className="sendbtn" type="submit" disabled={!live} aria-label="发送这一行">
            <Icon name="send" size={16} />
          </button>
        </form>
      </div>
    </div>
  );
}
