/** Lỗi từ TikTok hoặc từ chính thư viện. `code` để bên dùng phân nhánh (vd phiên hết hạn → quét lại). */
export class TikTokError extends Error {
  constructor(
    readonly code: TikTokErrorCode,
    message: string,
    /** Mã gốc TikTok trả (status_code / error_code) nếu có. */
    readonly upstream?: number | string,
  ) {
    super(message);
    this.name = 'TikTokError';
  }
}

export type TikTokErrorCode =
  /** Cookie không còn đăng nhập — phải lấy phiên mới. */
  | 'SESSION_EXPIRED'
  | 'HTTP_ERROR'
  /** IM trả `status_code` khác 0. */
  | 'IM_ERROR'
  | 'UPLOAD_FAILED'
  | 'DOWNLOAD_FAILED'
  | 'BAD_RESPONSE'
  /** Đăng nhập QR không thành (Chrome không mở được, QR hết hạn, không thấy cookie…). */
  | 'LOGIN_FAILED'
  /** Bên gọi huỷ đăng nhập QR (`signal`). */
  | 'LOGIN_ABORTED';
