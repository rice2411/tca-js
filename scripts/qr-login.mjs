#!/usr/bin/env node
/**
 * Thử đăng nhập QR: node scripts/qr-login.mjs <chromePath> <thư mục ra>
 * Ảnh QR ghi ra <thư mục>/qr.png (mở sẵn trên macOS). Thành công: in tài khoản + số hội thoại.
 * KHÔNG ghi cookie ra đĩa.
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
      log('QR mới, hết hạn', new Date(e.expiresAt).toISOString().slice(11, 19));
    } else log(e.type);
  },
});
log('cookie:', creds.cookies.length, 'cái');
const api = await new TikTok().login(creds);
log('Đăng nhập:', `@${api.account.username}`, api.getOwnId());
log('Hội thoại:', (await api.getConversations()).conversations.length);
process.exit(0);
