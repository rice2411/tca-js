import { describe, expect, it } from 'vitest';
import { accessKey, buildAck, newMessageBody, parseFrame } from '../src/listener/frame';
import { Listener } from '../src/listener/listener';
import { parseMessage } from '../src/models/message';
import { Cmd, Resp } from '../src/protocol/constants';
import { Context } from '../src/protocol/context';
import { Msg, Writer } from '../src/protocol/proto';
import { messageBody, OWN } from './helpers';

const DEVICE = '7300000000000000001';

/** Wrap a `MessageBody` in Response → body → NewMessageNotify, like the websocket push. */
function pushPayload(cmd: number = Cmd.NewMessage): Buffer {
  const notify = new Writer().bytes(2, 'conv').int(3, 1).msg(5, messageBody());
  return new Writer()
    .int(Resp.cmd, cmd)
    .int(Resp.seq, 1)
    .int(Resp.status, 0)
    .msg(Resp.body, new Writer().msg(cmd, notify))
    .finish();
}

/** LZ4 block holding `data` as literals only (valid, no compression). */
function lz4Literals(data: Buffer): Buffer {
  const n = data.length;
  const ext: number[] = [];
  if (n >= 15) {
    let rest = n - 15;
    while (rest >= 255) {
      ext.push(255);
      rest -= 255;
    }
    ext.push(rest);
  }
  return Buffer.concat([Buffer.from([Math.min(n, 15) << 4, ...ext]), data]);
}

function frame(payload: Buffer, opts: { encoding?: string; headers?: Record<string, string> } = {}): Buffer {
  return new Writer()
    .int(1, 11)
    .int(2, 22)
    .int(3, 5)
    .int(4, 1)
    .map(5, opts.headers ?? {})
    .bytes(6, opts.encoding ?? 'pb')
    .bytes(7, 'msg')
    .bytes(8, payload)
    .finish();
}

describe('websocket access_key', () => {
  it('is md5(FPID + APP_KEY + device_id + SALT)', () => {
    expect(accessKey(DEVICE)).toBe('c4226d3e53f5de6da0b5fb4eef26107b');
  });

  it('is embedded in the listener URL together with the decoded ttwid', () => {
    const ctx = new Context({ cookies: { sessionid: 's', ttwid: '1%7Cabc' }, deviceId: DEVICE });
    const url = new URL(new Listener(ctx).url());
    expect(url.origin + url.pathname).toBe('wss://im-ws-sg.tiktok.com/ws/v2');
    expect(url.searchParams.get('access_key')).toBe('c4226d3e53f5de6da0b5fb4eef26107b');
    expect(url.searchParams.get('device_id')).toBe(DEVICE);
    expect(url.searchParams.get('ttwid')).toBe('1|abc');
    expect(url.searchParams.get('aid')).toBe('1459');
  });
});

describe('websocket frames', () => {
  it('extracts a NewMessage body from a plain frame', () => {
    const f = parseFrame(frame(pushPayload(), { headers: { need_ack: '1', x_frontier_traceid: 't1' } }));
    expect(f.seq).toBe(11n);
    expect(f.logId).toBe(22n);
    expect(f.headers.need_ack).toBe('1');
    const body = newMessageBody(f);
    expect(body).not.toBeNull();
    expect(parseMessage(body!, OWN).text).toBe('hello');
  });

  it('decompresses __lz4 payloads', () => {
    const f = parseFrame(frame(lz4Literals(pushPayload()), { encoding: '__lz4' }));
    expect(parseMessage(newMessageBody(f)!, OWN).text).toBe('hello');
  });

  it('ignores empty payloads and other commands', () => {
    expect(newMessageBody(parseFrame(frame(Buffer.alloc(0))))).toBeNull();
    expect(newMessageBody(parseFrame(frame(pushPayload(Cmd.SendMessage))))).toBeNull();
  });

  it('builds an ack echoing seq / logid and the trace id', () => {
    const f = parseFrame(frame(Buffer.alloc(0), { headers: { x_frontier_traceid: 'trace' } }));
    const ack = Msg.parse(buildAck(f, 36 ** 3));
    expect(ack.num(1)).toBe(11);
    expect(ack.num(2)).toBe(22);
    expect(ack.map(5)).toEqual({ is_ack: '1', ack_id: '1000:trace', ack_code: '0' });
    expect(ack.str(9)).toBe('1000:trace');
  });
});
