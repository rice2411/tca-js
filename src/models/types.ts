/** A cookie — same shape as `chrome.cookies.getAll` / CDP `Storage.getCookies` returns (extra fields are fine). */
export interface CookieInput {
  name: string;
  value: string;
}

/** What you need to log in again — save it after each login. */
export interface Credentials {
  /** `.tiktok.com` cookies: array of `{name, value}`, object `{name: value}`, or string `a=b; c=d`. */
  cookies: CookieInput[] | Record<string, string> | string;
  /** IM device id (`wid`) — leave empty and `login` asks TikTok using `ttwid`. Only used when that fails. */
  deviceId?: string;
  userAgent?: string;
}

export interface TikTokOptions {
  /** Debug logging — silent by default. */
  logger?: (level: 'debug' | 'warn', msg: string) => void;
  /** Timeout per HTTP request (ms). */
  timeoutMs?: number;
}

/** Enough to target a conversation: send, read, mark as read. Every `TikTokMessage` satisfies it. */
export interface ConversationRef {
  conversationId: string;
  conversationShortId: string;
}

export interface TikTokImage {
  /** Image id in TikTok storage (encrypted). */
  uri: string;
  /** Original download link — needs cookies, content is AES-256-GCM. */
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
  /** AES-256-GCM key (hex) to decrypt `url` — `api.downloadImage` handles this. */
  decryptKey: string;
}

/** Sticker — including user-made stickers (`stickerType` 15). Public CDN link, signed + expires in a few days. */
export interface TikTokSticker {
  stickerId: string;
  /** 14 = built-in TikTok sticker, 15 = user-made sticker (memes, AI…). */
  stickerType: number;
  url: string;
  width: number;
  height: number;
}

/** A reaction on a message: emoji + users who reacted (uid). The mobile app's `e:love` is merged into ❤️. */
export interface TikTokReaction {
  emoji: string;
  userIds: string[];
}

export interface TikTokMessage extends ConversationRef {
  serverMessageId: string;
  /** Position in the conversation (µs) — cursor for paging older messages. */
  index: string;
  /** `MessageType` — 7 text, 1802 image, 1805 sticker, 8 video share, 1 system. */
  type: number;
  /** `command` = hidden command (read receipt…) — listener emits it via the `command` event, not `message`. */
  kind: 'text' | 'image' | 'sticker' | 'video' | 'system' | 'command' | 'other';
  senderId: string;
  isSelf: boolean;
  /** Text content (`kind = text`), empty for other kinds. */
  text: string;
  image: TikTokImage | null;
  sticker: TikTokSticker | null;
  reactions: TikTokReaction[];
  /** Raw JSON content (`{"aweType":0,"text":"…"}`…). */
  content: unknown;
  /** Send time, ms epoch. */
  createdAt: number;
  clientMessageId: string;
  ext: Record<string, string>;
}

export interface TikTokConversation extends ConversationRef {
  participants: string[];
  /** The other participant in a 1-1 conversation. */
  peerId: string;
}

export interface TikTokUser {
  uid: string;
  /** `@username` (without @). */
  uniqueId: string;
  nickname: string;
  /** Best avatar (prefers jpeg/webp/png, avoids heic which browsers can't read). */
  avatar: string;
  /** All avatar links TikTok returns, by priority — signed, expiring links; `downloadAvatar` tries them in order. */
  avatars: string[];
}

export interface TikTokAccount {
  uid: string;
  username: string;
  screenName: string;
  avatar: string;
}

/** Image attachment. */
export interface ImageInput {
  data: Buffer;
  /** Only the extension matters so TikTok knows the format: `photo.jpg`, `bill.png`. */
  filename: string;
}

export interface MessagePage {
  messages: TikTokMessage[];
  hasMore: boolean;
}

export interface ConversationPage {
  conversations: TikTokConversation[];
  /** Latest messages included — handy for building an inbox list. */
  messages: TikTokMessage[];
  cursor: string;
  hasMore: boolean;
}
