import { randomUUID } from 'node:crypto';
import { Cmd, MARK_READ_BODY_FIELD, MessageType, WEB } from '../protocol/constants';
import type { Context } from '../protocol/context';
import { Writer } from '../protocol/proto';
import { TikTokError } from '../errors';
import { Listener } from '../listener/listener';
import { parseConversation, parseMessage } from '../models/message';
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
} from '../models/types';
import { avatarLinks, fetchAccount } from './account';
import { MediaClient } from './media';
import {
  getMessagesBody,
  imageMessageExtra,
  markReadBody,
  reactionOps,
  sendMessageBody,
  setPropertyBody,
} from './requests';

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
    const body = await this.ctx.im(
      '/v2/message/get_by_user_init',
      Cmd.GetMessagesByUserInit,
      new Writer().int(1, BigInt(cursor)).finish(),
    );
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
      getMessagesBody(conv, limit, opts.before),
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
    await this.ctx.im('/v3/conversation/mark_read', Cmd.MarkRead, markReadBody(msg), MARK_READ_BODY_FIELD);
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
    await this.send(conv, cid, MessageType.PrivateImage, '', imageMessageExtra(up));
    return { clientMessageId: cid };
  }

  /**
   * Set YOUR reaction on a message — like TikTok Web, one reaction per user: a new `emoji` replaces the old one,
   * `null` = remove. Pass the whole `msg` just read (current `reactions` are needed to know which key to remove).
   * Sends `ModifyMessagePropertyRequestBody` (command 705) — see README.
   */
  async setReaction(msg: TikTokMessage, emoji: string | null): Promise<void> {
    const own = this.ctx.ownId;
    const ops = reactionOps(msg, own, emoji);
    if (ops.length === 0) return;
    const body = await this.ctx.im('/v1/message/set_property', Cmd.SetMessageProperty, setPropertyBody(msg, ops, own));
    // status: 0 success, 1 duplicate (also done); anything else means TikTok rejected it.
    const status = body.num(1);
    if (status > 1) throw new TikTokError('IM_ERROR', `set_property: status ${status}`, status);
  }

  // ─── Media ─────────────────────────────────────────────────────────────────

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

  private async send(
    conv: ConversationRef,
    cid: string,
    type: number,
    content: string,
    extra: Writer | null,
  ): Promise<void> {
    if (!conv.conversationId || !conv.conversationShortId) {
      throw new TikTokError('IM_ERROR', 'Missing conversationId / conversationShortId');
    }
    await this.ctx.im('/v1/message/send', Cmd.SendMessage, sendMessageBody(conv, cid, type, content, extra));
  }
}
