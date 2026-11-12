import WebSocket from 'ws';

/** Minimal Chrome DevTools Protocol client bound to one tab. */
export interface Cdp {
  send<T = Record<string, unknown>>(method: string, params?: object): Promise<T>;
  on(handler: (method: string, params: Record<string, unknown>) => void): void;
  close(): void;
}

/** Attach CDP to a new tab (a flat session on the browser websocket). */
export async function openTab(browserWs: string): Promise<Cdp> {
  const ws = new WebSocket(browserWs, { perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  let id = 0;
  // eslint-disable-next-line prefer-const -- the ws message handler reads it before Target.attachToTarget assigns it
  let sessionId: string | undefined;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const handlers: ((m: string, p: Record<string, unknown>) => void)[] = [];
  ws.on('message', (raw: Buffer) => {
    const m = JSON.parse(raw.toString()) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message: string };
      sessionId?: string;
    };
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id)!;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result ?? {});
      return;
    }
    if (m.method && (!m.sessionId || m.sessionId === sessionId)) for (const h of handlers) h(m.method, m.params ?? {});
  });
  const raw = <T>(method: string, params: object = {}, sid?: string): Promise<T> =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) }));
    });
  const target = await raw<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  sessionId = (await raw<{ sessionId: string }>('Target.attachToTarget', { targetId: target.targetId, flatten: true }))
    .sessionId;
  return {
    send: (method, params) => raw(method, params, sessionId),
    on: (h) => handlers.push(h),
    close: () => ws.close(),
  };
}
