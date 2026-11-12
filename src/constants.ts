/**
 * Hằng giao thức IM của TikTok Web — dựng lại từ lưu lượng `tiktok.com/business-suite/messages`
 * (09/11/2026). TikTok đổi phía họ thì sửa ở đây; ghi lại cách dò ra ở README.
 */

export const IM_API = 'https://im-api-sg.tiktok.com';
export const IM_WS = 'wss://im-ws-sg.tiktok.com/ws/v2';
export const WEB = 'https://www.tiktok.com';

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

/** App id của TikTok Web (HTTP IM). */
export const AID_WEB = '1988';
/** App id kênh "frontier" — websocket đẩy tin mới. */
export const AID_FRONTIER = '1459';
export const SDK_VERSION = '1.8.5';
export const BUILD_NUMBER = 'feffaa1:master';

/** `access_key` của websocket = md5(FPID + APP_KEY + device_id + SALT). */
export const FRONTIER_FPID = '9';
export const FRONTIER_APP_KEY = 'e1bd35ec9db7b8d846de66ed140b1ad9';
export const FRONTIER_SALT = 'f8a69f1719916z';

/** Lệnh IM (`Request.cmd`) — đồng thời là số trường của body trong `RequestBody`. */
export const Cmd = {
  SendMessage: 100,
  GetMessagesByUserInit: 203,
  GetMessagesByConversation: 301,
  /** Websocket đẩy tin mới. */
  NewMessage: 500,
  /** Thả / gỡ reaction (`property` của tin) — `/v1/message/set_property`. */
  SetMessageProperty: 705,
  GetConversationInfo: 610,
  MarkRead: 2002,
  UploadConfig: 2059,
} as const;

/** Body của MarkRead nằm ở trường 604, không trùng số lệnh. */
export const MARK_READ_BODY_FIELD = 604;

/** `MessageBody.message_type`. */
export const MessageType = {
  System: 1,
  Text: 7,
  ShareVideo: 8,
  PrivateImage: 1802,
  /** Sticker (nhãn dán) — ảnh công khai trên CDN sticker, không mã hoá. */
  Sticker: 1805,
  /** Lệnh ẩn (đã đọc…) — không hiện trong hội thoại, websocket vẫn đẩy. */
  Command: 50001,
} as const;

export const ConversationType = { OneToOne: 1 } as const;

/** Trường của `Response` (cả HTTP lẫn payload websocket). */
export const Resp = { cmd: 1, seq: 2, status: 3, error: 4, body: 6, logId: 7 } as const;

/** Trường của `MessageBody`. */
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
  /** `property_list` — reaction: `{1 khoá "e:<emoji>", 2 {1 PropertyItem[]}}`. */
  propertyList: 15,
  attachments: 20,
  tag: 21,
} as const;

/** Thao tác trên `property` của tin (`ModifyPropertyContent.operation`). */
export const PropertyOp = { Add: 0, Remove: 1 } as const;

/** Khoá reaction = `e:<emoji>`. App điện thoại thả ❤️ còn ghi thêm khoá cũ `e:love` — coi như ❤️. */
export const REACTION_PREFIX = 'e:';
export const REACTION_LOVE_KEY = 'e:love';
export const REACTION_HEART = '\u2764\uFE0F';

/** ImageX — nơi tải ảnh lên (ký kiểu AWS SigV4). */
export const IMAGEX_REGION = 'cn-north-1';
export const IMAGEX_SERVICE = 'imagex';
export const IMAGEX_VERSION = '2018-08-01';
