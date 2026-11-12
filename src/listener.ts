import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { AID_FRONTIER, Cmd, FRONTIER_APP_KEY, FRONTIER_FPID, FRONTIER_SALT, IM_WS, Resp, WEB } from './constants';
import type { Context } from './context';
import { lz4Decompress } from './lz4';
import { parseMessage } from './message';
import { Msg, Writer } from './proto';
import type { TikTokMessage } from './types';

/** Trình duyệt gửi "hi" mỗi 15–30 giây; lấy cận dưới. */
const HEARTBEAT_MS = 15_000;
/** Không nhận gì (kể cả "hi" đáp lại) quá chừng này thì coi như chết ngầm, nối lại. */
const IDLE_TIMEOUT_MS = 75_000;
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
/** Server đẩy cùng một tin vài lần (mỗi thiết bị một khung) — nhớ chừng này mã tin để lọc trùng. */
const DEDUPE_KEEP = 500;

/** Mã đóng do chính mình gọi `stop()`. */
export const MANUAL_CLOSE = 4000;

export interface ListenerEvents {
  connected: [];
  /** Tin thật trong hội thoại (cả tin của chính mình — xem `isSelf`). */
  message: [TikTokMessage];
  /** Lệnh ẩn: đánh dấu đã đọc… (`content.command_type`). */
  command: [TikTokMessage];
  /** Mã + lý do đóng. Không phải `MANUAL_CLOSE` thì listener tự nối lại (nếu bật). */
  closed: [number, string];
  error: [Error];
}

/** Khung websocket "frontier": {1 seqid, 2 logid, 3 service, 4 method, 5 headers, 6 encoding, 7 type, 8 payload}. */
interface Frame {
  seq: bigint;
  logId: bigint;
  headers: Record<string, string>;
  encoding: string;
  payload: Buffer;
}

/**
 * Nghe tin mới qua websocket `im-ws-sg` (aid 1459) — chỉ cần cookie, như listener của zca-js.
 * Sự kiện: `connected`, `message`, `closed`, `error`.
 */
export class Listener extends EventEmitter<ListenerEvents> {
  private ws: WebSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private idle: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoff = RECONNECT_MIN_MS;
  private retry = true;
  private readonly seen = new Set<string>();

  constructor(private readonly ctx: Context) {
    super();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  url(): string {
    const accessKey = createHash('md5')
      .update(FRONTIER_FPID + FRONTIER_APP_KEY + this.ctx.deviceId + FRONTIER_SALT)
      .digest('hex');
    const q = new URLSearchParams({
      aid: AID_FRONTIER,
      fpid: FRONTIER_FPID,
      device_platform: 'web',
      version_code: 'fws_1.0.0',
      access_key: accessKey,
      device_id: this.ctx.deviceId,
      // Giá trị cookie đã URL-encode sẵn (`1%7C…`) — giải ra để URLSearchParams không mã hoá hai lần.
      ttwid: decodeURIComponent(this.ctx.cookies.get('ttwid') ?? ''),
      xsack: '1',
      xaack: '1',
      xsqos: '0',
    });
    return `${IM_WS}?${q}`;
  }

  /** Mở kết nối. `retryOnClose` (mặc định bật): rớt mạng thì tự nối lại, giãn dần tới 1 phút. */
  start(opts: { retryOnClose?: boolean } = {}): void {
    this.retry = opts.retryOnClose ?? true;
    this.connect();
  }

  stop(): void {
    this.retry = false;
    this.clearTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(MANUAL_CLOSE, 'manual');
  }

  private connect(): void {
    const ws = new WebSocket(this.url(), {
      headers: { Cookie: this.ctx.cookieHeader(), 'User-Agent': this.ctx.userAgent, Origin: WEB },
    });
    this.ws = ws;
    ws.binaryType = 'nodebuffer';
    ws.on('open', () => {
      this.backoff = RECONNECT_MIN_MS;
      this.heartbeat = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('hi'), HEARTBEAT_MS);
      this.touch();
      this.ctx.log('debug', 'tca: websocket đã nối');
      this.emit('connected');
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      this.touch();
      if (!isBinary) return; // "hi" đáp lại
      try {
        this.onFrame(ws, data);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    });
    ws.on('error', (err) => this.emit('error', err));
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return; // kết nối cũ đã bị thay
      this.ws = null;
      this.clearTimers();
      this.emit('closed', code, reason.toString());
      if (!this.retry || code === MANUAL_CLOSE) return;
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
      this.ctx.log('warn', `tca: websocket đóng (${code}) — nối lại sau ${wait / 1000}s`);
      this.reconnectTimer = setTimeout(() => this.connect(), wait);
    });
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.ctx.log('warn', 'tca: websocket im lặng quá lâu — nối lại');
      this.ws?.terminate();
    }, IDLE_TIMEOUT_MS);
  }

  private clearTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.idle) clearTimeout(this.idle);
    this.heartbeat = null;
    this.idle = null;
  }

  private onFrame(ws: WebSocket, data: Buffer): void {
    const m = Msg.parse(data);
    const frame: Frame = {
      seq: m.int(1),
      logId: m.int(2),
      headers: m.map(5),
      encoding: m.str(6),
      payload: m.bytes(8),
    };
    if (frame.headers.need_ack === '1') this.ack(ws, frame);
    if (frame.payload.length === 0) return;
    const payload = frame.encoding === '__lz4' ? lz4Decompress(frame.payload) : frame.payload;
    const resp = Msg.tryParse(payload);
    if (!resp || resp.num(Resp.cmd) !== Cmd.NewMessage) return;
    // NewMessageNotify: {2 conversationId, 3 loại, 4 ?, 5 MessageBody}
    const body = resp.msg(Resp.body)?.msg(Cmd.NewMessage)?.msg(5);
    if (!body) return;
    const msg = parseMessage(body, this.ctx.ownId);
    if (!msg.serverMessageId || this.seen.has(msg.serverMessageId)) return;
    this.seen.add(msg.serverMessageId);
    if (this.seen.size > DEDUPE_KEEP) this.seen.delete(this.seen.values().next().value as string);
    if (msg.kind === 'command') this.emit('command', msg);
    else this.emit('message', msg);
  }

  /** Báo đã nhận — `ack_id = <giờ base36>:<x_frontier_traceid>`, kèm lại seq/logid của khung. */
  private ack(ws: WebSocket, f: Frame): void {
    const ackId = `${Date.now().toString(36)}:${f.headers.x_frontier_traceid ?? ''}`;
    const out = new Writer()
      .int(1, f.seq)
      .int(2, f.logId)
      .int(3, 5)
      .int(4, 1)
      .map(5, { is_ack: '1', ack_id: ackId, ack_code: '0' })
      .bytes(9, ackId)
      .finish();
    if (ws.readyState === WebSocket.OPEN) ws.send(out);
  }
}
