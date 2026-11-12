/**
 * "Frontier" websocket framing — pure helpers (no socket), shared by the listener and unit tests.
 */
import { createHash } from 'node:crypto';
import { Cmd, FRONTIER_APP_KEY, FRONTIER_FPID, FRONTIER_SALT, Resp } from '../protocol/constants';
import { lz4Decompress } from '../protocol/lz4';
import { Msg, Writer } from '../protocol/proto';

/** "Frontier" websocket frame: {1 seqid, 2 logid, 3 service, 4 method, 5 headers, 6 encoding, 7 type, 8 payload}. */
export interface Frame {
  seq: bigint;
  logId: bigint;
  headers: Record<string, string>;
  encoding: string;
  payload: Buffer;
}

/** Websocket `access_key` = md5(FPID + APP_KEY + device_id + SALT). */
export function accessKey(deviceId: string): string {
  return createHash('md5')
    .update(FRONTIER_FPID + FRONTIER_APP_KEY + deviceId + FRONTIER_SALT)
    .digest('hex');
}

export function parseFrame(data: Buffer): Frame {
  const m = Msg.parse(data);
  return {
    seq: m.int(1),
    logId: m.int(2),
    headers: m.map(5),
    encoding: m.str(6),
    payload: m.bytes(8),
  };
}

/** The `MessageBody` of a `NewMessage` push inside a frame, or `null` if the frame carries something else. */
export function newMessageBody(frame: Frame): Msg | null {
  if (frame.payload.length === 0) return null;
  const payload = frame.encoding === '__lz4' ? lz4Decompress(frame.payload) : frame.payload;
  const resp = Msg.tryParse(payload);
  if (!resp || resp.num(Resp.cmd) !== Cmd.NewMessage) return null;
  // NewMessageNotify: {2 conversationId, 3 type, 4 ?, 5 MessageBody}
  return resp.msg(Resp.body)?.msg(Cmd.NewMessage)?.msg(5) ?? null;
}

/** Acknowledge receipt — `ack_id = <base36 time>:<x_frontier_traceid>`, echoing the frame's seq/logid. */
export function buildAck(f: Frame, now: number = Date.now()): Buffer {
  const ackId = `${now.toString(36)}:${f.headers.x_frontier_traceid ?? ''}`;
  return new Writer()
    .int(1, f.seq)
    .int(2, f.logId)
    .int(3, 5)
    .int(4, 1)
    .map(5, { is_ack: '1', ack_id: ackId, ack_code: '0' })
    .bytes(9, ackId)
    .finish();
}
