import { API } from './api/api';
import { fetchAccount, fetchWebId } from './api/account';
import { Context } from './protocol/context';
import { TikTokError } from './errors';
import type { Credentials, TikTokOptions } from './models/types';

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
