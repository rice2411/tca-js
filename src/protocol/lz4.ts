/**
 * LZ4 block decompression (no frame header) — websocket frames with
 * `payload_encoding = "__lz4"` compress their payload this way. No extra dependency for ~30 lines.
 */
export function lz4Decompress(src: Buffer): Buffer {
  let out = Buffer.alloc(Math.max(src.length * 4, 1024));
  let o = 0;
  const ensure = (need: number) => {
    if (o + need <= out.length) return;
    let size = out.length * 2;
    while (o + need > size) size *= 2;
    const bigger = Buffer.alloc(size);
    out.copy(bigger, 0, 0, o);
    out = bigger;
  };
  let i = 0;
  while (i < src.length) {
    const token = src[i++];
    let lit = token >> 4;
    if (lit === 15) {
      let b: number;
      do {
        b = src[i++];
        lit += b;
      } while (b === 255);
    }
    ensure(lit);
    src.copy(out, o, i, i + lit);
    i += lit;
    o += lit;
    if (i >= src.length) break;
    const offset = src[i] | (src[i + 1] << 8);
    i += 2;
    if (offset === 0 || offset > o) throw new Error('lz4: invalid offset');
    let len = token & 15;
    if (len === 15) {
      let b: number;
      do {
        b = src[i++];
        len += b;
      } while (b === 255);
    }
    len += 4;
    ensure(len);
    // Copy byte by byte: source and destination ranges may overlap.
    for (let k = 0; k < len; k++, o++) out[o] = out[o - offset];
  }
  return out.subarray(0, o);
}
