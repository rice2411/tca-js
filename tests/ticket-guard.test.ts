import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Context } from '../src/protocol/context';
import { isTicketGuard, ticketGuardHeaders } from '../src/protocol/ticket-guard';
import type { TicketGuard } from '../src/models/types';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const guard: TicketGuard = {
  privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  tsSign: 'ts.1.abc',
  ticket: 'c3b058' + '0'.repeat(58),
};

const decode = (b64: string) => JSON.parse(Buffer.from(b64, 'base64').toString()) as Record<string, unknown>;

describe('ticketGuardHeaders', () => {
  it('signs "ticket=…&path=…&timestamp=…" with ECDSA-SHA256 (DER)', () => {
    const h = ticketGuardHeaders(guard, '/v1/message/send', 1_794_466_686_123);
    const data = decode(h['tt-ticket-guard-client-data']);
    expect(data).toMatchObject({ ts_sign: 'ts.1.abc', req_content: 'ticket,path,timestamp', timestamp: 1_794_466_686 });
    const message = `ticket=${guard.ticket}&path=/v1/message/send&timestamp=1794466686`;
    expect(verify('sha256', Buffer.from(message), publicKey, Buffer.from(String(data.req_sign), 'base64'))).toBe(true);
    expect(h['tt-ticket-guard-version']).toBe('2');
    expect(h['tt-ticket-guard-web-version']).toBe('1');
    expect(h['tt-ticket-guard-iteration-version']).toBe('0');
  });

  it('sends the public key as the uncompressed point', () => {
    const point = Buffer.from(ticketGuardHeaders(guard, '/x')['tt-ticket-guard-public-key'], 'base64');
    expect(point).toHaveLength(65);
    expect(point[0]).toBe(4);
  });

  it('validates the stored shape', () => {
    expect(isTicketGuard(guard)).toBe(true);
    expect(isTicketGuard({ ...guard, ticket: '' })).toBe(false);
    expect(isTicketGuard(null)).toBe(false);
  });
});

describe('Context.im signing', () => {
  afterEach(() => vi.unstubAllGlobals());

  const capture = () => {
    const seen: Record<string, string>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(init.headers as Record<string, string>);
        return new Response(new Uint8Array([0x18, 0x00]), { status: 200 }); // status_code 0
      }),
    );
    return seen;
  };

  it('signs message/send only', async () => {
    const seen = capture();
    const ctx = new Context({ cookies: {}, ticketGuard: guard });
    await ctx.im('/v1/message/send', 100, Buffer.alloc(0));
    await ctx.im('/v3/conversation/mark_read', 604, Buffer.alloc(0));
    expect(seen[0]).toHaveProperty('tt-ticket-guard-client-data');
    expect(seen[1]).not.toHaveProperty('tt-ticket-guard-client-data');
  });

  it('sends unsigned without ticketGuard', async () => {
    const seen = capture();
    await new Context({ cookies: {} }).im('/v1/message/send', 100, Buffer.alloc(0));
    expect(seen[0]).not.toHaveProperty('tt-ticket-guard-client-data');
  });
});
