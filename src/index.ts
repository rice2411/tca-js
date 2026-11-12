/**
 * tca — TikTok Chat API (giả lập TikTok Web), cùng ý tưởng với zca-js cho Zalo.
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
 * Lấy cookie lần đầu: `loginQR({ chromePath, onEvent })` — mở Chrome headless ở trang QR của TikTok
 * (API đăng nhập đòi chữ ký JS nên không làm thuần Node được), quét xong trả cookie. Xem README.
 */
import { API, fetchAccount, fetchWebId } from './api';
import { Context } from './context';
import { TikTokError } from './errors';
import type { Credentials, TikTokOptions } from './types';

export class TikTok {
  constructor(private readonly options: TikTokOptions = {}) {}

  /** Đăng nhập bằng cookie đã có. Cookie hết hạn → `TikTokError('SESSION_EXPIRED')`. */
  async login(credentials: Credentials): Promise<API> {
    const ctx = new Context(credentials, this.options);
    if (!ctx.cookies.get('sessionid') && !ctx.cookies.get('sid_tt')) {
      throw new TikTokError('SESSION_EXPIRED', 'Cookie không có sessionid');
    }
    const account = await fetchAccount(ctx);
    if (!account) throw new TikTokError('SESSION_EXPIRED', 'Cookie TikTok không còn đăng nhập');
    ctx.ownId = account.uid;
    ctx.deviceId = (await fetchWebId(ctx).catch(() => '')) || ctx.deviceId;
    if (!ctx.deviceId) throw new TikTokError('BAD_RESPONSE', 'Không lấy được wid (device_id) — cookie thiếu ttwid?');
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
