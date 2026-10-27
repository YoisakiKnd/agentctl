import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { SessionSummary } from '../types';

type Patch = { pinned?: boolean; tags?: string[]; title?: string };

/** 注解只存在 agentctl 的索引库里，不改 agent 的会话文件 */
function useAnnotate(session: SessionSummary, onChange: (s: SessionSummary) => void) {
  const [error, setError] = useState('');
  const save = async (patch: Patch) => {
    setError('');
    try {
      const { session: next } = await api.annotate(session.id, patch);
      onChange(next);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
      return false;
    }
  };
  return { save, error };
}

export function PinButton({ session, onChange }: { session: SessionSummary; onChange: (s: SessionSummary) => void }) {
  const { save, error } = useAnnotate(session, onChange);
  const on = !!session.pinned;
  return (
    <button
      type="button"
      className={`btn btn--ghost btn--sm pin-btn${on ? ' is-on' : ''}`}
      aria-pressed={on}
      title={error || (on ? '取消置顶' : '置顶：在会话列表最上面单独列出')}
      onClick={() => void save({ pinned: !on })}
    >
      {on ? '★' : '☆'}
      <span className="pin-btn__label">{on ? '已置顶' : '置顶'}</span>
    </button>
  );
}

/** 标题：点「改名」原地编辑；清空保存等于恢复 agent 自己的标题 */
export function TitleEditor({ session, onChange }: { session: SessionSummary; onChange: (s: SessionSummary) => void }) {
  const { save, error } = useAnnotate(session, onChange);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) field.current?.select();
  }, [editing]);

  if (!editing) {
    return (
      <h1 className="session__title">
        <span title={session.originalTitle ? `原标题：${session.originalTitle}` : undefined}>{session.title}</span>
        <button
          type="button"
          className="linkbtn title-edit"
          onClick={() => {
            setDraft(session.title);
            setEditing(true);
          }}
        >
          改名
        </button>
      </h1>
    );
  }

  const commit = async () => {
    const next = draft.trim();
    if (next === session.title) return setEditing(false);
    if (await save({ title: next })) setEditing(false);
  };

  return (
    <form
      className="title-form"
      onSubmit={(e) => {
        e.preventDefault();
        void commit();
      }}
    >
      <input
        ref={field}
        className="input"
        value={draft}
        maxLength={200}
        placeholder={session.originalTitle ?? session.title}
        aria-label="会话标题"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false);
        }}
      />
      <button className="btn btn--sm btn--primary" type="submit">
        保存
      </button>
      <button className="btn btn--sm" type="button" onClick={() => setEditing(false)}>
        取消
      </button>
      {session.originalTitle ? (
        <button className="linkbtn" type="button" onClick={() => void save({ title: '' }).then((ok) => ok && setEditing(false))}>
          恢复原标题
        </button>
      ) : null}
      {error ? <span className="title-form__error">{error}</span> : null}
    </form>
  );
}

export function TagEditor({ session, onChange }: { session: SessionSummary; onChange: (s: SessionSummary) => void }) {
  const { save, error } = useAnnotate(session, onChange);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [known, setKnown] = useState<string[]>([]);
  const tags = session.tags ?? [];

  useEffect(() => {
    if (!adding) return;
    api
      .tags()
      .then((d) => setKnown(d.tags.map((t) => t.tag)))
      .catch(() => undefined);
  }, [adding]);

  // 只按逗号（含全角）分隔：标签里可以有空格
  const add = async () => {
    const parts = draft.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
    if (!parts.length) return setAdding(false);
    if (await save({ tags: [...tags, ...parts.filter((p) => !tags.includes(p))] })) {
      setDraft('');
      setAdding(false);
    }
  };

  const suggestions = known.filter((k) => !tags.includes(k) && (!draft.trim() || k.toLowerCase().includes(draft.trim().toLowerCase()))).slice(0, 6);

  return (
    <span className="tags">
      {tags.map((t) => (
        <span className="tag" key={t}>
          {t}
          <button type="button" className="tag__x" aria-label={`去掉标签 ${t}`} onClick={() => void save({ tags: tags.filter((x) => x !== t) })}>
            ×
          </button>
        </span>
      ))}
      {adding ? (
        <form
          className="tags__form"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input
            className="input tags__input"
            autoFocus
            value={draft}
            maxLength={100}
            placeholder="标签，逗号分隔"
            aria-label="新标签"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setDraft('');
                setAdding(false);
              }
            }}
            onBlur={() => {
              if (!draft.trim()) setTimeout(() => setAdding(false), 150);
            }}
          />
          {suggestions.map((k) => (
            <button key={k} type="button" className="tag tag--suggest" onClick={() => void save({ tags: [...tags, k] }).then((ok) => ok && setAdding(false))}>
              {k}
            </button>
          ))}
        </form>
      ) : (
        <button type="button" className="linkbtn tags__add" onClick={() => setAdding(true)}>
          ＋ 标签
        </button>
      )}
      {error ? <span className="title-form__error">{error}</span> : null}
    </span>
  );
}
