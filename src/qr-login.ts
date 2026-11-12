import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { DEFAULT_USER_AGENT, WEB } from './constants';
import { TikTokError } from './errors';
import type { CookieInput, Credentials } from './types';

/**
 * QR login via headless Chrome.
 *
 * Why a browser: TikTok's QR API (`passport/web/check_qrconnect`) requires a JS signature
 * (X-Gnarly / msToken) — calling it bare from Node yields `error_code 7`. So we open the real
 * `tiktok.com/login/qrcode` page in headless Chrome and let it sign itself; we only LISTEN to
 * responses via CDP: the QR image from the `get_qrcode` body, the status from `check_qrconnect`.
 * After login we grab the cookies and close Chrome — everything after (`login`, chat) needs no browser.
 */

export type QrLoginEvent =
  /** New QR image (`data:image/png;base64,…`) — show it to the user to scan. A new one comes on expiry. */
  | { type: 'qr'; image: string; expiresAt: number }
  /** Scanned, waiting for confirmation on the phone. */
  | { type: 'scanned' }
  /** Confirmed — fetching cookies. */
  | { type: 'confirmed' };

export interface QrLoginOptions {
  /** Path to Chrome / Chromium (e.g. `/usr/bin/chromium-browser`). */
  chromePath: string;
  onEvent?: (e: QrLoginEvent) => void;
  signal?: AbortSignal;
  /** Total time to wait for a scan (ms) — default 5 minutes. */
  timeoutMs?: number;
  /** When the QR expires (~1 minute), regenerate it at most this many times. */
  maxRefresh?: number;
  userAgent?: string;
}

interface Cdp {
  send<T = Record<string, unknown>>(method: string, params?: object): Promise<T>;
  on(handler: (method: string, params: Record<string, unknown>) => void): void;
  close(): void;
}

/** Attach CDP to a new tab (a flat session on the browser websocket). */
async function openTab(browserWs: string): Promise<Cdp> {
  const ws = new WebSocket(browserWs, { perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  let id = 0;
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
  sessionId = (await raw<{ sessionId: string }>('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  return {
    send: (method, params) => raw(method, params, sessionId),
    on: (h) => handlers.push(h),
    close: () => ws.close(),
  };
}

/** Launch headless Chrome and wait for the "DevTools listening on ws://…" line. */
async function launchChrome(chromePath: string, userAgent: string): Promise<{ proc: ChildProcess; ws: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'tca-chrome-'));
  const proc = spawn(
    chromePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      // Containers run as root — Chromium requires disabling the sandbox.
      '--no-sandbox',
      '--window-size=1280,900',
      '--lang=vi-VN',
      // The default headless UA contains "HeadlessChrome" — replace it with a normal UA.
      `--user-agent=${userAgent}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const ws = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not start within 20s')), 20_000);
    proc.stderr!.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited (${code}) before it was ready`));
    });
  }).catch(async (err: unknown) => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
    throw new TikTokError('LOGIN_FAILED', `Failed to launch Chrome: ${err instanceof Error ? err.message : String(err)}`);
  });
  return { proc, ws, dir };
}

/**
 * Log in to TikTok via QR. Returns `Credentials` (`.tiktok.com` cookies + UA) — pass them to
 * `new TikTok().login(creds)` and SAVE them so you don't need to scan next time.
 */
export async function loginQR(opts: QrLoginOptions): Promise<Credentials> {
  const userAgent = opts.userAgent || DEFAULT_USER_AGENT;
  const maxRefresh = opts.maxRefresh ?? 3;
  const { proc, ws, dir } = await launchChrome(opts.chromePath, userAgent);
  let cdp: Cdp | null = null;
  try {
    cdp = await openTab(ws);
    const tab = cdp;
    await tab.send('Network.enable');
    await tab.send('Page.enable');

    const result = new Promise<Credentials>((resolve, reject) => {
      const urlById = new Map<string, string>();
      let refreshes = 0;
      let scanned = false;
      let done = false;
      const finish = (err: Error | null, creds?: Credentials) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(creds!);
      };
      const timer = setTimeout(
        () => finish(new TikTokError('LOGIN_FAILED', 'Timed out waiting for QR scan')),
        opts.timeoutMs ?? 5 * 60_000,
      );
      const onAbort = () => finish(new TikTokError('LOGIN_ABORTED', 'QR login aborted'));
      opts.signal?.addEventListener('abort', onAbort);

      const body = async (requestId: string): Promise<{ data?: Record<string, unknown> } | null> => {
        const r = await tab.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId }).catch(() => null);
        if (!r) return null;
        try {
          return JSON.parse(r.base64Encoded ? Buffer.from(r.body, 'base64').toString() : r.body) as { data?: Record<string, unknown> };
        } catch {
          return null;
        }
      };

      /** After `confirmed`: the page redirects and sets session cookies — wait for `sessionid`. */
      const collectCookies = async () => {
        for (let i = 0; i < 30 && !done; i++) {
          const { cookies } = await tab.send<{ cookies: (CookieInput & { domain: string })[] }>('Network.getAllCookies');
          const mine = cookies.filter((c) => c.domain.endsWith('tiktok.com'));
          if (mine.some((c) => c.name === 'sessionid' && c.value) && mine.some((c) => c.name === 'ttwid')) {
            // Same name on `.tiktok.com` and `www.tiktok.com` → keep the `.tiktok.com` one.
            const byName = new Map<string, CookieInput>();
            for (const c of mine.sort((a, b) => (a.domain === '.tiktok.com' ? 1 : 0) - (b.domain === '.tiktok.com' ? 1 : 0))) {
              byName.set(c.name, { name: c.name, value: c.value });
            }
            return finish(null, { cookies: [...byName.values()], userAgent });
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        finish(new TikTokError('LOGIN_FAILED', 'Confirmed but no sessionid cookie found'));
      };

      tab.on((method, p) => {
        if (done) return;
        if (method === 'Network.responseReceived') {
          const res = p.response as { url: string };
          urlById.set(p.requestId as string, res.url);
          return;
        }
        if (method !== 'Network.loadingFinished') return;
        const url = urlById.get(p.requestId as string) ?? '';
        if (url.includes('/passport/web/get_qrcode/')) {
          void body(p.requestId as string).then((j) => {
            const qr = j?.data?.qrcode;
            if (typeof qr === 'string' && qr) {
              opts.onEvent?.({
                type: 'qr',
                image: `data:image/png;base64,${qr}`,
                expiresAt: Number(j?.data?.expire_time ?? 0) * 1000 || Date.now() + 60_000,
              });
            }
          });
        } else if (url.includes('/passport/web/check_qrconnect/')) {
          // The page polls 3 regions in parallel (sg/us/eu) — only the account's region changes status, the rest stay "new".
          void body(p.requestId as string).then((j) => {
            const status = String(j?.data?.status ?? '');
            if (status === 'scanned' && !scanned) {
              scanned = true;
              opts.onEvent?.({ type: 'scanned' });
            } else if (status === 'confirmed') {
              opts.onEvent?.({ type: 'confirmed' });
              void collectCookies();
            } else if (status === 'expired' && !scanned) {
              if (refreshes++ >= maxRefresh) finish(new TikTokError('LOGIN_FAILED', 'QR expired without being scanned'));
              else void tab.send('Page.reload');
            }
          });
        }
      });
    });

    await tab.send('Page.navigate', { url: `${WEB}/login/qrcode` });
    return await result;
  } finally {
    cdp?.close();
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
