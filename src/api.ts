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

/** Mốc "mới nhất" khi đọc lịch sử — lớn hơn mọi `index` (µs). */
const NEWEST = 9_999_999_999_999_999n;

/** Kết quả gửi: mã tin phía client (TikTok trả lại đúng mã này). Mã server tới qua listener (`isSelf`). */
export interface SendResult {
  clientMessageId: string;
}

/**
 * Một phiên TikTok đã đăng nhập — tạo bằng `new TikTok().login(credentials)`.
 * Mọi lệnh đi thẳng HTTP/WS tới TikTok bằng cookie, không cần trình duyệt.
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

  /** Cookie hiện tại — lưu lại để lần sau `login` không cần quét QR. */
  getCookies(): { name: string; value: string }[] {
    return [...this.ctx.cookies].map(([name, value]) => ({ name, value }));
  }

  getContext(): { deviceId: string; userAgent: string } {
    return { deviceId: this.ctx.deviceId, userAgent: this.ctx.userAgent };
  }

  /** Phiên còn sống không — gọi định kỳ để phát hiện hết hạn sớm. */
  async isAlive(): Promise<boolean> {
    return (await fetchAccount(this.ctx).catch(() => null)) !== null;
  }

  // ─── Hộp thư ─────────────────────────────────────────────────────────────

  /** Hội thoại gần đây + tin mới nhất của chúng, lật trang bằng `cursor`. */
  async getConversations(cursor = '0'): Promise<ConversationPage> {
    const body = await this.ctx.im('/v2/message/get_by_user_init', Cmd.GetMessagesByUserInit, new Writer().int(1, BigInt(cursor)).finish());
    return {
      messages: body.msgs(1).map((m) => parseMessage(m, this.ctx.ownId)),
      conversations: body.msgs(2).map((m) => parseConversation(m, this.ctx.ownId)),
      // Con trỏ = số hội thoại đã lấy (0, 10, 20…) — trường 4; trường 3 là mốc thời gian, không dùng để lật.
      cursor: body.id(4),
      hasMore: body.num(5) === 1,
    };
  }

  /** Tin của một hội thoại, mới nhất trước. Đọc tiếp tin cũ hơn: `before = <index của tin cũ nhất>`. */
  async getMessages(conv: ConversationRef, opts: { limit?: number; before?: string } = {}): Promise<MessagePage> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    const body = await this.ctx.im(
      '/v1/message/get_by_conversation',
      Cmd.GetMessagesByConversation,
      new Writer()
        .bytes(1, conv.conversationId)
        .int(2, ConversationType.OneToOne)
        .int(3, BigInt(conv.conversationShortId))
        .int(4, 1) // hướng: cũ hơn mốc
        .int(5, opts.before ? BigInt(opts.before) : NEWEST)
        .int(6, limit)
        .finish(),
    );
    const messages = body.msgs(1).map((m) => parseMessage(m, this.ctx.ownId));
    return { messages, hasMore: messages.length >= limit };
  }

  /** Hồ sơ người dùng theo uid (tên hiển thị, @username, ảnh đại diện). */
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
   * Tải ảnh đại diện (thử lần lượt các link, bỏ heic). Không gửi cookie / Referer: CDN ảnh khác miền và
   * link đã có chữ ký. `null` nếu không link nào tải được.
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

  /** Đánh dấu đã đọc tới tin `msg`. */
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

  // ─── Gửi ──────────────────────────────────────────────────────────────────

  /** Gửi tin chữ vào hội thoại (thường là `msg` vừa nhận — nó mang sẵn mã hội thoại). */
  async sendMessage(conv: ConversationRef, text: string): Promise<SendResult> {
    const cid = randomUUID();
    await this.send(conv, cid, MessageType.Text, JSON.stringify({ aweType: 0, text }), null);
    return { clientMessageId: cid };
  }

  /** Gửi một ảnh: tải lên kho riêng tư (được mã hoá) rồi gửi tin ảnh. */
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
   * Đặt reaction CỦA MÌNH trên một tin — như TikTok Web, mỗi người một reaction: `emoji` mới thay cái cũ,
   * `null` = gỡ. Truyền nguyên `msg` vừa đọc (cần `reactions` hiện tại để biết gỡ khoá nào).
   * Gửi `ModifyMessagePropertyRequestBody` (lệnh 705) — xem README.
   */
  async setReaction(msg: TikTokMessage, emoji: string | null): Promise<void> {
    const own = this.ctx.ownId;
    const mine = msg.reactions.filter((r) => r.userIds.includes(own)).map((r) => r.emoji);
    const ops: { op: number; key: string }[] = [];
    if (emoji && !mine.includes(emoji)) ops.push({ op: PropertyOp.Add, key: REACTION_PREFIX + emoji });
    for (const e of mine) {
      if (e === emoji) continue;
      ops.push({ op: PropertyOp.Remove, key: REACTION_PREFIX + e });
      // ❤️ thả từ app điện thoại còn nằm ở khoá cũ `e:love` — gỡ luôn kẻo app vẫn hiện tim.
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
    // status: 0 thành công, 1 gửi trùng (cũng là xong); còn lại TikTok từ chối.
    const status = body.num(1);
    if (status > 1) throw new TikTokError('IM_ERROR', `set_property: status ${status}`, status);
  }

  /** Tải ảnh sticker (CDN công khai, không mã hoá, không cần cookie). */
  async downloadSticker(sticker: Pick<TikTokSticker, 'url'>): Promise<{ data: Buffer; type: string }> {
    const res = await fetch(sticker.url, {
      headers: { 'User-Agent': this.ctx.userAgent },
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(this.ctx.options.timeoutMs ?? 20_000),
    }).catch(() => null);
    if (!res?.ok) throw new TikTokError('DOWNLOAD_FAILED', `Tải sticker lỗi: ${res?.status ?? 'mạng'}`);
    return { data: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') ?? 'image/webp' };
  }

  /** Tải + giải mã ảnh của một tin (truyền cả `msg` — tin từ listener thiếu link, hàm tự tra lại). */
  async downloadImage(source: TikTokMessage | TikTokImage, which: 'origin' | 'thumb' = 'origin'): Promise<Buffer> {
    let image = 'serverMessageId' in source ? source.image : source;
    // Tin đẩy qua websocket chỉ có uri + khoá, không có link tải → tra lại lịch sử theo mã tin.
    if ('serverMessageId' in source && image && !image.url) {
      const { messages } = await this.getMessages(source, { limit: 5, before: (BigInt(source.index) + 1n).toString() });
      image = messages.find((m) => m.serverMessageId === source.serverMessageId)?.image ?? image;
    }
    if (!image) throw new TikTokError('DOWNLOAD_FAILED', 'Tin không có ảnh');
    return this.media.download(image, which);
  }

  /** `SendMessageRequestBody`: {1 convId, 2 loại hội thoại, 3 shortId, 4 nội dung, 5 ext, 6 loại tin, 7 ticket, 8 client id, …}. */
  private async send(conv: ConversationRef, cid: string, type: number, content: string, extra: Writer | null): Promise<void> {
    if (!conv.conversationId || !conv.conversationShortId) {
      throw new TikTokError('IM_ERROR', 'Thiếu conversationId / conversationShortId');
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

/** Tài khoản của cookie — `null` nếu cookie không còn đăng nhập. */
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
 * Link ảnh đại diện trong `avatars` của hồ sơ IM — gom mọi chuỗi `https://…` (cỡ thumb → medium → larger, tuỳ
 * TikTok trả gì), rồi xếp bản trình duyệt đọc được (jpeg/webp/png) lên trước, heic xuống cuối.
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

/** `wid` — mã máy TikTok cấp theo cookie `ttwid`; IM + websocket dùng làm `device_id`. */
export async function fetchWebId(ctx: Context): Promise<string> {
  const res = await ctx.fetch(`${WEB}/api/v1/web-cookie-privacy/config?locale=vi-VN&appId=1988&theme=default&tea=1`);
  if (!res.ok) return '';
  return /"wid":"(\d+)"/.exec(await res.text())?.[1] ?? '';
}

export type { TikTokMessage };
