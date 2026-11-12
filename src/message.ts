import { MessageType, MsgF, REACTION_HEART, REACTION_LOVE_KEY, REACTION_PREFIX } from './constants';
import { Msg } from './proto';
import type { TikTokConversation, TikTokImage, TikTokMessage, TikTokReaction, TikTokSticker } from './types';

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Ảnh trong `attachments` (trường 20 → 4): 1 = bản gốc, 2 = ảnh nhỏ; mỗi cái {1 uri, 2 url…, 5 {w,h}, 6 khoá}. */
function parseImage(m: Msg): TikTokImage | null {
  const media = m.msg(MsgF.attachments)?.msg(4);
  const origin = media?.msg(1);
  if (!media || !origin) return null;
  const size = origin.msg(5);
  return {
    uri: origin.str(1),
    url: origin.strs(2)[0] ?? '',
    thumbUrl: media.msg(2)?.strs(2)[0] ?? '',
    width: size?.num(1) ?? 0,
    height: size?.num(2) ?? 0,
    decryptKey: origin.str(6),
  };
}

/**
 * Sticker (trường 20 → 7): `{1 {1 uri, 2 url, 5 {w,h}}, 2 lời nhắc, 200 {1 {2 map a:sticker_id, a:sticker_type…}}}`.
 * Link trỏ CDN sticker công khai (`…-dm-sticker-sign-…`) — không mã hoá, không cần cookie.
 */
function parseSticker(m: Msg): TikTokSticker | null {
  const st = m.msg(MsgF.attachments)?.msg(7);
  const img = st?.msg(1);
  if (!st || !img) return null;
  const size = img.msg(5);
  const ext = st.msg(200)?.msg(1)?.map(2) ?? {};
  return {
    stickerId: ext['a:sticker_id'] ?? '',
    stickerType: Number(ext['a:sticker_type'] ?? 0),
    url: img.str(2),
    width: size?.num(1) ?? 0,
    height: size?.num(2) ?? 0,
  };
}

/**
 * Reaction (trường 15, `property_list`): mỗi phần tử `{1 khoá, 2 {1 PropertyItem[]}}`, khoá `e:<emoji>`,
 * `PropertyItem {1 uid, 3 giây, 4 idempotent_id, 6 µs}`. App điện thoại thả ❤️ ghi cả `e:❤️` lẫn `e:love` → gộp.
 */
function parseReactions(m: Msg): TikTokReaction[] {
  const byEmoji = new Map<string, Set<string>>();
  for (const p of m.msgs(MsgF.propertyList)) {
    const key = p.str(1);
    if (!key.startsWith(REACTION_PREFIX)) continue;
    const emoji = key === REACTION_LOVE_KEY ? REACTION_HEART : key.slice(REACTION_PREFIX.length);
    const uids = byEmoji.get(emoji) ?? new Set<string>();
    for (const item of p.msg(2)?.msgs(1) ?? []) uids.add(item.id(1));
    if (uids.size) byEmoji.set(emoji, uids);
  }
  return [...byEmoji].map(([emoji, uids]) => ({ emoji, userIds: [...uids] }));
}

const KIND: Record<number, TikTokMessage['kind']> = {
  [MessageType.Text]: 'text',
  [MessageType.PrivateImage]: 'image',
  [MessageType.Sticker]: 'sticker',
  [MessageType.ShareVideo]: 'video',
  [MessageType.System]: 'system',
  [MessageType.Command]: 'command',
};

/** `MessageBody` → `TikTokMessage`. */
export function parseMessage(m: Msg, ownId: string): TikTokMessage {
  const type = m.num(MsgF.type);
  const content = parseJson(m.str(MsgF.content));
  const ext = m.map(MsgF.ext);
  const senderId = m.id(MsgF.sender);
  const text =
    type === MessageType.Text && content && typeof content === 'object' && 'text' in content
      ? String((content as { text: unknown }).text ?? '')
      : '';
  return {
    conversationId: m.str(MsgF.conversationId),
    conversationShortId: m.id(MsgF.conversationShortId),
    serverMessageId: m.id(MsgF.serverMessageId),
    index: m.id(MsgF.indexInConversation),
    type,
    kind: KIND[type] ?? 'other',
    senderId,
    isSelf: senderId === ownId,
    text,
    image: type === MessageType.PrivateImage ? parseImage(m) : null,
    sticker: type === MessageType.Sticker ? parseSticker(m) : null,
    reactions: parseReactions(m),
    content,
    createdAt: m.num(MsgF.createTime),
    clientMessageId: ext['s:client_message_id'] ?? '',
    ext,
  };
}

/** `ConversationInfo` (trường 2 của get_by_user_init): {1 id, 2 shortId, 3 loại, 6 {1 {1 uid}}…}. */
export function parseConversation(m: Msg, ownId: string): TikTokConversation {
  const participants = (m.msg(6)?.msgs(1) ?? []).map((p) => p.id(1));
  return {
    conversationId: m.str(1),
    conversationShortId: m.id(2),
    participants,
    peerId: participants.find((p) => p !== ownId) ?? '',
  };
}
