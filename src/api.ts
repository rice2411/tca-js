import { randomUUID } from 'node:crypto';
import {
  AID_FRONTIER,
  Cmd,
  ConversationType,
  MARK_READ_BODY_FIELD,
  MessageType,
  PropertyOp,
  REACTION_HEART,
  REACTION_LOVE_KEY,
  REACTION_PREFIX,
  WEB,
} from './constants';
import type { Context } from './context';
import { TikTokError } from './errors';
import { Listener } from './listener';
import { MediaClient } from './media';
import { parseConversation, parseMessage } from './message';
import { Writer } from './proto';
import type {
  ConversationPage,
  ConversationRef,
  ImageInput,
  MessagePage,
  TikTokAccount,
  TikTokImage,
  TikTokMessage,
  TikTokSticker,
  TikTokUser,
} from './types';

/** "Latest" cursor for reading history — greater than any `index` (µs). */
const NEWEST = 9_999_999_999_999_999n;

/** Send result: client-side message id (TikTok echoes it back). The server id arrives via the listener (`isSelf`). */
export interface SendResult {
  clientMessageId: string;
}

/**
 * A logged-in TikTok session — create with `new TikTok().login(credentials)`.
 * All calls go directly over HTTP/WS to TikTok using cookies, no browser needed.
 */
export class API {
  readonly listener: Listener;
  private readonly media: MediaClient;

  constructor(
    private readonly ctx: Context,
    readonly account: TikTokAccount,
  ) {
    this.listener = new Listener(ctx);
    this.media = new MediaClient(ctx);
  }

  getOwnId(): string {
    return this.ctx.ownId;
  }

  /** Current cookies — save them so the next `login` needs no QR scan. */
  getCookies(): { name: string; value: string }[] {
    return [...this.ctx.cookies].map(([name, value]) => ({ name, value }));
  }

  getContext(): { deviceId: string; userAgent: string } {
    return { deviceId: this.ctx.deviceId, userAgent: this.ctx.userAgent };
  }

  /** Whether the session is still alive — call periodically to detect expiry early. */
  async isAlive(): Promise<boolean> {
    return (await fetchAccount(this.ctx).catch(() => null)) !== null;
  }

  // ─── Inbox ─────────────────────────────────────────────────────────────────

  /** Recent conversations + their latest messages, paginated with `cursor`. */
  async getConversations(cursor = '0'): Promise<ConversationPage> {
    const body = await this.ctx.im('/v2/message/get_by_user_init', Cmd.GetMessagesByUserInit, new Writer().int(1, BigInt(cursor)).finish());
    return {
      messages: body.msgs(1).map((m) => parseMessage(m, this.ctx.ownId)),
      conversations: body.msgs(2).map((m) => parseConversation(m, this.ctx.ownId)),
      // Cursor = number of conversations fetched so far (0, 10, 20…) — field 4; field 3 is a timestamp, not used for paging.
      cursor: body.id(4),
      hasMore: body.num(5) === 1,
    };
  }

  /** Messages of a conversation, newest first. For older messages: `before = <index of oldest message>`. */
  async getMessages(conv: ConversationRef, opts: { limit?: number; before?: string } = {}): Promise<MessagePage> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    const body = await this.ctx.im(
      '/v1/message/get_by_conversation',
      Cmd.GetMessagesByConversation,
      new Writer()
        .bytes(1, conv.conversationId)
        .int(2, ConversationType.OneToOne)
        .int(3, BigInt(conv.conversationShortId))
        .int(4, 1) // direction: older than cursor
        .int(5, opts.before ? BigInt(opts.before) : NEWEST)
        .int(6, limit)
        .finish(),
    );
    const messages = body.msgs(1).map((m) => parseMessage(m, this.ctx.ownId));
    return { messages, hasMore: messages.length >= limit };
  }

  /** User profiles by uid (display name, @username, avatar). */
  async getUsers(uids: string[]): Promise<TikTokUser[]> {
    if (uids.length === 0) return [];
    const q = new URLSearchParams({
      aid: '1988',
      app_name: 'tiktok_web',
      device_platform: 'web_pc',
      source: 'im_chat',
      from_page: 'message',
      user_ids: JSON.stringify(uids),
    });
    type Res = {
      status_code?: number;
      users?: {
        im_user_profile?: {
          user_id_str?: string;
          unique_id?: string;
          nick_name?: string;
          avatars?: unknown;
        };
      }[];
    };
    const res = await this.ctx.getJson<Res>(`${WEB}/tiktok/v1/im/user/profile/?${q}`);
    if (res.status_code) throw new TikTokError('IM_ERROR', `user/profile: ${res.status_code}`, res.status_code);
    return (res.users ?? []).map(({ im_user_profile: p = {} }) => ({
      uid: p.user_id_str ?? '',
      uniqueId: p.unique_id ?? '',
      nickname: p.nick_name ?? '',
      ...avatarLinks(p.avatars),
    }));
  }

  /**
   * Download an avatar (tries each URL in turn, skips heic). No cookie / Referer sent: the image CDN is cross-origin and
   * URLs are already signed. `null` if no URL could be downloaded.
   */
  async downloadAvatar(user: Pick<TikTokUser, 'avatars'>): Promise<{ data: Buffer; type: string } | null> {
    for (const url of user.avatars) {
      const res = await fetch(url, {
        headers: { 'User-Agent': this.ctx.userAgent },
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(this.ctx.options.timeoutMs ?? 20_000),
      }).catch(() => null);
      const type = res?.headers.get('content-type') ?? '';
      if (!res?.ok || !/^image\/(jpeg|png|webp|gif)/.test(type)) continue;
      return { data: Buffer.from(await res.arrayBuffer()), type };
    }
    return null;
  }

  /** Mark as read up to message `msg`. */
  async markRead(msg: ConversationRef & { index: string }): Promise<void> {
    await this.ctx.im(
      '/v3/conversation/mark_read',
      Cmd.MarkRead,
      new Writer()
        .bytes(1, msg.conversationId)
        .int(2, BigInt(msg.conversationShortId))
        .int(3, ConversationType.OneToOne)
        .int(4, BigInt(msg.index))
        .int(11, 4)
        .finish(),
      MARK_READ_BODY_FIELD,
    );
  }

  // ─── Send ─────────────────────────────────────────────────────────────────

  /** Send a text message to a conversation (usually the just-received `msg` — it carries the conversation ids). */
  async sendMessage(conv: ConversationRef, text: string): Promise<SendResult> {
    const cid = randomUUID();
    await this.send(conv, cid, MessageType.Text, JSON.stringify({ aweType: 0, text }), null);
    return { clientMessageId: cid };
  }

  /** Send an image: upload to the private (encrypted) store, then send an image message. */
  async sendImage(conv: ConversationRef, image: ImageInput): Promise<SendResult> {
    const up = await this.media.upload(image);
    const cid = randomUUID();
    const w = String(up.width);
    const h = String(up.height);
    const media = new Writer()
      .msg(
        1,
        new Writer()
          .bytes(1, up.uri)
          .msg(5, new Writer().int(1, up.width).int(2, up.height))
          .bytes(6, up.secretKey)
          .int(7, 0),
      )
      .msg(
        3,
        new Writer()
          .msg(1, new Writer().bytes(1, 'You sent a 📷'))
          .msg(2, new Writer().bytes(1, 'sent a 📷'))
          .msg(3, new Writer().bytes(1, '[Photo]')),
      )
      .msg(
        200,
        new Writer().msg(
          1,
          new Writer().bytes(1, up.uri).map(2, {
            image_width: w,
            image_height: h,
            decrypt_key: up.secretKey,
            quote_preview: 'dm_cam_preview_photo',
            sender_preview: 'sender_preview',
          }),
        ),
      );
    const extra = new Writer()
      .msg(13, new Writer().msg(4, media))
      .bytes(14, 'private_image')
      .msg(
        17,
        new Writer()
          .int(1, 1)
          .bytes(2, up.uri)
          .bytes(3, up.secretKey)
          .msg(10, new Writer().int(1, up.width).int(2, up.height).int(4, up.size).bytes(5, up.filename)),
      );
    await this.send(conv, cid, MessageType.PrivateImage, '', extra);
    return { clientMessageId: cid };
  }

  /**
   * Set YOUR reaction on a message — like TikTok Web, one reaction per user: a new `emoji` replaces the old one,
   * `null` = remove. Pass the whole `msg` just read (current `reactions` are needed to know which key to remove).
   * Sends `ModifyMessagePropertyRequestBody` (command 705) — see README.
   */
  async setReaction(msg: TikTokMessage, emoji: string | null): Promise<void> {
    const own = this.ctx.ownId;
    const mine = msg.reactions.filter((r) => r.userIds.includes(own)).map((r) => r.emoji);
    const ops: { op: number; key: string }[] = [];
    if (emoji && !mine.includes(emoji)) ops.push({ op: PropertyOp.Add, key: REACTION_PREFIX + emoji });
    for (const e of mine) {
      if (e === emoji) continue;
      ops.push({ op: PropertyOp.Remove, key: REACTION_PREFIX + e });
      // ❤️ sent from the mobile app still uses the legacy key `e:love` — remove it too or the app keeps showing the heart.
      if (e === REACTION_HEART) ops.push({ op: PropertyOp.Remove, key: REACTION_LOVE_KEY });
    }
    if (ops.length === 0) return;
    const target = new Writer()
      .bytes(1, msg.conversationId)
      .int(2, ConversationType.OneToOne)
      .int(3, BigInt(msg.conversationShortId))
      .int(4, BigInt(msg.serverMessageId))
      .bytes(5, msg.clientMessageId);
    for (const o of ops) target.msg(6, new Writer().int(1, o.op).bytes(2, o.key).bytes(4, own));
    const body = await this.ctx.im(
      '/v1/message/set_property',
      Cmd.SetMessageProperty,
      new Writer().msg(1, target).bytes(2, 'deprecated').finish(),
    );
    // status: 0 success, 1 duplicate (also done); anything else means TikTok rejected it.
    const status = body.num(1);
    if (status > 1) throw new TikTokError('IM_ERROR', `set_property: status ${status}`, status);
  }

  /** Download a sticker image (public CDN, unencrypted, no cookie needed). */
  async downloadSticker(sticker: Pick<TikTokSticker, 'url'>): Promise<{ data: Buffer; type: string }> {
    const res = await fetch(sticker.url, {
      headers: { 'User-Agent': this.ctx.userAgent },
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(this.ctx.options.timeoutMs ?? 20_000),
    }).catch(() => null);
    if (!res?.ok) throw new TikTokError('DOWNLOAD_FAILED', `Sticker download failed: ${res?.status ?? 'network'}`);
    return { data: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') ?? 'image/webp' };
  }

  /** Download + decrypt a message's image (pass the whole `msg` — listener messages lack the URL, this looks it up). */
  async downloadImage(source: TikTokMessage | TikTokImage, which: 'origin' | 'thumb' = 'origin'): Promise<Buffer> {
    let image = 'serverMessageId' in source ? source.image : source;
    // Websocket-pushed messages only have uri + key, no download URL → look up history by message id.
    if ('serverMessageId' in source && image && !image.url) {
      const { messages } = await this.getMessages(source, { limit: 5, before: (BigInt(source.index) + 1n).toString() });
      image = messages.find((m) => m.serverMessageId === source.serverMessageId)?.image ?? image;
    }
    if (!image) throw new TikTokError('DOWNLOAD_FAILED', 'Message has no image');
    return this.media.download(image, which);
  }

  /** `SendMessageRequestBody`: {1 convId, 2 conversation type, 3 shortId, 4 content, 5 ext, 6 message type, 7 ticket, 8 client id, …}. */
  private async send(conv: ConversationRef, cid: string, type: number, content: string, extra: Writer | null): Promise<void> {
    if (!conv.conversationId || !conv.conversationShortId) {
      throw new TikTokError('IM_ERROR', 'Missing conversationId / conversationShortId');
    }
    const w = new Writer()
      .bytes(1, conv.conversationId)
      .int(2, ConversationType.OneToOne)
      .int(3, BigInt(conv.conversationShortId))
      .bytes(4, content)
      .map(5, { 's:mentioned_users': '', 's:client_message_id': cid })
      .int(6, type)
      .bytes(7, 'deprecated')
      .bytes(8, cid);
    const body = extra ? Buffer.concat([w.finish(), extra.finish()]) : w.finish();
    await this.ctx.im('/v1/message/send', Cmd.SendMessage, body);
  }
}

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

/**
 * Avatar URLs from the IM profile `avatars` — collects every `https://…` string (thumb → medium → larger, whatever
 * TikTok returns), then puts browser-readable ones (jpeg/webp/png) first and heic last.
 */
function avatarLinks(avatars: unknown): { avatar: string; avatars: string[] } {
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

/** `wid` — device id TikTok issues per `ttwid` cookie; IM + websocket use it as `device_id`. */
export async function fetchWebId(ctx: Context): Promise<string> {
  const res = await ctx.fetch(`${WEB}/api/v1/web-cookie-privacy/config?locale=vi-VN&appId=1988&theme=default&tea=1`);
  if (!res.ok) return '';
  return /"wid":"(\d+)"/.exec(await res.text())?.[1] ?? '';
}

export type { TikTokMessage };
