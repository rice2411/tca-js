/**
 * Log in by scanning a QR code with the TikTok app, then save the credentials.
 *
 *   npx tsx examples/qr-login.ts credentials.json
 *
 * Chrome / Chromium is auto-detected (override with the CHROME_PATH environment variable).
 * The QR image is written next to the output file as `qr.png` (opened automatically on macOS).
 *
 * WARNING: the saved file contains a live session cookie — keep it private and never commit it.
 */
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loginQR, TikTok } from 'tca-js';

const out = process.argv[2];
if (!out) {
  console.error('Usage: qr-login.ts <output credentials.json>');
  process.exit(1);
}
const qrFile = join(dirname(out), 'qr.png');

const credentials = await loginQR({
  onEvent: (e) => {
    if (e.type === 'qr') {
      writeFileSync(qrFile, Buffer.from(e.image.split(',')[1], 'base64'));
      if (process.platform === 'darwin') execFile('open', [qrFile]);
      console.log(`Scan ${qrFile} with the TikTok app (expires ${new Date(e.expiresAt).toLocaleTimeString()})`);
    } else {
      console.log(e.type);
    }
  },
});

const api = await new TikTok().login(credentials);
writeFileSync(out, JSON.stringify({ ...credentials, ...api.getContext() }, null, 2), { mode: 0o600 });
console.log(`Logged in as @${api.account.username} — credentials saved to ${out} (do NOT commit this file).`);
process.exit(0);
