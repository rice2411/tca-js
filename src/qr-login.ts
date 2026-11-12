import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { DEFAULT_USER_AGENT, WEB } from './constants';
import { TikTokError } from './errors';
import type { CookieInput, Credentials } from './types';

/**
 * Đăng nhập bằng QR qua Chrome headless.
 *
 * Vì sao cần trình duyệt: API QR của TikTok (`passport/web/check_qrconnect`) đòi chữ ký JS
 * (X-Gnarly / msToken) — gọi trần từ Node bị `error_code 7`. Nên mở đúng trang
 * `tiktok.com/login/qrcode` trong Chrome headless để chính trang tự ký, còn mình chỉ NGHE
 * phản hồi qua CDP: ảnh QR lấy từ body `get_qrcode`, trạng thái từ body `check_qrconnect`.
 * Đăng nhập xong lấy cookie rồi tắt Chrome — mọi việc sau đó (`login`, chat) không cần trình duyệt.
 */

export type QrLoginEvent =
  /** Ảnh QR mới (`data:image/png;base64,…`) — hiện cho người dùng quét. Hết hạn thì có ảnh mới. */
  | { type: 'qr'; image: string; expiresAt: number }
  /** Đã quét, chờ bấm xác nhận trên điện thoại. */
  | { type: 'scanned' }
  /** Đã xác nhận — đang lấy cookie. */
  | { type: 'confirmed' };

export interface QrLoginOptions {
  /** Đường dẫn Chrome / Chromium (vd `/usr/bin/chromium-browser`). */
  chromePath: string;
  onEvent?: (e: QrLoginEvent) => void;
  signal?: AbortSignal;
  /** Tổng thời gian chờ quét (ms) — mặc định 5 phút. */
  timeoutMs?: number;
  /** QR hết hạn (~1 phút) thì tạo lại tối đa chừng này lần. */
  maxRefresh?: number;
  userAgent?: string;
}

interface Cdp {
  send<T = Record<string, unknown>>(method: string, params?: object): Promise<T>;
  on(handler: (method: string, params: Record<string, unknown>) => void): void;
  close(): void;
}

/** Nối CDP vào một tab mới (một session phẳng trên websocket của trình duyệt). */
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

/** Chạy Chrome headless, chờ dòng "DevTools listening on ws://…". */
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
      // Trong container chạy root — Chromium đòi tắt sandbox.
      '--no-sandbox',
      '--window-size=1280,900',
      '--lang=vi-VN',
      // UA mặc định của headless có chữ "HeadlessChrome" — thay bằng UA thường.
      `--user-agent=${userAgent}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const ws = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome không khởi động sau 20s')), 20_000);
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
      reject(new Error(`Chrome thoát (${code}) trước khi sẵn sàng`));
    });
  }).catch(async (err: unknown) => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
    throw new TikTokError('LOGIN_FAILED', `Không mở được Chrome: ${err instanceof Error ? err.message : String(err)}`);
  });
  return { proc, ws, dir };
}

/**
 * Đăng nhập TikTok bằng QR. Trả `Credentials` (cookie `.tiktok.com` + UA) — đưa vào
 * `new TikTok().login(creds)` và LƯU LẠI để lần sau khỏi quét.
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
        () => finish(new TikTokError('LOGIN_FAILED', 'Hết thời gian chờ quét QR')),
        opts.timeoutMs ?? 5 * 60_000,
      );
      const onAbort = () => finish(new TikTokError('LOGIN_ABORTED', 'Đã huỷ đăng nhập QR'));
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

      /** Sau `confirmed`: trang tự chuyển hướng + đặt cookie phiên — chờ có `sessionid`. */
      const collectCookies = async () => {
        for (let i = 0; i < 30 && !done; i++) {
          const { cookies } = await tab.send<{ cookies: (CookieInput & { domain: string })[] }>('Network.getAllCookies');
          const mine = cookies.filter((c) => c.domain.endsWith('tiktok.com'));
          if (mine.some((c) => c.name === 'sessionid' && c.value) && mine.some((c) => c.name === 'ttwid')) {
            // Trùng tên ở `.tiktok.com` và `www.tiktok.com` → giữ bản `.tiktok.com`.
            const byName = new Map<string, CookieInput>();
            for (const c of mine.sort((a, b) => (a.domain === '.tiktok.com' ? 1 : 0) - (b.domain === '.tiktok.com' ? 1 : 0))) {
              byName.set(c.name, { name: c.name, value: c.value });
            }
            return finish(null, { cookies: [...byName.values()], userAgent });
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        finish(new TikTokError('LOGIN_FAILED', 'Đã xác nhận nhưng không thấy cookie sessionid'));
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
          // Trang hỏi song song 3 vùng (sg/us/eu) — chỉ vùng của tài khoản đổi trạng thái, còn lại vẫn "new".
          void body(p.requestId as string).then((j) => {
            const status = String(j?.data?.status ?? '');
            if (status === 'scanned' && !scanned) {
              scanned = true;
              opts.onEvent?.({ type: 'scanned' });
            } else if (status === 'confirmed') {
              opts.onEvent?.({ type: 'confirmed' });
              void collectCookies();
            } else if (status === 'expired' && !scanned) {
              if (refreshes++ >= maxRefresh) finish(new TikTokError('LOGIN_FAILED', 'QR hết hạn, không ai quét'));
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
