/**
 * Protobuf tối thiểu, không cần file `.proto`.
 *
 * TikTok không công bố `.proto` của IM — số trường ở `constants.ts` dựng lại từ byte bắt được
 * trên trình duyệt (09/11/2026). Chỉ cần ba kiểu dây: varint (0), độ dài (2), và bỏ qua 1/5.
 */

export interface Field {
  n: number;
  wire: number;
  int: bigint;
  bytes: Buffer;
}

function readVarint(b: Buffer, i: number): [bigint, number] {
  let x = 0n;
  let shift = 0n;
  let c: number;
  do {
    if (i >= b.length) throw new Error('varint vượt cuối buffer');
    c = b[i++];
    x |= BigInt(c & 127) << shift;
    shift += 7n;
  } while (c & 128);
  return [x, i];
}

/** Tách một message thành danh sách trường. `null` nếu byte không phải protobuf hợp lệ. */
export function decodeFields(b: Buffer): Field[] | null {
  const out: Field[] = [];
  let i = 0;
  try {
    while (i < b.length) {
      const [key, j] = readVarint(b, i);
      i = j;
      const wire = Number(key & 7n);
      const n = Number(key >> 3n);
      if (n === 0) return null;
      if (wire === 0) {
        const [v, k] = readVarint(b, i);
        out.push({ n, wire, int: v, bytes: Buffer.alloc(0) });
        i = k;
      } else if (wire === 2) {
        const [len, k] = readVarint(b, i);
        const end = k + Number(len);
        if (end > b.length) return null;
        out.push({ n, wire, int: 0n, bytes: b.subarray(k, end) });
        i = end;
      } else if (wire === 1 || wire === 5) {
        const size = wire === 1 ? 8 : 4;
        if (i + size > b.length) return null;
        out.push({ n, wire, int: 0n, bytes: b.subarray(i, i + size) });
        i += size;
      } else {
        return null;
      }
    }
  } catch {
    return null;
  }
  return out;
}

/** Message đã giải — đọc theo số trường. */
export class Msg {
  private constructor(readonly fields: Field[]) {}

  static parse(b: Buffer): Msg {
    const f = decodeFields(b);
    if (!f) throw new Error('Không giải được protobuf');
    return new Msg(f);
  }

  static tryParse(b: Buffer | undefined): Msg | null {
    if (!b) return null;
    const f = decodeFields(b);
    return f ? new Msg(f) : null;
  }

  has(n: number): boolean {
    return this.fields.some((f) => f.n === n);
  }

  int(n: number): bigint {
    return this.fields.find((f) => f.n === n)?.int ?? 0n;
  }

  num(n: number): number {
    return Number(this.int(n));
  }

  /** Số nguyên 64-bit dạng chuỗi — uid / mã tin vượt `Number.MAX_SAFE_INTEGER`. */
  id(n: number): string {
    return this.int(n).toString();
  }

  bytes(n: number): Buffer {
    return this.fields.find((f) => f.n === n)?.bytes ?? Buffer.alloc(0);
  }

  str(n: number): string {
    return this.bytes(n).toString('utf8');
  }

  strs(n: number): string[] {
    return this.fields.filter((f) => f.n === n).map((f) => f.bytes.toString('utf8'));
  }

  msg(n: number): Msg | null {
    return Msg.tryParse(this.fields.find((f) => f.n === n)?.bytes);
  }

  msgs(n: number): Msg[] {
    return this.fields
      .filter((f) => f.n === n)
      .map((f) => Msg.tryParse(f.bytes))
      .filter((m): m is Msg => m !== null);
  }

  /** `map<string,string>` — mỗi phần tử là message `{1: key, 2: value}`. */
  map(n: number): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of this.msgs(n)) out[m.str(1)] = m.str(2);
    return out;
  }
}

function varint(x: bigint | number): Buffer {
  let v = BigInt(x);
  if (v < 0n) v = BigInt.asUintN(64, v);
  const out: number[] = [];
  do {
    const c = Number(v & 127n);
    v >>= 7n;
    out.push(v ? c | 128 : c);
  } while (v);
  return Buffer.from(out);
}

const key = (n: number, wire: number): Buffer => varint((BigInt(n) << 3n) | BigInt(wire));

/** Ghép message theo thứ tự gọi. */
export class Writer {
  private readonly parts: Buffer[] = [];

  int(n: number, v: bigint | number | string): this {
    this.parts.push(key(n, 0), varint(typeof v === 'string' ? BigInt(v) : v));
    return this;
  }

  bytes(n: number, v: Buffer | string): this {
    const b = typeof v === 'string' ? Buffer.from(v, 'utf8') : v;
    this.parts.push(key(n, 2), varint(b.length), b);
    return this;
  }

  msg(n: number, w: Writer): this {
    return this.bytes(n, w.finish());
  }

  /** `map<string,string>` theo đúng thứ tự khoá của object. */
  map(n: number, obj: Record<string, string>): this {
    for (const [k, v] of Object.entries(obj)) this.msg(n, new Writer().bytes(1, k).bytes(2, v));
    return this;
  }

  finish(): Buffer {
    return Buffer.concat(this.parts);
  }
}
