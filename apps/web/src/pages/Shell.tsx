import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { sessionHref, shellHref } from '../router';
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

const THEME = {
  background: '#1b1f2a',
  foreground: '#e8e4da',
  cursor: '#e0663a',
  cursorAccent: '#1b1f2a',
  selectionBackground: '#3a4458',
  black: '#1b1f2a',
  brightBlack: '#6b7484',
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
      theme: THEME,
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

    const send = (msg: unknown) => {
      const ws = socket.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    const connect = () => {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      const qs = new URLSearchParams({ kind, cols: String(term.cols), rows: String(term.rows) });
      const ws = new WebSocket(`${scheme}://${location.host}/api/sessions/${encodeURIComponent(id)}/shell?${qs}`);
      socket.current = ws;
      ws.onmessage = (e: MessageEvent<string>) => {
        let msg: { type: string; data?: string; code?: number; message?: string; shell?: { title?: string } };
        try {
          msg = JSON.parse(e.data) as typeof msg;
        } catch {
          return;
        }
        switch (msg.type) {
          case 'ready':
            attempt = 0;
            // 服务端接着会回放最近输出，先清屏避免重连后内容重复
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
        setStatus('reconnecting');
        attempt += 1;
        retryTimer = window.setTimeout(connect, Math.min(1000 * attempt, 10_000));
      };
    };

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
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || finished) return;
      if (socket.current?.readyState === WebSocket.CLOSED) {
        clearTimeout(retryTimer);
        attempt = 0;
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    connect();
    term.focus();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      document.removeEventListener('visibilitychange', onVisible);
      ro.disconnect();
      input.dispose();
      socket.current?.close();
      term.dispose();
      termRef.current = null;
    };
  }, [id, kind]);

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

  return (
    <div className="term">
      <header className="term__bar">
        <a className="btn btn--ghost btn--sm" href={sessionHref(id)} title="回到时间线">
          ←
        </a>
        <span className="term__title">{title || '终端'}</span>
        <nav className="term__tabs">
          <a className={`term__tab${kind === 'agent' ? ' is-on' : ''}`} href={shellHref(id, 'agent')}>
            {AGENT_LABEL[id.split(':')[0] as AgentId] ?? 'Agent'}
          </a>
          <a className={`term__tab${kind === 'shell' ? ' is-on' : ''}`} href={shellHref(id, 'shell')}>
            Shell
          </a>
        </nav>
        <span className={`term__status${live ? ' is-live' : ''}`}>
          {live ? <span className="live-dot" aria-hidden="true" /> : null}
          {STATUS_LABEL[status]}
        </span>
        {live ? (
          <button className="linkbtn" onClick={kill}>
            结束
          </button>
        ) : null}
        {status === 'exited' || status === 'error' ? (
          <button className="linkbtn" onClick={() => location.reload()}>
            重新打开
          </button>
        ) : null}
      </header>
      {message ? <div className={`term__msg${status === 'error' ? ' is-error' : ''}`}>{message}</div> : null}
      <div className="term__screen" ref={host} />
      <div className="term__keys">
        {KEYS.map((k) => (
          <button key={k.label} className="term__key" onClick={() => press(k.seq)} disabled={!live}>
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}
