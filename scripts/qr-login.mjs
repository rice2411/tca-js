#!/usr/bin/env node
/**
 * Try QR login: node scripts/qr-login.mjs <chromePath> <output dir>
 * QR image is written to <output dir>/qr.png (auto-opened on macOS). On success: prints account + conversation count.
 * Does NOT write cookies to disk.
 */
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { TikTok, loginQR } from '../dist/index.js';

const [chromePath, out] = process.argv.slice(2);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const creds = await loginQR({
  chromePath,
  onEvent: (e) => {
    if (e.type === 'qr') {
      fs.writeFileSync(`${out}/qr.png`, Buffer.from(e.image.split(',')[1], 'base64'));
      if (process.platform === 'darwin') execFile('open', [`${out}/qr.png`]);
      log('New QR, expires', new Date(e.expiresAt).toISOString().slice(11, 19));
    } else log(e.type);
  },
});
log('cookie:', creds.cookies.length, 'items');
const api = await new TikTok().login(creds);
log('Logged in:', `@${api.account.username}`, api.getOwnId());
log('Conversations:', (await api.getConversations()).conversations.length);
process.exit(0);
