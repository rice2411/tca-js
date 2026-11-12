/**
 * Echo bot — replies to every incoming text message.
 *
 *   npx tsx examples/echo-bot.ts credentials.json
 *
 * `credentials.json` is what `examples/qr-login.ts` writes (or any `{ cookies: [...] }` object).
 * It holds a live session — never commit it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { TikTok, TikTokError, type Credentials } from 'tca-js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: echo-bot.ts <credentials.json>');
  process.exit(1);
}

const credentials = JSON.parse(readFileSync(file, 'utf8')) as Credentials;

try {
  const api = await new TikTok().login(credentials);
  console.log(`Logged in as @${api.account.username}`);

  // Persist refreshed cookies so the next run keeps the same session.
  writeFileSync(file, JSON.stringify({ ...credentials, cookies: api.getCookies() }, null, 2));

  api.listener.on('connected', () => console.log('Listening for messages…'));
  api.listener.on('error', (err) => console.error('Listener error:', err.message));
  api.listener.on('message', async (msg) => {
    if (msg.isSelf || msg.kind !== 'text') return;
    console.log(`← ${msg.senderId}: ${msg.text}`);
    try {
      await api.sendMessage(msg, `You said: ${msg.text}`);
      await api.markRead(msg);
    } catch (err) {
      console.error('Reply failed:', err);
    }
  });
  api.listener.start();

  process.on('SIGINT', () => {
    api.listener.stop();
    process.exit(0);
  });
} catch (err) {
  if (err instanceof TikTokError && err.code === 'SESSION_EXPIRED') {
    console.error('Session expired — run examples/qr-login.ts again.');
    process.exit(1);
  }
  throw err;
}
