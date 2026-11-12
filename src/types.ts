/** Một cookie — đúng dạng `chrome.cookies.getAll` / CDP `Storage.getCookies` trả về (thừa trường không sao). */
export interface CookieInput {
  name: string;
  value: string;
}

/** Thứ cần để đăng nhập lại — lưu lại sau mỗi lần đăng nhập, như `{cookie, imei, userAgent}` của zca-js. */
export interface Credentials {
  /** Cookie của `.tiktok.com`: mảng `{name, value}`, object `{name: value}`, hoặc chuỗi `a=b; c=d`. */
  cookies: CookieInput[] | Record<string, string> | string;
  /** Mã máy IM (`wid`) — bỏ trống thì `login` hỏi TikTok theo `ttwid`. Chỉ dùng khi không hỏi được. */
  deviceId?: string;
  userAgent?: string;
}

export interface TikTokOptions {
  /** Ghi log gỡ lỗi — mặc định im lặng. */
  logger?: (level: 'debug' | 'warn', msg: string) => void;
  /** Hạn chờ mỗi request HTTP (ms). */
  timeoutMs?: number;
}

/** Đủ để nhắm một hội thoại: gửi tin, đọc tin, đánh dấu đã đọc. Mọi `TikTokMessage` đều thoả. */
export interface ConversationRef {
  conversationId: string;
  conversationShortId: string;
}

export interface TikTokImage {
  /** Mã ảnh trên kho TikTok (đã mã hoá). */
  uri: string;
  /** Link tải bản gốc — cần cookie, nội dung là AES-256-GCM. */
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
  /** Khoá AES-256-GCM (hex) để giải `url` — `api.downloadImage` lo việc này. */
  decryptKey: string;
}

/** Sticker (nhãn dán) — kể cả sticker khách tự tạo (`stickerType` 15). Link CDN công khai, có chữ ký + hạn vài ngày. */
export interface TikTokSticker {
  stickerId: string;
  /** 14 = sticker có sẵn của TikTok, 15 = sticker người dùng tự tạo (ảnh chế, AI…). */
  stickerType: number;
  url: string;
  width: number;
  height: number;
}

/** Một reaction trên tin: emoji + những người đã thả (uid). `e:love` của app điện thoại đã gộp vào ❤️. */
export interface TikTokReaction {
  emoji: string;
  userIds: string[];
}

export interface TikTokMessage extends ConversationRef {
  serverMessageId: string;
  /** Vị trí trong hội thoại (µs) — làm mốc đọc tiếp tin cũ hơn. */
  index: string;
  /** `MessageType` — 7 chữ, 1802 ảnh, 1805 sticker, 8 chia sẻ video, 1 hệ thống. */
  type: number;
  /** `command` = lệnh ẩn (đã đọc…) — listener phát qua sự kiện `command`, không qua `message`. */
  kind: 'text' | 'image' | 'sticker' | 'video' | 'system' | 'command' | 'other';
  senderId: string;
  isSelf: boolean;
  /** Nội dung chữ (`kind = text`), rỗng với loại khác. */
  text: string;
  image: TikTokImage | null;
  sticker: TikTokSticker | null;
  reactions: TikTokReaction[];
  /** JSON thô của nội dung (`{"aweType":0,"text":"…"}`…). */
  content: unknown;
  /** Giờ gửi, ms epoch. */
  createdAt: number;
  clientMessageId: string;
  ext: Record<string, string>;
}

export interface TikTokConversation extends ConversationRef {
  participants: string[];
  /** Người còn lại trong hội thoại 1-1. */
  peerId: string;
}

export interface TikTokUser {
  uid: string;
  /** `@username` (không có @). */
  uniqueId: string;
  nickname: string;
  /** Ảnh đại diện tốt nhất (ưu tiên jpeg/webp/png, tránh heic trình duyệt không đọc). */
  avatar: string;
  /** Mọi link ảnh đại diện TikTok trả, xếp theo ưu tiên — link có chữ ký, có hạn; `downloadAvatar` thử lần lượt. */
  avatars: string[];
}

export interface TikTokAccount {
  uid: string;
  username: string;
  screenName: string;
  avatar: string;
}

/** File đính kèm — giống `attachments` của zca-js. */
export interface ImageInput {
  data: Buffer;
  /** Chỉ cần đuôi để TikTok biết định dạng: `anh.jpg`, `bill.png`. */
  filename: string;
}

export interface MessagePage {
  messages: TikTokMessage[];
  hasMore: boolean;
}

export interface ConversationPage {
  conversations: TikTokConversation[];
  /** Tin mới nhất kèm theo — tiện dựng danh sách hộp thư. */
  messages: TikTokMessage[];
  cursor: string;
  hasMore: boolean;
}
