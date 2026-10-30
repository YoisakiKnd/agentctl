import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sniffImage, type Attachment } from '@agentctl/core';
import { CONFIG_DIR } from './config.ts';

/**
 * 网页附件：一个附件一个目录 `uploads/<uuid>/<原文件名>`。
 * 目录名就是附件 id，文件名保留原样（agent 看到的路径里有它，读起来更明白）。
 */
export const UPLOADS_DIR = join(CONFIG_DIR, 'uploads');

/** 单个附件上限 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** 一条消息最多带几个附件 */
export const MAX_ATTACHMENTS = 20;

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface UploadInfo {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  path: string;
}

/** 去掉目录、控制字符和路径分隔符；太长的保留扩展名截断 */
export function safeName(raw: unknown): string {
  let name = typeof raw === 'string' ? raw : '';
  name = name.split(/[\\/]/).pop() ?? '';
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name === '.' || name === '..') name = 'file';
  if (name.length > 120) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name;
}

/** 浏览器报的类型只在识别不出图片时参考，而且只收形如 a/b 的 */
function mimeOf(head: Uint8Array, clientMime: unknown): string {
  const image = sniffImage(head);
  if (image) return image;
  if (typeof clientMime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(clientMime) && !clientMime.startsWith('image/')) {
    return clientMime.toLowerCase();
  }
  return 'application/octet-stream';
}

export async function saveUpload(data: Buffer, rawName: unknown, clientMime: unknown): Promise<UploadInfo> {
  const id = randomUUID();
  const name = safeName(rawName);
  const dir = join(UPLOADS_DIR, id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  await writeFile(path, data, { mode: 0o600 });
  return { id, name, mime: mimeOf(data.subarray(0, 16), clientMime), bytes: data.length, path };
}

/** 按 id 找回附件；id 不合法或文件不在了返回 undefined */
export async function findUpload(id: string): Promise<UploadInfo | undefined> {
  if (!ID_RE.test(id)) return undefined;
  const dir = join(UPLOADS_DIR, id);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  const name = names[0];
  if (!name) return undefined;
  const path = join(dir, name);
  const st = await stat(path).catch(() => undefined);
  if (!st?.isFile()) return undefined;
  const head = Buffer.alloc(16);
  const fh = await open(path, 'r');
  try {
    await fh.read(head, 0, 16, 0);
  } finally {
    await fh.close();
  }
  return { id, name, mime: mimeOf(head, undefined), bytes: st.size, path };
}

/** 请求里的附件 id 列表 → 适配器要的附件；有一个找不到就整个报错，免得悄悄丢附件 */
export async function resolveAttachments(raw: unknown): Promise<Attachment[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) throw new Error('attachments 必须是附件 id 数组');
  if (raw.length > MAX_ATTACHMENTS) throw new Error(`一条消息最多 ${MAX_ATTACHMENTS} 个附件`);
  const out: Attachment[] = [];
  for (const id of new Set(raw as string[])) {
    const u = await findUpload(id);
    if (!u) throw new Error('附件不存在或已被清理，请重新添加');
    out.push({ path: u.path, name: u.name, mime: u.mime, bytes: u.bytes });
  }
  return out;
}
