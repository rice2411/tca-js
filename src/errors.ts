/** Error from TikTok or from the library itself. `code` lets callers branch (e.g. session expired → rescan). */
export class TikTokError extends Error {
  constructor(
    readonly code: TikTokErrorCode,
    message: string,
    /** Original TikTok code (status_code / error_code), if any. */
    readonly upstream?: number | string,
  ) {
    super(message);
    this.name = 'TikTokError';
  }
}

export type TikTokErrorCode =
  /** Cookie is no longer logged in — a new session is required. */
  | 'SESSION_EXPIRED'
  /**
   * TikTok's gateway rejects this session for the command (JSON `status_code: 7` instead of protobuf). Seen on
   * `message/send` while reads keep working — log in again to get a fresh session.
   */
  | 'SESSION_BLOCKED'
  | 'HTTP_ERROR'
  /** IM returned a non-zero `status_code`. */
  | 'IM_ERROR'
  | 'UPLOAD_FAILED'
  | 'DOWNLOAD_FAILED'
  | 'BAD_RESPONSE'
  /** QR login failed (Chrome failed to launch, QR expired, no cookie found…). */
  | 'LOGIN_FAILED'
  /** Caller aborted QR login (`signal`). */
  | 'LOGIN_ABORTED';
