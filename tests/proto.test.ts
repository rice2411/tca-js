import { describe, expect, it } from 'vitest';
import { decodeFields, Msg, Writer } from '../src/protocol/proto';

describe('protobuf Writer / Msg', () => {
  it('round-trips varints, strings, nested messages and maps', () => {
    const buf = new Writer()
      .int(1, 150)
      .int(2, '7300000000000000001')
      .int(3, 0)
      .bytes(4, 'héllo')
      .bytes(5, Buffer.from([1, 2, 3]))
      .msg(6, new Writer().int(1, 42).bytes(2, 'inner'))
      .map(7, { a: '1', b: '2' })
      .bytes(8, 'x')
      .bytes(8, 'y')
      .finish();
    const m = Msg.parse(buf);
    expect(m.num(1)).toBe(150);
    expect(m.id(2)).toBe('7300000000000000001');
    expect(m.has(3)).toBe(true);
    expect(m.num(3)).toBe(0);
    expect(m.str(4)).toBe('héllo');
    expect([...m.bytes(5)]).toEqual([1, 2, 3]);
    expect(m.msg(6)?.num(1)).toBe(42);
    expect(m.msg(6)?.str(2)).toBe('inner');
    expect(m.map(7)).toEqual({ a: '1', b: '2' });
    expect(m.strs(8)).toEqual(['x', 'y']);
  });

  it('encodes 150 as the canonical varint 0x96 0x01', () => {
    expect([...new Writer().int(1, 150).finish()]).toEqual([0x08, 0x96, 0x01]);
  });

  it('encodes negative numbers as 64-bit two’s complement', () => {
    const buf = new Writer().int(1, -1).finish();
    expect(buf.length).toBe(11);
    expect(Msg.parse(buf).int(1)).toBe(2n ** 64n - 1n);
  });

  it('returns defaults for missing fields', () => {
    const m = Msg.parse(Buffer.alloc(0));
    expect(m.has(1)).toBe(false);
    expect(m.int(1)).toBe(0n);
    expect(m.str(1)).toBe('');
    expect(m.msg(1)).toBeNull();
    expect(m.msgs(1)).toEqual([]);
    expect(m.map(1)).toEqual({});
  });

  it('skips fixed32 / fixed64 fields', () => {
    // field 1 fixed64, field 2 fixed32, field 3 varint 5
    const buf = Buffer.from([0x09, 1, 2, 3, 4, 5, 6, 7, 8, 0x15, 1, 2, 3, 4, 0x18, 0x05]);
    const fields = decodeFields(buf);
    expect(fields?.map((f) => [f.n, f.wire])).toEqual([
      [1, 1],
      [2, 5],
      [3, 0],
    ]);
    expect(Msg.parse(buf).num(3)).toBe(5);
  });

  it('rejects invalid protobuf', () => {
    expect(decodeFields(Buffer.from([0x0a, 0x05, 0x01]))).toBeNull(); // length past end
    expect(decodeFields(Buffer.from([0x08, 0xff]))).toBeNull(); // truncated varint
    expect(decodeFields(Buffer.from([0x00]))).toBeNull(); // field number 0
    expect(decodeFields(Buffer.from([0x0b]))).toBeNull(); // group wire type
    expect(Msg.tryParse(Buffer.from([0x0b]))).toBeNull();
    expect(Msg.tryParse(undefined)).toBeNull();
    expect(() => Msg.parse(Buffer.from([0x0b]))).toThrow();
  });

  it('msgs() drops entries that are not valid messages', () => {
    const buf = new Writer()
      .msg(1, new Writer().int(1, 1))
      .bytes(1, Buffer.from([0x0b]))
      .finish();
    expect(Msg.parse(buf).msgs(1)).toHaveLength(1);
  });
});
