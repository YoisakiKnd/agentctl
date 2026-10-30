/**
 * 网页上粘贴 / 拖进来的附件。字节由 server 存成本地文件，适配器拿到的是路径：
 * 支持看图的 agent 把图片当原生图片块发出去，其余文件（以及不支持图片的 agent）
 * 在消息末尾列出路径，让 agent 自己用读文件的工具去读。
 */
export interface Attachment {
  /** server 存放的绝对路径 */
  path: string;
  /** 原始文件名 */
  name: string;
  /** 按文件头识别出的类型；识别不出来时是浏览器报的类型或 application/octet-stream */
  mime: string;
  bytes: number;
}

/** 消息末尾附件清单的标题行。网页靠行首的它把这一段渲染成附件卡片，改了要同步改前端 */
export const ATTACHMENT_HEADER = '[附件]';
/**
 * 跟在标题后面的说明。附件在工作区外，不说一句的话，Codex 这类有沙箱的 agent
 * 会以为要越权、先来申请审批（其实沙箱只限制写，读哪里都行）
 */
const ATTACHMENT_NOTE = ' 用户附上的本地文件，可以直接读取';
/** 已作为图片块发出去的附件，路径后面加这句，免得模型再用读文件工具看一遍 */
export const INLINE_MARK = ' ← 图片已附在本条消息里';

/** 各家模型都能直接看的图片格式 */
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function isImageAttachment(a: Attachment): boolean {
  return IMAGE_MIMES.has(a.mime);
}

/**
 * 把附件路径列在消息末尾：`[附件]` 一行，下面每行一个绝对路径。
 * inlined：哪些附件已经作为图片块随消息发出（路径后面标注一句）
 */
export function withAttachmentList(text: string, attachments: Attachment[] | undefined, inlined?: (a: Attachment) => boolean): string {
  if (!attachments?.length) return text;
  const list = [ATTACHMENT_HEADER + ATTACHMENT_NOTE, ...attachments.map((a) => (inlined?.(a) ? a.path + INLINE_MARK : a.path))].join('\n');
  return text.trim() ? `${text}\n\n${list}` : list;
}

/** 按文件头识别图片格式；不是认识的图片返回 undefined */
export function sniffImage(head: Uint8Array): string | undefined {
  const at = (i: number, ...bytes: number[]) => bytes.every((b, k) => head[i + k] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return undefined;
}

/**
 * 标题、列表副标题用：去掉消息末尾的附件清单；只有附件时换成文件名。
 * 输入可能已经被压成一行（换行变空格）、还可能被截断，所以按 uploads/<id>/文件名 去找名字。
 */
export function stripAttachmentList(text: string): string {
  const at = text.search(/(?:^|\s)\[附件\](?=\s|$)/);
  if (at < 0) return text;
  const before = text.slice(0, at).trim();
  if (before) return before;
  const names = [...text.matchAll(/[\\/]uploads[\\/][0-9a-f-]{36}[\\/]([^\\/]+?)(?=\s+←|\s+[\\/]|\s*\n|\s*$)/g)]
    .map((m) => m[1]!.replace(/…$/, ''))
    .filter(Boolean);
  return names.length ? names.join('、') : '附件';
}
