import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { api, type UploadInfo } from '../api';
import Icon from './Icon';

/** 与服务端一致：单个附件上限、一条消息最多几个 */
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_COUNT = 20;

export interface PendingAttachment {
  key: string;
  name: string;
  bytes: number;
  /** 图片的本地预览（object URL） */
  preview?: string;
  status: 'uploading' | 'done' | 'error';
  upload?: UploadInfo;
  error?: string;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)}MB`;
}

let seq = 0;

/** 待发送的附件：加进来就开始上传，发送时只带上传好的 id */
export function useAttachments() {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const ctrls = useRef(new Map<string, AbortController>());
  const previews = useRef(new Set<string>());
  const count = useRef(0);
  count.current = items.length;

  const patch = (key: string, next: Partial<PendingAttachment>) =>
    setItems((list) => list.map((a) => (a.key === key ? { ...a, ...next } : a)));

  const add = useCallback((files: File[]) => {
    const room = MAX_COUNT - count.current;
    const added: PendingAttachment[] = [];
    for (const file of files.slice(0, Math.max(0, room))) {
      const key = `a${++seq}`;
      const preview = /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? URL.createObjectURL(file) : undefined;
      if (preview) previews.current.add(preview);
      const item: PendingAttachment = { key, name: file.name, bytes: file.size, preview, status: 'uploading' };
      added.push(item);
      if (file.size > MAX_BYTES) {
        item.status = 'error';
        item.error = `超过 ${formatBytes(MAX_BYTES)} 上限`;
        continue;
      }
      const ctrl = new AbortController();
      ctrls.current.set(key, ctrl);
      api
        .upload(file, ctrl.signal)
        .then((upload) => patch(key, { status: 'done', upload }))
        .catch((err: unknown) => {
          if (ctrl.signal.aborted) return;
          patch(key, { status: 'error', error: err instanceof Error ? err.message : '上传失败' });
        })
        .finally(() => ctrls.current.delete(key));
    }
    if (files.length > room) {
      added.push({ key: `a${++seq}`, name: `另外 ${files.length - Math.max(0, room)} 个文件`, bytes: 0, status: 'error', error: `一条消息最多 ${MAX_COUNT} 个附件` });
    }
    if (added.length) setItems((list) => [...list, ...added]);
  }, []);

  /** 撤回排队的消息时，把它已上传好的附件放回来（不用重新上传） */
  const restore = useCallback((list: { uploadId?: string; name: string; mime: string; bytes: number }[]) => {
    const added: PendingAttachment[] = list.flatMap((a) =>
      a.uploadId
        ? [
            {
              key: `a${++seq}`,
              name: a.name,
              bytes: a.bytes,
              preview: /^image\/(png|jpeg|gif|webp)$/.test(a.mime) ? `/api/uploads/${a.uploadId}/${encodeURIComponent(a.name)}` : undefined,
              status: 'done' as const,
              upload: { id: a.uploadId, name: a.name, mime: a.mime, bytes: a.bytes, path: '' },
            },
          ]
        : [],
    );
    if (added.length) setItems((cur) => [...cur, ...added].slice(0, MAX_COUNT));
  }, []);

  const drop = (a: PendingAttachment) => {
    ctrls.current.get(a.key)?.abort();
    if (a.preview && previews.current.has(a.preview)) {
      URL.revokeObjectURL(a.preview);
      previews.current.delete(a.preview);
    }
  };

  const remove = useCallback((key: string) => {
    setItems((list) => {
      const a = list.find((x) => x.key === key);
      if (a) drop(a);
      return list.filter((x) => x.key !== key);
    });
  }, []);

  /** 发出去之后清空；已上传的文件留在服务端，agent 还要读 */
  const clear = useCallback(() => {
    setItems((list) => {
      list.forEach(drop);
      return [];
    });
  }, []);

  useEffect(
    () => () => {
      for (const c of ctrls.current.values()) c.abort();
      for (const url of previews.current) URL.revokeObjectURL(url);
    },
    [],
  );

  return {
    items,
    add,
    restore,
    remove,
    clear,
    ids: items.flatMap((a) => (a.upload ? [a.upload.id] : [])),
    uploading: items.some((a) => a.status === 'uploading'),
    failed: items.some((a) => a.status === 'error'),
  };
}

export type Attachments = ReturnType<typeof useAttachments>;

/** 截图粘贴进来的文件名都是 image.png，换成带时间的名字，agent 看到的路径更好认 */
function renamePasted(file: File, i: number): File {
  if (!/^image\.\w+$/.test(file.name)) return file;
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const ext = file.name.slice(file.name.lastIndexOf('.'));
  return new File([file], `pasted-${stamp}${i ? `-${i + 1}` : ''}${ext}`, { type: file.type, lastModified: file.lastModified });
}

/**
 * 粘贴：剪贴板里有文件就当附件。例外是从 Word / Excel 这类程序复制的内容——
 * 它们同时放了文字、HTML 和一张渲染图，这时用户要的是文字，照常粘贴。
 * （截图只有图；浏览器「复制图片」有图和 <img> 的 HTML 但没有纯文字；文件管理器复制文件没有 HTML。）
 */
export function onPasteFiles(e: ClipboardEvent, add: (files: File[]) => void): void {
  const files = [...e.clipboardData.files];
  if (!files.length) return;
  const plain = e.clipboardData.getData('text/plain');
  const html = e.clipboardData.types.includes('text/html');
  if (plain.trim() && html) return;
  e.preventDefault();
  add(files.map(renamePasted));
}

/** 拖文件进来；只认带文件的拖拽，拖一段文字照旧 */
export function useDropZone(add: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files');
  return {
    over,
    props: {
      onDragEnter: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current += 1;
        setOver(true);
      },
      onDragOver: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      },
      onDragLeave: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        add([...e.dataTransfer.files]);
      },
    },
  };
}

/** 回形针按钮：从文件选择器加附件 */
export function AttachButton({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className="iconbtn attachbtn"
        onClick={() => input.current?.click()}
        disabled={disabled}
        title="添加图片或文件（也可以直接粘贴、拖进来）"
        aria-label="添加附件"
      >
        <Icon name="clip" size={17} />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}

/** 待发送的附件卡片：图片显示缩略图，其余显示文件名和大小 */
export function AttachmentTray({ items, onRemove }: { items: PendingAttachment[]; onRemove: (key: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="atray">
      {items.map((a) => (
        <div
          key={a.key}
          className={`atray__item${a.preview ? ' atray__item--image' : ''}${a.status === 'error' ? ' is-error' : ''}`}
          title={a.error ? `${a.name}：${a.error}` : `${a.name} · ${formatBytes(a.bytes)}`}
        >
          {a.preview ? (
            <img className="atray__thumb" src={a.preview} alt={a.name} />
          ) : (
            <>
              <Icon name={a.status === 'error' ? 'alert' : 'file'} size={15} className="atray__icon" />
              <span className="atray__text">
                <span className="atray__name">{a.name}</span>
                <span className="atray__meta">{a.error ?? (a.bytes ? formatBytes(a.bytes) : '')}</span>
              </span>
            </>
          )}
          {a.status === 'uploading' ? <span className="atray__spin" aria-label="上传中" /> : null}
          {a.preview && a.status === 'error' ? <Icon name="alert" size={16} className="atray__badge" /> : null}
          <button type="button" className="atray__remove" onClick={() => onRemove(a.key)} aria-label={`移除 ${a.name}`}>
            <Icon name="x" size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ── 时间线里已发送的附件 ─────────────────────────────────── */

/** 与 core/attachments.ts 的 ATTACHMENT_HEADER / INLINE_MARK 一致 */
const ATTACHMENT_HEADER = '[附件]';
const INLINE_MARK = ' ← ';

/** 把消息末尾的附件清单拆出来：`[附件] 说明` 一行，下面每行一个绝对路径 */
export function splitAttachments(text: string): { text: string; paths: string[] } {
  const at = text.lastIndexOf(ATTACHMENT_HEADER);
  if (at < 0 || (at > 0 && text[at - 1] !== '\n')) return { text, paths: [] };
  const lines = text.slice(at + ATTACHMENT_HEADER.length).trimEnd().split('\n');
  lines.shift(); // 标题行剩下的是给 agent 看的说明
  const paths = lines.map((l) => {
    const mark = l.indexOf(INLINE_MARK);
    return (mark >= 0 ? l.slice(0, mark) : l).trim();
  });
  if (!paths.length || !paths.every((p) => p.startsWith('/') || /^[A-Za-z]:\\/.test(p))) return { text, paths: [] };
  return { text: text.slice(0, at).trimEnd(), paths };
}

/** agentctl 存的附件路径 → 取回地址；不是 agentctl 存的返回 undefined */
function uploadUrl(path: string): string | undefined {
  const m = /[\\/]uploads[\\/]([0-9a-f-]{36})[\\/]([^\\/]+)$/.exec(path);
  return m ? `/api/uploads/${m[1]}/${encodeURIComponent(m[2]!)}` : undefined;
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function SentAttachments({ paths }: { paths: string[] }) {
  if (!paths.length) return null;
  return (
    <div className="sent">
      {paths.map((p) => {
        const url = uploadUrl(p);
        const name = baseName(p);
        if (url && /\.(png|jpe?g|gif|webp)$/i.test(name)) {
          return (
            <a key={p} className="sent__image" href={url} target="_blank" rel="noreferrer" title={p}>
              <img src={url} alt={name} loading="lazy" />
            </a>
          );
        }
        const body = (
          <>
            <Icon name="file" size={13} />
            <span className="sent__name">{name}</span>
          </>
        );
        return url ? (
          <a key={p} className="pill sent__file" href={url} title={p} download={name}>
            {body}
          </a>
        ) : (
          <span key={p} className="pill sent__file mono" title={p}>
            {body}
          </span>
        );
      })}
    </div>
  );
}
