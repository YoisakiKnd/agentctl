import { useEffect, useMemo, useState } from 'react';
import { api, type RunOptions } from '../api';
import { isSubmitKey, RunOptionFields } from '../components/Composer';
import { homeShorten, projectName } from '../format';
import { navigate, sessionHref } from '../router';
import { AGENT_LABEL, type AgentId, type AgentInfo, type SessionSummary } from '../types';

/** 在某个目录里新开一个会话（Claude Code / Codex） */
export default function NewSession({ cwd: initialCwd, agent: initialAgent }: { cwd?: string; agent?: AgentId }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agent, setAgent] = useState<AgentId>(initialAgent ?? 'claude');
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
    // 只列出命令行可用、并且接入了实时运行的 agent
    api
      .agents()
      .then(({ agents }) => setAgents(agents.filter((a) => a.available && a.capabilities.live)))
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
      const { run } = await api.startRun({ agent, cwd: cwd.trim(), prompt, ...opts });
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
          <span className="nav is-active" style={{ '--agent': `var(--${agent})` } as React.CSSProperties}>
            <span className="nav__label">新会话</span>
          </span>
        </nav>
      </aside>

      <main className="board board--narrow">
        <header className="board__head">
          <h1 className="board__title">新会话 · {AGENT_LABEL[agent]}</h1>
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
          {agents.length > 1 ? (
            <div className="field">
              <span className="field__label">Agent</span>
              <div className="newform__recent">
                {agents.map((a) => (
                  <button
                    type="button"
                    key={a.id}
                    className={`chip chip--btn${a.id === agent ? ' is-on' : ''}`}
                    style={{ '--agent': `var(--${a.id})` } as React.CSSProperties}
                    onClick={() => {
                      setAgent(a.id);
                      // 模型和权限选项各家不同，换 agent 时回到默认
                      setOpts({});
                    }}
                  >
                    {AGENT_LABEL[a.id]}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

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
            <RunOptionFields agent={agent} value={opts} onChange={setOpts} />
            <button className="btn btn--primary" type="submit" disabled={busy || !cwd.trim() || !prompt.trim()}>
              {busy ? '启动中…' : '开始'}
            </button>
          </div>
          {error ? <div className="login__error">{error}</div> : null}
          <p className="newform__note">
            会话照常写进 <span className="mono">{agent === 'codex' ? '~/.codex/sessions' : '~/.claude/projects'}</span>
            ，之后在终端里
            <span className="mono"> {agent === 'codex' ? 'codex resume' : 'claude --resume'} </span>也能接着聊。
          </p>
        </form>
      </main>
    </div>
  );
}
