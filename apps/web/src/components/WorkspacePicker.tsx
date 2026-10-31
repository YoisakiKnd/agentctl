import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type CloneJob, type DirListing } from '../api';
import { homeShorten } from '../format';
import Icon from './Icon';
import { Switch } from './NotifySettings';

type Tab = 'browse' | 'create' | 'clone';

const errText = (err: unknown) => (err instanceof Error ? err.message : '操作失败');

/** 仓库地址 → 默认文件夹名（和服务端的推法一致，只用来显示占位） */
function repoName(url: string): string {
  const last = url.trim().replace(/[?#].*$/, '').replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
  return last.replace(/\.git$/, '').replace(/[^\w.-]/g, '-');
}

/**
 * 选工作目录：浏览服务器上的文件夹 / 在工作区下按名字新建项目 / 从 Git 仓库克隆。
 * 选定（或建好、克隆好）之后 onPick 交回绝对路径。
 */
export default function WorkspacePicker({
  initialPath,
  onPick,
  onClose,
}: {
  /** 浏览从这里开始（一般是输入框里已有的目录）；不给就从工作区根目录开始 */
  initialPath?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>('browse');
  const [root, setRoot] = useState('');
  /** 正在浏览、要把选中的目录设成工作区根目录（从「新建 / 克隆」页点「更改」过来） */
  const [pickingRoot, setPickingRoot] = useState<Tab | null>(null);

  useEffect(() => {
    api
      .workspaces()
      .then((w) => setRoot(w.root))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const changeRoot = (from: Tab) => {
    setPickingRoot(from);
    setTab('browse');
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="选择工作目录" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal__panel wpick">
        <div className="modal__head">
          <div className="segmented" role="tablist">
            {(
              [
                ['browse', '浏览文件夹'],
                ['create', '新建项目'],
                ['clone', '克隆仓库'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                className={tab === key ? 'is-on' : ''}
                onClick={() => {
                  setPickingRoot(null);
                  setTab(key);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="关闭">
            <Icon name="x" />
          </button>
        </div>

        {tab === 'browse' ? (
          <Browser
            start={pickingRoot ? root : initialPath || root}
            ready={!!root || !!initialPath}
            action={pickingRoot ? '设为工作区位置' : '选择这个目录'}
            onChoose={async (path) => {
              if (!pickingRoot) return onPick(path);
              const r = await api.setWorkspaceRoot(path);
              setRoot(r.root);
              setTab(pickingRoot);
              setPickingRoot(null);
            }}
          />
        ) : tab === 'create' ? (
          <CreateForm root={root} onChangeRoot={() => changeRoot('create')} onDone={onPick} />
        ) : (
          <CloneForm root={root} onChangeRoot={() => changeRoot('clone')} onDone={onPick} />
        )}
      </div>
    </div>
  );
}

/** 一级级点进去的文件夹浏览器；顶上是可点的路径，也能直接输入路径跳过去 */
function Browser({
  start,
  ready,
  action,
  onChoose,
}: {
  start: string;
  ready: boolean;
  action: string;
  onChoose: (path: string) => Promise<void> | void;
}) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [path, setPath] = useState(start);
  const [typed, setTyped] = useState(start);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ctrl = useRef<AbortController | null>(null);

  const load = useCallback(
    (p: string) => {
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      setLoading(true);
      setError('');
      api
        .listDir(p, hidden, c.signal)
        .then((l) => {
          setListing(l);
          setPath(l.path);
          setTyped(l.path);
          setNewName(null);
        })
        .catch((err: unknown) => {
          if (!c.signal.aborted) setError(errText(err));
        })
        .finally(() => {
          if (!c.signal.aborted) setLoading(false);
        });
    },
    [hidden],
  );

  useEffect(() => {
    if (ready) load(path || start);
    // 起点就绪（工作区根目录刚加载到）时加载；切换「显示隐藏」会换掉 load，重新列当前目录
  }, [ready, start, load]);
  useEffect(() => () => ctrl.current?.abort(), []);

  const crumbs = (listing?.path ?? '').split('/').filter(Boolean);

  const mkdir = async () => {
    if (!listing || !newName?.trim()) return;
    setBusy(true);
    setError('');
    try {
      const { path: made } = await api.mkdir(listing.path, newName.trim());
      load(made);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form
        className="wpick__path"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim()) load(typed.trim());
        }}
      >
        <input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} autoCapitalize="off" aria-label="路径" />
        <button type="submit" className="btn btn--sm">
          转到
        </button>
      </form>
      <div className="wpick__crumbs mono">
        <button type="button" className="linkbtn" onClick={() => load('/')}>
          /
        </button>
        {crumbs.map((c, i) => (
          <span key={i}>
            <button type="button" className="linkbtn" onClick={() => load(`/${crumbs.slice(0, i + 1).join('/')}`)}>
              {c}
            </button>
            {i < crumbs.length - 1 ? <span className="wpick__sep">/</span> : null}
          </span>
        ))}
        {listing?.git ? <span className="pill pill--quiet">git</span> : null}
      </div>

      <div className={`wpick__list${loading ? ' is-loading' : ''}`}>
        {listing?.parent ? (
          <button type="button" className="wpick__item" onClick={() => load(listing.parent!)}>
            <Icon name="back" size={14} />
            <span className="wpick__name">上一级</span>
          </button>
        ) : null}
        {listing?.entries.map((e) => (
          <button type="button" className="wpick__item" key={e.path} onClick={() => load(e.path)} onDoubleClick={() => void onChoose(e.path)}>
            <Icon name="folder" size={14} />
            <span className="wpick__name">{e.name}</span>
            {e.git ? <span className="pill pill--quiet">git</span> : null}
          </button>
        ))}
        {listing && !listing.entries.length ? <div className="wpick__empty">这里没有子文件夹</div> : null}
        {listing?.truncated ? <div className="wpick__empty">子文件夹太多，只列了前 1000 个；可以在上面直接输入路径</div> : null}
      </div>

      {newName !== null ? (
        <form
          className="wpick__new"
          onSubmit={(e) => {
            e.preventDefault();
            void mkdir();
          }}
        >
          <Icon name="folder" size={14} />
          <input className="input" autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="新文件夹名" />
          <button type="submit" className="btn btn--sm btn--primary" disabled={busy || !newName.trim()}>
            新建
          </button>
          <button type="button" className="btn btn--sm" onClick={() => setNewName(null)}>
            取消
          </button>
        </form>
      ) : null}
      {error ? <div className="form__error">{error}</div> : null}

      <div className="modal__foot">
        <button type="button" className="linkbtn" onClick={() => setNewName('')} disabled={!listing}>
          <Icon name="plus" size={13} /> 新建文件夹
        </button>
        <label className="wpick__hidden">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
          显示隐藏文件夹
        </label>
        <span className="modal__spacer" />
        <button
          type="button"
          className="btn btn--primary"
          disabled={!listing || busy}
          onClick={() => {
            if (!listing) return;
            setBusy(true);
            setError('');
            Promise.resolve(onChoose(listing.path))
              .catch((err: unknown) => setError(errText(err)))
              .finally(() => setBusy(false));
          }}
          title={listing?.path}
        >
          {action}
        </button>
      </div>
    </>
  );
}

function RootLine({ root, onChange }: { root: string; onChange: () => void }) {
  return (
    <div className="wpick__root">
      <span className="field__label">位置</span>
      <span className="mono wpick__rootpath" title={root}>
        {root ? homeShorten(root) : '…'}
      </span>
      <button type="button" className="linkbtn" onClick={onChange}>
        更改
      </button>
    </div>
  );
}

function CreateForm({ root, onChangeRoot, onDone }: { root: string; onChangeRoot: () => void; onDone: (path: string) => void }) {
  const [name, setName] = useState('');
  const [git, setGit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const { path } = await api.createWorkspace(name.trim(), git);
      onDone(path);
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };

  return (
    <form
      className="wpick__form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <RootLine root={root} onChange={onChangeRoot} />
      <label className="field">
        <span className="field__label">项目名</span>
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="my-project" spellCheck={false} autoCapitalize="off" />
        {name.trim() && root ? <span className="field__status mono">{homeShorten(`${root.replace(/\/$/, '')}/${name.trim()}`)}</span> : null}
      </label>
      <div className="wpick__opt">
        <Switch on={git} onChange={setGit} label="初始化 git 仓库" />
        <span>初始化 git 仓库（git init）</span>
      </div>
      {error ? <div className="form__error">{error}</div> : null}
      <div className="modal__foot">
        <span className="modal__spacer" />
        <button type="submit" className="btn btn--primary" disabled={busy || !name.trim() || !root}>
          {busy ? '创建中…' : '创建'}
        </button>
      </div>
    </form>
  );
}

function CloneForm({ root, onChangeRoot, onDone }: { root: string; onChangeRoot: () => void; onDone: (path: string) => void }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [job, setJob] = useState<CloneJob | null>(null);
  const [error, setError] = useState('');
  const running = job?.state === 'running';

  // 克隆在服务端后台跑，这里每秒问一次进度
  useEffect(() => {
    if (!job || job.state !== 'running') return;
    const t = setTimeout(() => {
      api
        .cloneJob(job.id)
        .then(({ job: next }) => {
          setJob(next);
          if (next.state === 'done') onDone(next.path);
          if (next.state === 'error') setError(next.error ?? '克隆失败');
        })
        .catch((err: unknown) => {
          setError(errText(err));
          setJob(null);
        });
    }, 1000);
    return () => clearTimeout(t);
  }, [job, onDone]);

  const submit = async () => {
    if (!url.trim() || running) return;
    setError('');
    try {
      const r = await api.cloneRepo(url.trim(), name.trim());
      setJob(r.job);
    } catch (err) {
      setError(errText(err));
    }
  };

  const guess = repoName(url);
  return (
    <form
      className="wpick__form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <RootLine root={root} onChange={onChangeRoot} />
      <label className="field">
        <span className="field__label">仓库地址</span>
        <input
          className="input mono"
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/owner/repo.git 或 git@github.com:owner/repo.git"
          spellCheck={false}
          autoCapitalize="off"
          disabled={running}
        />
      </label>
      <label className="field">
        <span className="field__label">
          文件夹名 <span className="field__hint">可选，默认用仓库名</span>
        </span>
        <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} placeholder={guess || 'repo'} spellCheck={false} autoCapitalize="off" disabled={running} />
        {root && (name.trim() || guess) ? <span className="field__status mono">{homeShorten(`${root.replace(/\/$/, '')}/${name.trim() || guess}`)}</span> : null}
      </label>
      <p className="wpick__note">用服务器上的 git 和凭据克隆；私有仓库需要服务器已经配好 SSH key 或凭据，这里不会弹出输入密码。</p>
      {running ? (
        <div className="wpick__progress mono">
          <span className="atray__spin" aria-hidden="true" />
          {job.progress || '正在连接…'}
        </div>
      ) : null}
      {error ? <div className="form__error wpick__err">{error}</div> : null}
      <div className="modal__foot">
        <span className="modal__spacer" />
        <button type="submit" className="btn btn--primary" disabled={running || !url.trim() || !root}>
          {running ? '克隆中…' : '克隆'}
        </button>
      </div>
    </form>
  );
}
