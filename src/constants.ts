/**
 * TikTok Web IM protocol constants — reconstructed from `tiktok.com/business-suite/messages` traffic
 * (09/11/2026). If TikTok changes things on their side, fix them here; how they were found is in the README.
 */

export const IM_API = 'https://im-api-sg.tiktok.com';
export const IM_WS = 'wss://im-ws-sg.tiktok.com/ws/v2';
export const WEB = 'https://www.tiktok.com';

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

/** TikTok Web app id (HTTP IM). */
export const AID_WEB = '1988';
/** "frontier" channel app id — websocket pushing new messages. */
export const AID_FRONTIER = '1459';
export const SDK_VERSION = '1.8.5';
export const BUILD_NUMBER = 'feffaa1:master';

/** Websocket `access_key` = md5(FPID + APP_KEY + device_id + SALT). */
export const FRONTIER_FPID = '9';
export const FRONTIER_APP_KEY = 'e1bd35ec9db7b8d846de66ed140b1ad9';
export const FRONTIER_SALT = 'f8a69f1719916z';

/** IM command (`Request.cmd`) — also the body's field number in `RequestBody`. */
export const Cmd = {
  SendMessage: 100,
  GetMessagesByUserInit: 203,
  GetMessagesByConversation: 301,
  /** Websocket push of new messages. */
  NewMessage: 500,
  /** Add / remove a reaction (message `property`) — `/v1/message/set_property`. */
  SetMessageProperty: 705,
  GetConversationInfo: 610,
  MarkRead: 2002,
  UploadConfig: 2059,
} as const;

/** MarkRead's body lives in field 604, not the command number. */
export const MARK_READ_BODY_FIELD = 604;

/** `MessageBody.message_type`. */
export const MessageType = {
  System: 1,
  Text: 7,
  ShareVideo: 8,
  PrivateImage: 1802,
  /** Sticker — public image on the sticker CDN, not encrypted. */
  Sticker: 1805,
  /** Hidden command (read receipt…) — not shown in the conversation, but still pushed over websocket. */
  Command: 50001,
} as const;

export const ConversationType = { OneToOne: 1 } as const;

/** `Response` fields (both HTTP and websocket payload). */
export const Resp = { cmd: 1, seq: 2, status: 3, error: 4, body: 6, logId: 7 } as const;

/** `MessageBody` fields. */
export const MsgF = {
  conversationId: 1,
  conversationType: 2,
  serverMessageId: 3,
  indexInConversation: 4,
  conversationShortId: 5,
  type: 6,
  sender: 7,
  content: 8,
  ext: 9,
  createTime: 10,
  /** `property_list` — reaction: `{1 key "e:<emoji>", 2 {1 PropertyItem[]}}`. */
  propertyList: 15,
  attachments: 20,
  tag: 21,
} as const;

/** Operation on a message `property` (`ModifyPropertyContent.operation`). */
export const PropertyOp = { Add: 0, Remove: 1 } as const;

/** Reaction key = `e:<emoji>`. The mobile app reacting ❤️ also writes the legacy key `e:love` — treated as ❤️. */
export const REACTION_PREFIX = 'e:';
export const REACTION_LOVE_KEY = 'e:love';
export const REACTION_HEART = '\u2764\uFE0F';

/** ImageX — image upload endpoint (AWS SigV4-style signing). */
export const IMAGEX_REGION = 'cn-north-1';
export const IMAGEX_SERVICE = 'imagex';
export const IMAGEX_VERSION = '2018-08-01';
