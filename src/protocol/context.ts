import { AID_WEB, BUILD_NUMBER, DEFAULT_USER_AGENT, IM_API, Resp, SDK_VERSION, WEB } from './constants';
import { TikTokError } from '../errors';
import { Msg, Writer } from './proto';
import type { CookieInput, Credentials, TikTokOptions } from '../models/types';

/** `name → value` cookies from any input shape of `Credentials.cookies`. */
export function normalizeCookies(input: Credentials['cookies']): Map<string, string> {
  const jar = new Map<string, string>();
  if (typeof input === 'string') {
    for (const part of input.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  } else if (Array.isArray(input)) {
    for (const c of input as CookieInput[]) if (c?.name) jar.set(c.name, String(c.value ?? ''));
  } else {
    for (const [k, v] of Object.entries(input ?? {})) jar.set(k, String(v));
  }
  return jar;
}

/** Shared state of a session: cookies, device id, uid, HTTP calls. */
export class Context {
  readonly cookies: Map<string, string>;
  /**
   * IM device id = the `wid` TikTok issues for the `ttwid` cookie (`login` fetches it). The websocket only
   * accepts this id — a made-up id gets 400 (HTTP IM isn't picky).
   */
  deviceId: string;
  readonly userAgent: string;
  ownId = '';
  private seq = 10_000;

  constructor(
    creds: Credentials,
    readonly options: TikTokOptions = {},
  ) {
    this.cookies = normalizeCookies(creds.cookies);
    this.deviceId = creds.deviceId ?? '';
    this.userAgent = creds.userAgent || DEFAULT_USER_AGENT;
  }

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  log(level: 'debug' | 'warn', msg: string): void {
    this.options.logger?.(level, msg);
  }

  /** `fetch` with cookies + UA + timeout. */
  async fetch(url: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        headers: {
          'User-Agent': this.userAgent,
          Referer: `${WEB}/`,
          Origin: WEB,
          Cookie: this.cookieHeader(),
          ...init.headers,
        },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });
    } catch (err) {
      throw new TikTokError('HTTP_ERROR', `${url.split('?')[0]}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async getJson<T>(url: string): Promise<T> {
    const res = await this.fetch(url);
    if (!res.ok) throw new TikTokError('HTTP_ERROR', `${url.split('?')[0]}: HTTP ${res.status}`, res.status);
    return (await res.json()) as T;
  }

  /** IM `Request` envelope: command + body + common headers. */
  buildRequest(cmd: number, bodyField: number, body: Buffer): Buffer {
    return new Writer()
      .int(1, cmd)
      .int(2, this.seq++)
      .bytes(3, SDK_VERSION)
      .bytes(4, '')
      .int(5, 3)
      .int(6, 0)
      .bytes(7, BUILD_NUMBER)
      .msg(8, new Writer().bytes(bodyField, body))
      .bytes(9, this.deviceId)
      .bytes(11, 'web')
      .map(15, {
        aid: AID_WEB,
        app_name: 'tiktok_web',
        channel: 'web',
        device_platform: 'web_pc',
        device_id: this.deviceId,
        user_is_login: 'true',
        user_agent: this.userAgent,
      })
      .int(18, 1)
      .finish();
  }

  /**
   * Call an IM command over HTTP. Returns the unwrapped body (`ResponseBody[cmd]`).
   * NO X-Gnarly/X-Bogus/msToken signature needed — the IM server only checks cookies (tested 09/11/2026).
   */
  async im(path: string, cmd: number, body: Buffer, bodyField: number = cmd): Promise<Msg> {
    const url = `${IM_API}${path}?aid=${AID_WEB}&version_code=1.0.0&app_name=tiktok_web&device_platform=web_pc`;
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-protobuf', Accept: 'application/x-protobuf' },
      body: new Uint8Array(this.buildRequest(cmd, bodyField, body)),
    });
    if (!res.ok) throw new TikTokError('HTTP_ERROR', `${path}: HTTP ${res.status}`, res.status);
    const resp = Msg.tryParse(Buffer.from(await res.arrayBuffer()));
    if (!resp) throw new TikTokError('BAD_RESPONSE', `${path}: response is not protobuf`);
    const status = resp.num(Resp.status);
    if (status !== 0) {
      const desc = resp.str(Resp.error);
      // Not logged in: 200005 (tested with a cookieless request).
      const code = status === 200005 ? 'SESSION_EXPIRED' : 'IM_ERROR';
      throw new TikTokError(code, `${path}: ${status} ${desc}`.trim(), status);
    }
    return resp.msg(Resp.body)?.msg(cmd) ?? resp.msg(Resp.body)?.msg(bodyField) ?? Msg.parse(Buffer.alloc(0));
  }
}
