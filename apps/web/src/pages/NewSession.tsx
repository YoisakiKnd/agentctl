import { useEffect, useMemo, useState } from 'react';
import { api, type RunOptions } from '../api';
import { isSubmitKey, RunOptionFields } from '../components/Composer';
import { homeShorten, projectName } from '../format';
import { navigate, sessionHref } from '../router';
import type { SessionSummary } from '../types';

/** 在某个目录里新开一个 Claude Code 会话 */
export default function NewSession({ cwd: initialCwd }: { cwd?: string }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [cwd, setCwd] = useState(initialCwd ?? '');
  const [prompt, setPrompt] = useState('');
  const [opts, setOpts] = useState<RunOptions>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .sessions()
      .then(({ sessions }) => {
        setSessions(sessions);
        // 没指定目录时默认最近活跃的项目
        setCwd((cur) => cur || sessions.find((s) => s.cwd)?.cwd || '');
      })
      .catch(() => undefined);
  }, []);

  /** 最近用过的项目目录，按最近活动排序、去重 */
  const recent = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of sessions) {
      if (!s.cwd || seen.has(s.cwd)) continue;
      seen.add(s.cwd);
      out.push(s.cwd);
    }
    return out;
  }, [sessions]);

  const start = async () => {
    if (!cwd.trim() || !prompt.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const { run } = await api.startRun({ cwd: cwd.trim(), prompt, ...opts });
      if (!run.sessionKey) throw new Error('agent 没有返回会话 id');
      navigate(sessionHref(run.sessionKey).slice(1));
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动失败');
      setBusy(false);
    }
  };

  return (
    <div className="shell">
      <aside className="spine">
        <div className="spine__brand">agentctl</div>
        <nav className="spine__agents">
          <a className="nav" href="#/">
            <span className="nav__label">会话</span>
          </a>
          <span className="nav is-active" style={{ '--agent': 'var(--claude)' } as React.CSSProperties}>
            <span className="nav__label">新会话</span>
          </span>
        </nav>
      </aside>

      <main className="board board--narrow">
        <header className="board__head">
          <h1 className="board__title">新会话 · Claude Code</h1>
          <a className="linkbtn board__back" href="#/">
            返回会话
          </a>
        </header>

        <form
          className="newform"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <label className="field">
            <span className="field__label">工作目录（agent 会在这里读写文件、执行命令）</span>
            <input
              className="input mono"
              list="recent-cwds"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/home/you/project"
              spellCheck={false}
              autoCapitalize="off"
            />
            <datalist id="recent-cwds">
              {recent.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>

          {recent.length > 0 ? (
            <div className="newform__recent">
              {recent.slice(0, 8).map((c) => (
                <button
                  type="button"
                  key={c}
                  className={`chip chip--btn${c === cwd ? ' is-on' : ''}`}
                  onClick={() => setCwd(c)}
                  title={homeShorten(c)}
                >
                  {projectName(c)}
                </button>
              ))}
            </div>
          ) : null}

          <label className="field">
            <span className="field__label">第一条消息</span>
            <textarea
              className="input newform__prompt"
              rows={6}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                // 多行表单里回车换行是常态，只认 Ctrl/⌘+Enter
                if ((e.metaKey || e.ctrlKey) && isSubmitKey(e)) {
                  e.preventDefault();
                  void start();
                }
              }}
              placeholder="想让它做什么？"
              autoFocus
            />
          </label>

          <div className="newform__actions">
            <RunOptionFields value={opts} onChange={setOpts} />
            <button className="btn btn--primary" type="submit" disabled={busy || !cwd.trim() || !prompt.trim()}>
              {busy ? '启动中…' : '开始'}
            </button>
          </div>
          {error ? <div className="login__error">{error}</div> : null}
          <p className="newform__note">
            会话照常写进 <span className="mono">~/.claude/projects</span>，之后在终端里
            <span className="mono"> claude --resume </span>也能接着聊。
          </p>
        </form>
      </main>
    </div>
  );
}
