import { describe, expect, it } from 'vitest';
import { lz4Decompress } from '../src/protocol/lz4';

describe('lz4Decompress', () => {
  it('decodes literals + an overlapping match + trailing literals', () => {
    // token 0x3B: 3 literals "abc", match length 11 + 4 = 15 at offset 3; then token 0x20: 2 literals "xy".
    const src = Buffer.from([0x3b, 0x61, 0x62, 0x63, 0x03, 0x00, 0x20, 0x78, 0x79]);
    expect(lz4Decompress(src).toString()).toBe('abc'.repeat(6) + 'xy');
  });

  it('decodes extended literal and match lengths', () => {
    // 20 literals: 15 + extra byte 5; match length 15 + 255 + 10 + 4 = 284 at offset 1.
    const lits = Buffer.from('ABCDEFGHIJKLMNOPQRST');
    const src = Buffer.concat([Buffer.from([0xff, 5]), lits, Buffer.from([0x01, 0x00, 255, 10])]);
    const out = lz4Decompress(src);
    expect(out.length).toBe(20 + 284);
    expect(out.subarray(0, 20).toString()).toBe('ABCDEFGHIJKLMNOPQRST');
    expect(out.subarray(20).every((b) => b === 0x54)).toBe(true); // repeats "T"
  });

  it('grows the output buffer past its initial size', () => {
    // 1 literal "z" then a 4000-byte run (15 + 15×255 + 156 + 4 = 4000).
    const ext = [...Array(15).fill(255), 156];
    const src = Buffer.from([0x1f, 0x7a, 0x01, 0x00, ...ext]);
    const out = lz4Decompress(src);
    expect(out.length).toBe(4001);
    expect(out.every((b) => b === 0x7a)).toBe(true);
  });

  it('rejects an offset pointing before the start', () => {
    expect(() => lz4Decompress(Buffer.from([0x10, 0x61, 0x05, 0x00]))).toThrow(/invalid offset/);
    expect(() => lz4Decompress(Buffer.from([0x10, 0x61, 0x00, 0x00]))).toThrow(/invalid offset/);
  });
});
