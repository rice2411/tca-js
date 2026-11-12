/**
 * tca — TikTok Chat API (emulating TikTok Web), same idea as zca-js for Zalo.
 *
 * ```ts
 * const api = await new TikTok().login({ cookies, deviceId });
 * api.listener.on('message', async (msg) => {
 *   if (msg.isSelf) return;
 *   await api.sendMessage(msg, 'Got it, thanks!');
 * });
 * api.listener.start();
 * ```
 *
 * Getting cookies the first time: `loginQR({ chromePath, onEvent })` — opens headless Chrome on TikTok's QR page
 * (the login API requires a JS signature so it can't be done in pure Node), returns cookies after scanning. See README.
 */
import { API, fetchAccount, fetchWebId } from './api';
import { Context } from './context';
import { TikTokError } from './errors';
import type { Credentials, TikTokOptions } from './types';

export class TikTok {
  constructor(private readonly options: TikTokOptions = {}) {}

  /** Log in with existing cookies. Expired cookies → `TikTokError('SESSION_EXPIRED')`. */
  async login(credentials: Credentials): Promise<API> {
    const ctx = new Context(credentials, this.options);
    if (!ctx.cookies.get('sessionid') && !ctx.cookies.get('sid_tt')) {
      throw new TikTokError('SESSION_EXPIRED', 'Cookie has no sessionid');
    }
    const account = await fetchAccount(ctx);
    if (!account) throw new TikTokError('SESSION_EXPIRED', 'TikTok cookie is no longer logged in');
    ctx.ownId = account.uid;
    ctx.deviceId = (await fetchWebId(ctx).catch(() => '')) || ctx.deviceId;
    if (!ctx.deviceId) throw new TikTokError('BAD_RESPONSE', 'Could not get wid (device_id) — cookie missing ttwid?');
    return new API(ctx, account);
  }
}

export { API } from './api';
export type { SendResult } from './api';
export { MessageType } from './constants';
export { TikTokError } from './errors';
export type { TikTokErrorCode } from './errors';
export { Listener, MANUAL_CLOSE } from './listener';
export { loginQR } from './qr-login';
export type { QrLoginEvent, QrLoginOptions } from './qr-login';
export type { ListenerEvents } from './listener';
export type * from './types';
