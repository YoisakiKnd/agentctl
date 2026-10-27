import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

type Rec = Record<string, unknown>;

/**
 * 子进程上的 JSON-RPC 2.0（stdio，一行一条）：Codex app-server、DSH 的 ACP 都是这种形态。
 * 同时充当客户端（我们发请求）和服务端（对方发审批之类的请求过来）。
 */
export function spawnJsonRpc(file: string, args: string[], cwd?: string, env?: Record<string, string>) {
  const child = spawn(file, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : process.env });
  let nextId = 1;
  const waiters = new Map<number, { resolve: (v: Rec) => void; reject: (e: Error) => void }>();
  let onNotify: (method: string, params: Rec) => void = () => undefined;
  let onRequest: (id: number | string, method: string, params: Rec) => void = () => undefined;

  const write = (obj: Rec) => {
    if (!child.stdin.writable) throw new Error('agent 进程已退出');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...obj })}\n`);
  };

  createInterface({ input: child.stdout }).on('line', (text) => {
    let d: Rec;
    try {
      d = JSON.parse(text) as Rec;
    } catch {
      return;
    }
    const method = typeof d.method === 'string' ? d.method : undefined;
    if (method && d.id !== undefined) onRequest(d.id as number | string, method, (d.params ?? {}) as Rec);
    else if (method) onNotify(method, (d.params ?? {}) as Rec);
    else if (typeof d.id === 'number' && waiters.has(d.id)) {
      const w = waiters.get(d.id)!;
      waiters.delete(d.id);
      const err = d.error as { message?: string } | undefined;
      if (err) w.reject(new Error(err.message ?? '请求失败'));
      else w.resolve((d.result ?? {}) as Rec);
    }
  });
  child.on('exit', () => {
    for (const w of waiters.values()) w.reject(new Error('agent 进程已退出'));
    waiters.clear();
  });

  return {
    child,
    request(method: string, params: Rec): Promise<Rec> {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        waiters.set(id, { resolve, reject });
        try {
          write({ id, method, params });
        } catch (err) {
          waiters.delete(id);
          reject(err as Error);
        }
      });
    },
    notify(method: string, params?: Rec) {
      write(params ? { method, params } : { method });
    },
    reply(id: number | string, result: Rec) {
      write({ id, result });
    },
    replyError(id: number | string, message: string) {
      write({ id, error: { code: -32601, message } });
    },
    set onNotification(fn: (method: string, params: Rec) => void) {
      onNotify = fn;
    },
    set onServerRequest(fn: (id: number | string, method: string, params: Rec) => void) {
      onRequest = fn;
    },
  };
}

export type JsonRpcProcess = ReturnType<typeof spawnJsonRpc>;
