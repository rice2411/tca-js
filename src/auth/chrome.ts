import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { TikTokError } from '../errors';

/** Executable names looked up on `PATH` (Linux / BSD). */
const PATH_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];

/** Well-known install locations per platform. */
function knownPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin') {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Chromium.app/Contents/MacOS/Chromium',
      'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ];
    const roots = ['/Applications', ...(env.HOME ? [join(env.HOME, 'Applications')] : [])];
    return roots.flatMap((r) => apps.map((a) => join(r, a)));
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((r): r is string => !!r);
    return roots.flatMap((r) => [
      join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(r, 'Chromium', 'Application', 'chrome.exe'),
    ]);
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome',
  ];
}

/**
 * Locate a Chrome / Chromium executable: `CHROME_PATH` env, then well-known install paths for the platform, then
 * `PATH`. Returns `null` when none is found.
 */
export function findChrome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (env.CHROME_PATH && exists(env.CHROME_PATH)) return env.CHROME_PATH;
  for (const p of knownPaths(platform, env)) if (exists(p)) return p;
  if (platform !== 'win32') {
    for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
      for (const name of PATH_NAMES) if (exists(join(dir, name))) return join(dir, name);
    }
  }
  return null;
}

/** `chromePath` if given, otherwise auto-detect — throws `LOGIN_FAILED` when nothing is found. */
export function resolveChromePath(chromePath?: string): string {
  if (chromePath) return chromePath;
  const found = findChrome();
  if (!found) {
    throw new TikTokError(
      'LOGIN_FAILED',
      'Chrome / Chromium not found — install it, set the CHROME_PATH environment variable, or pass `chromePath`',
    );
  }
  return found;
}

/** Launch headless Chrome and wait for the "DevTools listening on ws://…" line. */
export async function launchChrome(
  chromePath: string,
  userAgent: string,
): Promise<{ proc: ChildProcess; ws: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'tca-chrome-'));
  const proc = spawn(
    chromePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      // Containers run as root — Chromium requires disabling the sandbox.
      '--no-sandbox',
      '--window-size=1280,900',
      '--lang=vi-VN',
      // The default headless UA contains "HeadlessChrome" — replace it with a normal UA.
      `--user-agent=${userAgent}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const ws = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not start within 20s')), 20_000);
    proc.stderr!.on('data', (d: Buffer) => {
      buf += d.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited (${code}) before it was ready`));
    });
  }).catch(async (err: unknown) => {
    proc.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
    throw new TikTokError(
      'LOGIN_FAILED',
      `Failed to launch Chrome: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  return { proc, ws, dir };
}
