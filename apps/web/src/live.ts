import { useEffect, useState } from 'react';
import { api } from './api';
import type { LiveMessage, ModelInfo, PermissionMode, QueuedMessage, RunState, UnifiedEvent } from './types';

export interface Draft {
  block: 'text' | 'thinking';
  text: string;
}

export interface LiveView {
  /** 按到达顺序；同 uid 的后到事件原位覆盖（审批 pending → approved） */
  events: UnifiedEvent[];
  /** 正在流式生成、还没成为正式事件的那一块 */
  draft: Draft | null;
  state: RunState | null;
  error: string;
  /** 进程当前的权限模式（启动时与运行中切换后由服务端推送） */
  permissionMode: PermissionMode | null;
  /** 进程当前的模型，以及它自己报的可选模型（DSH 的 ACP 在建立会话后才给） */
  model: string | null;
  models: ModelInfo[] | null;
  /** 进程当前的推理强度（DSH 会报） */
  effort: string | null;
  /** 排队等着发的消息 */
  queue: QueuedMessage[];
  /** 这个 agent 能不能把消息插进正在进行的这一轮 */
  canSteer: boolean;
}

const IDLE: LiveView = {
  events: [],
  draft: null,
  state: null,
  error: '',
  permissionMode: null,
  model: null,
  models: null,
  effort: null,
  queue: [],
  canSteer: false,
};

/**
 * 订阅一次运行的事件流（SSE）。服务端先回放该运行的全部事件再接实时，
 * 所以刷新页面、断线重连都不会丢；重连带来的重复靠 uid 合并掉。
 */
export function useLiveRun(runId: string | null): LiveView {
  const [view, setView] = useState<LiveView>(IDLE);

  useEffect(() => {
    setView(IDLE);
    if (!runId) return;

    const order: string[] = [];
    const byUid = new Map<string, UnifiedEvent>();
    let draft: Draft | null = null;
    let state: RunState | null = null;
    let error = '';
    let permissionMode: PermissionMode | null = null;
    let model: string | null = null;
    let models: ModelInfo[] | null = null;
    let effort: string | null = null;
    let queue: QueuedMessage[] = [];
    let canSteer = false;
    let frame = 0;

    // 流式增量一秒几十条，合并到下一帧再渲染
    const flush = () => {
      frame = 0;
      setView({ events: order.map((u) => byUid.get(u)!), draft, state, error, permissionMode, model, models, effort, queue, canSteer });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(flush);
    };

    const es = new EventSource(api.streamUrl(runId));
    es.onmessage = (e: MessageEvent<string>) => {
      let msg: LiveMessage;
      try {
        msg = JSON.parse(e.data) as LiveMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case 'event': {
          const uid = msg.event.uid ?? `seq:${msg.event.seq}`;
          if (!byUid.has(uid)) order.push(uid);
          byUid.set(uid, msg.event);
          break;
        }
        case 'delta':
          draft =
            draft && draft.block === msg.block
              ? { block: draft.block, text: draft.text + msg.text }
              : { block: msg.block, text: msg.text };
          break;
        case 'delta_reset':
          draft = null;
          break;
        case 'config':
          if (msg.permissionMode) permissionMode = msg.permissionMode;
          if (msg.model) model = msg.model;
          if (msg.models?.length) models = msg.models;
          if (msg.effort !== undefined) effort = msg.effort;
          break;
        case 'queue':
          queue = msg.items;
          canSteer = msg.steer;
          break;
        case 'state':
          state = msg.state;
          if (msg.error) error = msg.error;
          if (msg.state === 'exited') {
            draft = null;
            es.close();
          }
          break;
      }
      schedule();
    };
    es.onerror = () => {
      // 运行已过期（服务端重启或超出保留期）时 EventSource 会无限重连，这里止损
      if (es.readyState === EventSource.CLOSED) {
        state ??= 'exited';
        schedule();
      }
    };

    return () => {
      es.close();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [runId]);

  return view;
}

/**
 * 磁盘回放 + 实时流合并。
 *
 * - 已落盘的实时事件（uid 在文件窗口里）以磁盘为准，丢弃实时副本；
 * - 最后一个已落盘事件之后的实时事件是"磁盘还没跟上"的新内容，接在末尾；
 * - 之前的非 transient 事件早于当前窗口，向前翻页时会从磁盘读到，这里不重复显示；
 * - transient 事件（审批卡等）没有磁盘对应物，锚定在实时流里它前面那个已落盘事件之后，
 *   这样刷新页面后它们仍出现在原来的位置，而不是全部堆到末尾。
 */
export function mergeEvents(file: UnifiedEvent[], live: UnifiedEvent[]): UnifiedEvent[] {
  if (live.length === 0) return file;
  const onDisk = new Set<string>();
  for (const ev of file) if (ev.uid) onDisk.add(ev.uid);

  let lastOnDisk = -1;
  live.forEach((ev, i) => {
    if (ev.uid && onDisk.has(ev.uid)) lastOnDisk = i;
  });

  const anchored = new Map<string, UnifiedEvent[]>();
  const tail: UnifiedEvent[] = [];
  let anchor: string | null = null;
  live.forEach((ev, i) => {
    if (ev.uid && onDisk.has(ev.uid)) {
      anchor = ev.uid;
    } else if (i > lastOnDisk) {
      tail.push(ev);
    } else if (ev.transient && anchor) {
      const list = anchored.get(anchor);
      if (list) list.push(ev);
      else anchored.set(anchor, [ev]);
    }
  });

  if (anchored.size === 0 && tail.length === 0) return file;
  const out: UnifiedEvent[] = [];
  for (const ev of file) {
    out.push(ev);
    const extra = ev.uid ? anchored.get(ev.uid) : undefined;
    if (extra) out.push(...extra);
  }
  out.push(...tail);
  return out;
}
