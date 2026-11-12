import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { AID_FRONTIER, FRONTIER_FPID, IM_WS, WEB } from '../protocol/constants';
import type { Context } from '../protocol/context';
import { parseMessage } from '../models/message';
import type { TikTokMessage } from '../models/types';
import { accessKey, buildAck, newMessageBody, parseFrame } from './frame';

/** The browser sends "hi" every 15–30 seconds; use the lower bound. */
const HEARTBEAT_MS = 15_000;
/** If nothing (not even a "hi" reply) arrives for this long, treat it as silently dead and reconnect. */
const IDLE_TIMEOUT_MS = 75_000;
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
/** The server pushes the same message several times (one frame per device) — remember this many message IDs to dedupe. */
const DEDUPE_KEEP = 500;

/** Close code used when we call `stop()` ourselves. */
export const MANUAL_CLOSE = 4000;

export interface ListenerEvents {
  connected: [];
  /** A real message in a conversation (including our own — see `isSelf`). */
  message: [TikTokMessage];
  /** Hidden command: mark as read… (`content.command_type`). */
  command: [TikTokMessage];
  /** Close code + reason. Unless `MANUAL_CLOSE`, the listener reconnects automatically (if enabled). */
  closed: [number, string];
  error: [Error];
}

/**
 * Listen for new messages via the `im-ws-sg` websocket (aid 1459) — cookies only.
 * Events: `connected`, `message`, `closed`, `error`.
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
    const q = new URLSearchParams({
      aid: AID_FRONTIER,
      fpid: FRONTIER_FPID,
      device_platform: 'web',
      version_code: 'fws_1.0.0',
      access_key: accessKey(this.ctx.deviceId),
      device_id: this.ctx.deviceId,
      // Cookie value is already URL-encoded (`1%7C…`) — decode it so URLSearchParams doesn't double-encode.
      ttwid: decodeURIComponent(this.ctx.cookies.get('ttwid') ?? ''),
      xsack: '1',
      xaack: '1',
      xsqos: '0',
    });
    return `${IM_WS}?${q}`;
  }

  /** Open the connection. `retryOnClose` (on by default): reconnect on drop, backing off up to 1 minute. */
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
      this.ctx.log('debug', 'tca: websocket connected');
      this.emit('connected');
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      this.touch();
      if (!isBinary) return; // "hi" reply
      try {
        this.onFrame(ws, data);
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    });
    ws.on('error', (err) => this.emit('error', err));
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return; // old connection was replaced
      this.ws = null;
      this.clearTimers();
      this.emit('closed', code, reason.toString());
      if (!this.retry || code === MANUAL_CLOSE) return;
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
      this.ctx.log('warn', `tca: websocket closed (${code}) — reconnecting in ${wait / 1000}s`);
      this.reconnectTimer = setTimeout(() => this.connect(), wait);
    });
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.ctx.log('warn', 'tca: websocket silent too long — reconnecting');
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
    const frame = parseFrame(data);
    if (frame.headers.need_ack === '1' && ws.readyState === WebSocket.OPEN) ws.send(buildAck(frame));
    const body = newMessageBody(frame);
    if (!body) return;
    const msg = parseMessage(body, this.ctx.ownId);
    if (!msg.serverMessageId || this.seen.has(msg.serverMessageId)) return;
    this.seen.add(msg.serverMessageId);
    if (this.seen.size > DEDUPE_KEEP) this.seen.delete(this.seen.values().next().value as string);
    if (msg.kind === 'command') this.emit('command', msg);
    else this.emit('message', msg);
  }
}
