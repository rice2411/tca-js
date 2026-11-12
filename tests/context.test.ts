import { afterEach, describe, expect, it, vi } from 'vitest';
import { TikTokError } from '../src/errors';
import { Context, normalizeCookies } from '../src/protocol/context';
import { DEFAULT_USER_AGENT } from '../src/protocol/constants';
import { Msg } from '../src/protocol/proto';

describe('normalizeCookies', () => {
  it('accepts an array of {name, value}', () => {
    const jar = normalizeCookies([
      { name: 'sessionid', value: 'abc' },
      { name: 'ttwid', value: '1%7Cx', domain: '.tiktok.com' } as { name: string; value: string },
      { name: '', value: 'skipped' },
    ]);
    expect([...jar]).toEqual([
      ['sessionid', 'abc'],
      ['ttwid', '1%7Cx'],
    ]);
  });

  it('accepts an object', () => {
    expect([...normalizeCookies({ sessionid: 'abc', uid_tt: '1' })]).toEqual([
      ['sessionid', 'abc'],
      ['uid_tt', '1'],
    ]);
  });

  it('accepts a Cookie header string (values may contain "=")', () => {
    expect([...normalizeCookies(' sessionid=abc ; sid_guard=a=b|c; broken ;=x')]).toEqual([
      ['sessionid', 'abc'],
      ['sid_guard', 'a=b|c'],
    ]);
  });
});

describe('Context', () => {
  it('builds the Cookie header and defaults', () => {
    const ctx = new Context({ cookies: 'a=1; b=2' });
    expect(ctx.cookieHeader()).toBe('a=1; b=2');
    expect(ctx.userAgent).toBe(DEFAULT_USER_AGENT);
    expect(ctx.deviceId).toBe('');
  });

  it('wraps a command in the IM Request envelope', () => {
    const ctx = new Context({ cookies: {}, deviceId: '123' });
    const req = Msg.parse(ctx.buildRequest(301, 301, Buffer.from([0x08, 0x01])));
    expect(req.num(1)).toBe(301);
    expect(req.str(9)).toBe('123');
    expect(req.msg(8)?.msg(301)?.num(1)).toBe(1);
    expect(req.map(15)).toMatchObject({ aid: '1988', device_id: '123', app_name: 'tiktok_web' });
    // seq increases per request
    const next = Msg.parse(ctx.buildRequest(301, 301, Buffer.alloc(0)));
    expect(next.num(2)).toBe(req.num(2) + 1);
  });
});

describe('Context.im — gateway JSON replies', () => {
  afterEach(() => vi.unstubAllGlobals());

  const reply = (body: string, contentType: string) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': contentType } })),
    );

  it('maps status_code 7 to SESSION_BLOCKED', async () => {
    reply('{"status_msg":"","status_code":7}', 'application/json');
    const err = await new Context({ cookies: {} }).im('/v1/message/send', 100, Buffer.alloc(0)).catch((e) => e);
    expect(err).toBeInstanceOf(TikTokError);
    expect(err).toMatchObject({ code: 'SESSION_BLOCKED', upstream: 7 });
  });

  it('maps other gateway codes to BAD_RESPONSE with the code', async () => {
    reply('{"status_code":8}', 'application/json; charset=utf-8');
    const err = await new Context({ cookies: {} }).im('/v1/message/send', 100, Buffer.alloc(0)).catch((e) => e);
    expect(err).toMatchObject({ code: 'BAD_RESPONSE', upstream: 8 });
  });
});
