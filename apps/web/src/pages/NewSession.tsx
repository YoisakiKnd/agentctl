import { useEffect, useMemo, useRef, useState } from 'react';
import { api, HttpError, type RunOptions } from '../api';
import { explicit, isSubmitKey, RunOptionFields } from '../components/Composer';
import { homeShorten, projectName } from '../format';
import { navigate, sessionHref } from '../router';
import { AGENT_LABEL, type AgentId, type AgentInfo, type SessionSummary } from '../types';
import { AgentBadge } from '../components/AgentBadge';
import Icon from '../components/Icon';
import { AttachButton, AttachmentTray, onPasteFiles, useAttachments, useDropZone } from '../components/Attachments';
import AppShell from '../components/Layout';
import WorkspacePicker from '../components/WorkspacePicker';

interface DirInfo {
  path: string;
  exists: boolean;
  creatable: boolean;
  error?: string;
}

/** 在某个目录里新开一个会话（Claude Code / Codex / DSH） */
export default function NewSession({ cwd: initialCwd, agent: initialAgent }: { cwd?: string; agent?: AgentId }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agent, setAgent] = useState<AgentId>(initialAgent ?? 'claude');
  const [cwd, setCwd] = useState(initialCwd ?? '');
  const [prompt, setPrompt] = useState('');
  const [opts, setOptsState] = useState<RunOptions>({});
  /** 每个 agent 上次用的模型 / 强度 / 权限模式，存在服务端：换浏览器、清缓存都还在 */
  const defaults = useRef<Record<string, RunOptions>>({});
  const touched = useRef(false);
  const setOpts = (next: RunOptions) => {
    touched.current = true;
    setOptsState(next);
    defaults.current[agent] = next;
    void api.saveRunDefaults(agent, explicit(next)).catch(() => undefined);
  };
  const [busy, setBusy] = useState(false);
  const files = useAttachments();
  const drop = useDropZone(files.add);
  const hasMessage = !!prompt.trim() || files.ids.length > 0;
  const [error, setError] = useState('');
  const [dir, setDir] = useState<DirInfo | null>(null);
  /** 目录不存在、等用户确认「在这里新建」 */
  const [confirmCreate, setConfirmCreate] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    api
      .runDefaults()
      .then(({ defaults: d }) => {
        defaults.current = d as Record<string, RunOptions>;
        if (!touched.current) setOptsState((d[initialAgent ?? 'claude'] as RunOptions | undefined) ?? {});
      })
      .catch(() => undefined);
  }, [initialAgent]);

  // 输入目录时检查一下：不存在的话提前说明「开始时会新建」
  useEffect(() => {
    setConfirmCreate(null);
    const value = cwd.trim();
    if (!value) {
      setDir(null);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api
        .checkDir(value, ctrl.signal)
        .then(setDir)
        .catch(() => undefined);
    }, 300);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [cwd]);

  useEffect(() => {
    api
      .sessions()
      // 不替用户预选目录：新项目点「选择…」，要接着在某个项目里干活再点下面的最近项目
      .then(({ sessions }) => setSessions(sessions))
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

  const start = async (createDir = false) => {
    if (!cwd.trim() || !hasMessage || files.uploading || busy) return;
    // 目录还不存在：先问一句再建
    if (!createDir && dir && !dir.exists && dir.creatable && dir.path) {
      setConfirmCreate(dir.path);
      return;
    }
    setBusy(true);
    setError('');
    setConfirmCreate(null);
    try {
      const { run } = await api.startRun({ agent, cwd: cwd.trim(), prompt, createDir, attachments: files.ids, ...explicit(opts) });
      if (!run.sessionKey) throw new Error('agent 没有返回会话 id');
      navigate(sessionHref(run.sessionKey).slice(1));
    } catch (err) {
      // 检查之后目录又被删了之类：服务端也会要求确认
      if (err instanceof HttpError && err.status === 409) setConfirmCreate(dir?.path ?? cwd.trim());
      else setError(err instanceof Error ? err.message : '启动失败');
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
                      setOptsState(defaults.current[a.id] ?? {});
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
            <span className="cwdrow">
              <input
                className="input mono"
                list="recent-cwds"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="点「选择…」浏览或新建，也可以直接输入路径"
                spellCheck={false}
                autoCapitalize="off"
              />
              <button type="button" className="btn" onClick={() => setPicking(true)} title="浏览文件夹、新建项目或克隆仓库">
                <Icon name="folder" size={14} />
                选择…
              </button>
            </span>
            <datalist id="recent-cwds">
              {recent.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
            {dir && cwd.trim() ? (
              dir.error ? (
                <span className="field__status is-error">
                  <Icon name="alert" size={12} />
                  {dir.error}
                </span>
              ) : !dir.exists && dir.creatable ? (
                <span className="field__status is-new">
                  <Icon name="plus" size={12} />
                  目录还不存在，开始时会新建 <span className="mono">{homeShorten(dir.path)}</span>
                </span>
              ) : null
            ) : null}
          </label>

          {recent.length > 0 ? (
            <div className="pillrow" aria-label="最近的项目">
              <span className="pillrow__label">最近的项目</span>
              {recent.slice(0, 10).map((c) => (
                <button
                  type="button"
                  key={c}
                  className={`pill pill--btn${c === cwd ? ' is-on' : ''}`}
                  aria-pressed={c === cwd}
                  // 再点一次取消
                  onClick={() => setCwd(c === cwd ? '' : c)}
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
              className={`input form__prompt${drop.over ? ' is-dropping' : ''}`}
              rows={7}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onPaste={(e) => onPasteFiles(e, files.add)}
              {...drop.props}
              onKeyDown={(e) => {
                // 多行表单里回车换行是常态，只认 Ctrl/⌘+Enter
                if ((e.metaKey || e.ctrlKey) && isSubmitKey(e)) {
                  e.preventDefault();
                  void start();
                }
              }}
              placeholder="想让它做什么？（Ctrl / ⌘ + Enter 开始；图片和文件可以直接粘贴或拖进来）"
              autoFocus
            />
          </label>
          <div className="form__attach">
            <AttachButton onFiles={files.add} />
            {files.items.length ? <AttachmentTray items={files.items} onRemove={files.remove} /> : <span className="form__attach-hint">添加图片或文件</span>}
          </div>

          <div className="form__actions">
            <div className="form__opts">
              <RunOptionFields agent={agent} value={opts} onChange={setOpts} />
            </div>
            <button className="btn btn--primary" type="submit" disabled={busy || !cwd.trim() || !hasMessage || files.uploading}>
              {busy ? '启动中…' : '开始'}
              {busy ? null : <Icon name="send" size={14} />}
            </button>
          </div>
          {confirmCreate ? (
            <div className="confirmbar" role="alertdialog" aria-label="新建项目目录">
              <Icon name="folder" size={16} />
              <div className="confirmbar__text">
                将在 <span className="mono">{confirmCreate}</span> 创建新项目，是否继续？
              </div>
              <div className="confirmbar__actions">
                <button type="button" className="btn btn--sm btn--primary" onClick={() => void start(true)} disabled={busy} autoFocus>
                  创建并开始
                </button>
                <button type="button" className="btn btn--sm" onClick={() => setConfirmCreate(null)}>
                  取消
                </button>
              </div>
            </div>
          ) : null}
          {error ? <div className="form__error">{error}</div> : null}
        </form>
        {picking ? (
          <WorkspacePicker
            initialPath={dir?.exists ? dir.path : undefined}
            onClose={() => setPicking(false)}
            onPick={(path) => {
              setCwd(path);
              setPicking(false);
            }}
          />
        ) : null}
        <p className="form__note">
          会话照常写进 <span className="mono">{agent === 'codex' ? '~/.codex/sessions' : agent === 'dsh' ? '~/.dsh/sessions' : '~/.claude/projects'}</span>
          ，之后在终端里
          <span className="mono"> {agent === 'codex' ? 'codex resume' : agent === 'dsh' ? 'dsh' : 'claude --resume'} </span>也能接着聊。
        </p>
      </div>
    </AppShell>
  );
}
