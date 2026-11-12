import { AID_FRONTIER, WEB } from '../protocol/constants';
import type { Context } from '../protocol/context';
import type { TikTokAccount } from '../models/types';

/** Account for the cookie — `null` if the cookie is no longer logged in. */
export async function fetchAccount(ctx: Context): Promise<TikTokAccount | null> {
  type Res = {
    message?: string;
    data?: { user_id_str?: string; username?: string; screen_name?: string; avatar_url?: string; error_code?: number };
  };
  const res = await ctx.getJson<Res>(`${WEB}/passport/web/account/info/?aid=${AID_FRONTIER}`);
  if (res.message !== 'success' || !res.data?.user_id_str) return null;
  return {
    uid: res.data.user_id_str,
    username: res.data.username ?? '',
    screenName: res.data.screen_name ?? '',
    avatar: res.data.avatar_url ?? '',
  };
}

/** `wid` — device id TikTok issues per `ttwid` cookie; IM + websocket use it as `device_id`. */
export async function fetchWebId(ctx: Context): Promise<string> {
  const res = await ctx.fetch(`${WEB}/api/v1/web-cookie-privacy/config?locale=vi-VN&appId=1988&theme=default&tea=1`);
  if (!res.ok) return '';
  return /"wid":"(\d+)"/.exec(await res.text())?.[1] ?? '';
}

/**
 * Avatar URLs from the IM profile `avatars` — collects every `https://…` string (thumb → medium → larger, whatever
 * TikTok returns), then puts browser-readable ones (jpeg/webp/png) first and heic last.
 */
export function avatarLinks(avatars: unknown): { avatar: string; avatars: string[] } {
  const urls: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (/^https?:\/\//.test(v) && !urls.includes(v)) urls.push(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(avatars);
  const heic = (u: string) => /\.heic(\?|$)/i.test(u.split('?')[0] + '?');
  const ranked = [...urls.filter((u) => !heic(u)), ...urls.filter(heic)];
  return { avatar: ranked[0] ?? '', avatars: ranked };
}
