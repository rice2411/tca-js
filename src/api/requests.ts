/**
 * Pure builders for IM request bodies (protobuf) — no I/O, so they can be unit-tested byte for byte.
 */
import {
  ConversationType,
  PropertyOp,
  REACTION_HEART,
  REACTION_LOVE_KEY,
  REACTION_PREFIX,
} from '../protocol/constants';
import { Writer } from '../protocol/proto';
import type { ConversationRef, TikTokMessage } from '../models/types';
import type { UploadedImage } from './media';

/** "Latest" cursor for reading history — greater than any `index` (µs). */
export const NEWEST = 9_999_999_999_999_999n;

/** `GetMessagesByConversationRequestBody` — messages older than `before` (or the newest ones). */
export function getMessagesBody(conv: ConversationRef, limit: number, before?: string): Buffer {
  return new Writer()
    .bytes(1, conv.conversationId)
    .int(2, ConversationType.OneToOne)
    .int(3, BigInt(conv.conversationShortId))
    .int(4, 1) // direction: older than cursor
    .int(5, before ? BigInt(before) : NEWEST)
    .int(6, limit)
    .finish();
}

/** `MarkConversationReadRequestBody` — read up to message `index`. */
export function markReadBody(msg: ConversationRef & { index: string }): Buffer {
  return new Writer()
    .bytes(1, msg.conversationId)
    .int(2, BigInt(msg.conversationShortId))
    .int(3, ConversationType.OneToOne)
    .int(4, BigInt(msg.index))
    .int(11, 4)
    .finish();
}

/**
 * `SendMessageRequestBody`: {1 convId, 2 conversation type, 3 shortId, 4 content, 5 ext, 6 message type, 7 ticket,
 * 8 client id, …}. `extra` is appended verbatim (image attachments).
 */
export function sendMessageBody(
  conv: ConversationRef,
  cid: string,
  type: number,
  content: string,
  extra: Writer | null,
): Buffer {
  const w = new Writer()
    .bytes(1, conv.conversationId)
    .int(2, ConversationType.OneToOne)
    .int(3, BigInt(conv.conversationShortId))
    .bytes(4, content)
    .map(5, { 's:mentioned_users': '', 's:client_message_id': cid })
    .int(6, type)
    .bytes(7, 'deprecated')
    .bytes(8, cid);
  return extra ? Buffer.concat([w.finish(), extra.finish()]) : w.finish();
}

/** Extra `SendMessageRequestBody` fields (13, 14, 17) describing an uploaded private image. */
export function imageMessageExtra(up: UploadedImage): Writer {
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
  return new Writer()
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
}

export interface PropertyChange {
  op: number;
  key: string;
}

/**
 * Property operations that make `own`'s reaction on `msg` equal `emoji` (one reaction per user; `null` = remove).
 * Empty when nothing needs to change.
 */
export function reactionOps(
  msg: Pick<TikTokMessage, 'reactions'>,
  own: string,
  emoji: string | null,
): PropertyChange[] {
  const mine = msg.reactions.filter((r) => r.userIds.includes(own)).map((r) => r.emoji);
  const ops: PropertyChange[] = [];
  if (emoji && !mine.includes(emoji)) ops.push({ op: PropertyOp.Add, key: REACTION_PREFIX + emoji });
  for (const e of mine) {
    if (e === emoji) continue;
    ops.push({ op: PropertyOp.Remove, key: REACTION_PREFIX + e });
    // ❤️ sent from the mobile app still uses the legacy key `e:love` — remove it too or the app keeps showing the heart.
    if (e === REACTION_HEART) ops.push({ op: PropertyOp.Remove, key: REACTION_LOVE_KEY });
  }
  return ops;
}

/** `ModifyMessagePropertyRequestBody` (command 705) applying `ops` to `msg` as user `own`. */
export function setPropertyBody(msg: TikTokMessage, ops: PropertyChange[], own: string): Buffer {
  const target = new Writer()
    .bytes(1, msg.conversationId)
    .int(2, ConversationType.OneToOne)
    .int(3, BigInt(msg.conversationShortId))
    .int(4, BigInt(msg.serverMessageId))
    .bytes(5, msg.clientMessageId);
  for (const o of ops) target.msg(6, new Writer().int(1, o.op).bytes(2, o.key).bytes(4, own));
  return new Writer().msg(1, target).bytes(2, 'deprecated').finish();
}
