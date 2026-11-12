import { describe, expect, it } from 'vitest';
import { findChrome, resolveChromePath } from '../src/auth/chrome';
import { TikTokError } from '../src/errors';

const has =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

describe('findChrome', () => {
  it('prefers CHROME_PATH', () => {
    expect(findChrome({ CHROME_PATH: '/custom/chrome' }, 'linux', has('/custom/chrome', '/usr/bin/chromium'))).toBe(
      '/custom/chrome',
    );
  });

  it('ignores a CHROME_PATH that does not exist', () => {
    expect(findChrome({ CHROME_PATH: '/nope' }, 'linux', has('/usr/bin/chromium'))).toBe('/usr/bin/chromium');
  });

  it('finds Chrome on macOS', () => {
    const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    expect(findChrome({}, 'darwin', has(p))).toBe(p);
  });

  it('falls back to PATH on Linux', () => {
    expect(findChrome({ PATH: '/opt/bin:/home/me/bin' }, 'linux', has('/home/me/bin/chromium-browser'))).toBe(
      '/home/me/bin/chromium-browser',
    );
  });

  it('returns null when nothing is installed', () => {
    expect(findChrome({ PATH: '/bin' }, 'linux', () => false)).toBeNull();
  });

  it('resolveChromePath keeps an explicit path', () => {
    expect(resolveChromePath('/explicit')).toBe('/explicit');
  });
});

describe('TikTokError', () => {
  it('carries code and upstream code', () => {
    const err = new TikTokError('IM_ERROR', 'boom', 200005);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TikTokError');
    expect(err.code).toBe('IM_ERROR');
    expect(err.upstream).toBe(200005);
  });
});
