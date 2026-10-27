import { useEffect, useMemo, useState } from 'react';
import { api, type RunOptions } from '../api';
import { isSubmitKey, RunOptionFields } from '../components/Composer';
import { homeShorten, projectName } from '../format';
import { navigate, sessionHref } from '../router';
import { AGENT_LABEL, type AgentId, type AgentInfo, type SessionSummary } from '../types';
import { AgentBadge } from '../components/AgentBadge';
import Icon from '../components/Icon';
import AppShell from '../components/Layout';

const OPTS_KEY = 'agentctl.new-opts';

function savedOpts(agent: AgentId): RunOptions {
  try {
    const raw = localStorage.getItem(`${OPTS_KEY}.${agent}`);
    return raw ? (JSON.parse(raw) as RunOptions) : {};
  } catch {
    return {};
  }
}

/** 在某个目录里新开一个会话（Claude Code / Codex / DSH） */
export default function NewSession({ cwd: initialCwd, agent: initialAgent }: { cwd?: string; agent?: AgentId }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agent, setAgent] = useState<AgentId>(initialAgent ?? 'claude');
  const [cwd, setCwd] = useState(initialCwd ?? '');
  const [prompt, setPrompt] = useState('');
  const [opts, setOptsState] = useState<RunOptions>(() => savedOpts(initialAgent ?? 'claude'));
  // 每个 agent 记住上次新建时选的模型 / 强度 / 权限模式（只存在这个浏览器里）
  const setOpts = (next: RunOptions) => {
    setOptsState(next);
    try {
      localStorage.setItem(`${OPTS_KEY}.${agent}`, JSON.stringify(next));
    } catch {
      /* 存不了就只对这次有效 */
    }
  };
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
      const { run } = await api.startRun({
        agent,
        cwd: cwd.trim(),
        prompt,
        model: opts.model ?? 'default',
        effort: opts.effort ?? '',
        permissionMode: opts.permissionMode ?? 'default',
      });
      if (!run.sessionKey) throw new Error('agent 没有返回会话 id');
      navigate(sessionHref(run.sessionKey).slice(1));
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动失败');
      setBusy(false);
    }
  };

  return (
    <AppShell active="new" title="新会话">
      <div className="narrow">
        <header className="pagehead">
          <div className="pagehead__text">
            <h1 className="pagehead__title">新会话</h1>
            <p className="pagehead__sub">选一个 agent 和工作目录，写下第一条消息。会话照常写进 agent 自己的目录，终端里也能接着聊。</p>
          </div>
        </header>

        <form
          className="card form"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          {agents.length > 1 ? (
            <div className="field">
              <span className="field__label">Agent</span>
              <div className="agentpick">
                {agents.map((a) => (
                  <button
                    type="button"
                    key={a.id}
                    className={`agentpick__opt${a.id === agent ? ' is-on' : ''}`}
                    aria-pressed={a.id === agent}
                    onClick={() => {
                      setAgent(a.id);
                      // 模型和权限选项各家不同，换 agent 时换成那个 agent 上次的选择
                      setOptsState(savedOpts(a.id));
                    }}
                  >
                    <AgentBadge agent={a.id} />
                    <span>{AGENT_LABEL[a.id]}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <label className="field">
            <span className="field__label">工作目录 <span className="field__hint">agent 会在这里读写文件、执行命令</span></span>
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
            <div className="pillrow">
              {recent.slice(0, 10).map((c) => (
                <button
                  type="button"
                  key={c}
                  className={`pill pill--btn${c === cwd ? ' is-on' : ''}`}
                  onClick={() => setCwd(c)}
                  title={homeShorten(c)}
                >
                  <Icon name="folder" size={12} />
                  {projectName(c)}
                </button>
              ))}
            </div>
          ) : null}

          <label className="field">
            <span className="field__label">第一条消息</span>
            <textarea
              className="input form__prompt"
              rows={7}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                // 多行表单里回车换行是常态，只认 Ctrl/⌘+Enter
                if ((e.metaKey || e.ctrlKey) && isSubmitKey(e)) {
                  e.preventDefault();
                  void start();
                }
              }}
              placeholder="想让它做什么？（Ctrl / ⌘ + Enter 开始）"
              autoFocus
            />
          </label>

          <div className="form__actions">
            <div className="form__opts">
              <RunOptionFields agent={agent} value={opts} onChange={setOpts} />
            </div>
            <button className="btn btn--primary" type="submit" disabled={busy || !cwd.trim() || !prompt.trim()}>
              {busy ? '启动中…' : '开始'}
              {busy ? null : <Icon name="send" size={14} />}
            </button>
          </div>
          {error ? <div className="form__error">{error}</div> : null}
        </form>
        <p className="form__note">
          会话照常写进 <span className="mono">{agent === 'codex' ? '~/.codex/sessions' : agent === 'dsh' ? '~/.dsh/sessions' : '~/.claude/projects'}</span>
          ，之后在终端里
          <span className="mono"> {agent === 'codex' ? 'codex resume' : agent === 'dsh' ? 'dsh' : 'claude --resume'} </span>也能接着聊。
        </p>
      </div>
    </AppShell>
  );
}
