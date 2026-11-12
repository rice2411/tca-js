import { rm } from 'node:fs/promises';
import { DEFAULT_USER_AGENT, WEB } from '../protocol/constants';
import { TikTokError } from '../errors';
import type { CookieInput, Credentials, TicketGuard } from '../models/types';
import { isTicketGuard, READ_TICKET_GUARD_JS } from '../protocol/ticket-guard';
import { openTab, type Cdp } from './cdp';
import { launchChrome, resolveChromePath } from './chrome';

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
  /**
   * Path to Chrome / Chromium (e.g. `/usr/bin/chromium-browser`). Optional — when omitted, `CHROME_PATH` and the
   * usual install locations are searched.
   */
  chromePath?: string;
  onEvent?: (e: QrLoginEvent) => void;
  signal?: AbortSignal;
  /** Total time to wait for a scan (ms) — default 5 minutes. */
  timeoutMs?: number;
  /** When the QR expires (~1 minute), regenerate it at most this many times. */
  maxRefresh?: number;
  userAgent?: string;
}

/**
 * Log in to TikTok via QR. Returns `Credentials` (`.tiktok.com` cookies + UA) — pass them to
 * `new TikTok().login(creds)` and SAVE them so you don't need to scan next time.
 */
export async function loginQR(opts: QrLoginOptions): Promise<Credentials> {
  const userAgent = opts.userAgent || DEFAULT_USER_AGENT;
  const maxRefresh = opts.maxRefresh ?? 3;
  const { proc, ws, dir } = await launchChrome(resolveChromePath(opts.chromePath), userAgent);
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
        const r = await tab
          .send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId })
          .catch(() => null);
        if (!r) return null;
        try {
          return JSON.parse(r.base64Encoded ? Buffer.from(r.body, 'base64').toString() : r.body) as {
            data?: Record<string, unknown>;
          };
        } catch {
          return null;
        }
      };

      /**
       * Ticket-guard signing material (needed to send since 12/11/2026). The security SDK stores it right after login;
       * if the post-login page didn't, open /messages (it signs `message/send`) and wait. `undefined` if never found.
       */
      const readTicketGuard = async (): Promise<TicketGuard | undefined> => {
        const read = async () => {
          const r = await tab
            .send<{ result?: { value?: unknown } }>('Runtime.evaluate', {
              expression: READ_TICKET_GUARD_JS,
              awaitPromise: true,
              returnByValue: true,
            })
            .catch(() => null);
          return isTicketGuard(r?.result?.value) ? r.result.value : undefined;
        };
        for (let i = 0; i < 8 && !done; i++) {
          const g = await read();
          if (g) return g;
          await new Promise((r) => setTimeout(r, 1000));
        }
        await tab.send('Page.navigate', { url: `${WEB}/messages` }).catch(() => undefined);
        for (let i = 0; i < 20 && !done; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const g = await read();
          if (g) return g;
        }
        return undefined;
      };

      /** After `confirmed`: the page redirects and sets session cookies — wait for `sessionid`. */
      const collectCookies = async () => {
        for (let i = 0; i < 30 && !done; i++) {
          const { cookies } = await tab.send<{ cookies: (CookieInput & { domain: string })[] }>(
            'Network.getAllCookies',
          );
          const mine = cookies.filter((c) => c.domain.endsWith('tiktok.com'));
          if (mine.some((c) => c.name === 'sessionid' && c.value) && mine.some((c) => c.name === 'ttwid')) {
            // Same name on `.tiktok.com` and `www.tiktok.com` → keep the `.tiktok.com` one.
            const byName = new Map<string, CookieInput>();
            for (const c of mine.sort(
              (a, b) => (a.domain === '.tiktok.com' ? 1 : 0) - (b.domain === '.tiktok.com' ? 1 : 0),
            )) {
              byName.set(c.name, { name: c.name, value: c.value });
            }
            const ticketGuard = await readTicketGuard();
            return finish(null, { cookies: [...byName.values()], userAgent, ...(ticketGuard ? { ticketGuard } : {}) });
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
              if (refreshes++ >= maxRefresh)
                finish(new TikTokError('LOGIN_FAILED', 'QR expired without being scanned'));
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
