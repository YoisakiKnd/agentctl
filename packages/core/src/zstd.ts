import { zstdDecompressSync } from 'node:zlib';

/**
 * 多帧拼接的 zstd 文件（DSH 每追加一批记录就写一帧）。
 *
 * Node 自带的 zstd 解压（1.5.x 绑定）只解第一帧，流式接口遇到第二帧会报 "Unknown frame descriptor"。
 * 所以这里按 RFC 8878 自己走帧头和块头，把每一帧切出来单独解压。
 * 顺带得到"已完整写完的字节数"：文件被追加时只需要从这里继续，尾部写了一半的帧下次再读。
 */

const MAGIC = 0xfd2fb528;
const SKIPPABLE_MASK = 0xfffffff0;
const SKIPPABLE = 0x184d2a50;

export interface ZstdFrame {
  start: number;
  end: number;
  /** 可跳过帧（元数据），不含内容 */
  skippable: boolean;
}

/** 从 from 起切出所有完整的帧；consumed 是最后一个完整帧的结尾 */
export function zstdFrames(buf: Buffer, from = 0): { frames: ZstdFrame[]; consumed: number } {
  const frames: ZstdFrame[] = [];
  let p = from;
  for (;;) {
    if (p + 4 > buf.length) break;
    const magic = buf.readUInt32LE(p);

    if ((magic & SKIPPABLE_MASK) >>> 0 === SKIPPABLE) {
      if (p + 8 > buf.length) break;
      const end = p + 8 + buf.readUInt32LE(p + 4);
      if (end > buf.length) break;
      frames.push({ start: p, end, skippable: true });
      p = end;
      continue;
    }
    if (magic !== MAGIC) throw new Error(`zstd 帧头损坏（偏移 ${p}）`);

    // 帧头：FHD 决定后面窗口描述符、字典 id、内容大小各占几个字节
    if (p + 5 > buf.length) break;
    const fhd = buf[p + 4];
    const fcsFlag = fhd >> 6;
    const singleSegment = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    const didFlag = fhd & 3;
    const headerLen =
      1 + (singleSegment ? 0 : 1) + [0, 1, 2, 4][didFlag] + (fcsFlag === 0 ? singleSegment : [0, 2, 4, 8][fcsFlag]);
    let q = p + 4 + headerLen;

    // 块：3 字节小端头，bit0 = 最后一块，bit1-2 = 类型（0 原始 / 1 RLE / 2 压缩），其余是大小
    let complete = false;
    while (q + 3 <= buf.length) {
      const h = buf[q] | (buf[q + 1] << 8) | (buf[q + 2] << 16);
      const last = h & 1;
      const type = (h >> 1) & 3;
      const size = h >>> 3;
      if (type === 3) throw new Error(`zstd 块类型非法（偏移 ${q}）`);
      q += 3 + (type === 1 ? 1 : size);
      if (q > buf.length) break;
      if (last) {
        q += checksum ? 4 : 0;
        complete = q <= buf.length;
        break;
      }
    }
    if (!complete) break;
    frames.push({ start: p, end: q, skippable: false });
    p = q;
  }
  return { frames, consumed: p };
}

/** 解压 buf[from..] 里所有完整的帧，返回拼好的内容与消耗到的位置 */
export function zstdDecompressFrames(buf: Buffer, from = 0): { data: Buffer; consumed: number } {
  const { frames, consumed } = zstdFrames(buf, from);
  const parts: Buffer[] = [];
  for (const f of frames) {
    if (!f.skippable) parts.push(zstdDecompressSync(buf.subarray(f.start, f.end)));
  }
  return { data: parts.length === 1 ? parts[0] : Buffer.concat(parts), consumed };
}
