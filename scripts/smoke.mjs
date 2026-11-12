#!/usr/bin/env node
/**
 * Smoke-test tca on a real account.
 *
 *   node scripts/smoke.mjs --cookies <file.json> [--peer <uid>] [--text "…"] [--image <file>] [--listen <seconds>]
 *
 * <file.json>: array of `{name, value}` `.tiktok.com` cookies (chrome.cookies / CDP) — CONTAINS THE SESSION, keep it out of the repo.
 * READ-ONLY, unless `--text` / `--image` is given (sent to the conversation with `--peer`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { TikTok } from '../dist/index.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : acc), []),
);
if (!args.cookies) {
  console.error('Missing --cookies <file.json>');
  process.exit(1);
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const api = await new TikTok({ logger: (lv, m) => log(`[${lv}]`, m) }).login({
  cookies: JSON.parse(fs.readFileSync(args.cookies, 'utf8')),
  deviceId: args.device,
});
log('Logged in:', `@${api.account.username}`, api.getOwnId(), 'device', api.getContext().deviceId);

const page = await api.getConversations();
const users = await api.getUsers(page.conversations.map((c) => c.peerId).filter(Boolean).slice(0, 20));
const name = Object.fromEntries(users.map((u) => [u.uid, `${u.nickname} (@${u.uniqueId})`]));
log(`Conversations: ${page.conversations.length} (more: ${page.hasMore})`);
for (const c of page.conversations.slice(0, 10)) {
  const last = page.messages.find((m) => m.conversationId === c.conversationId);
  log('  -', name[c.peerId] ?? c.peerId, '|', last ? `${last.kind}: ${last.text.slice(0, 40)}` : '');
}

const conv = args.peer ? page.conversations.find((c) => c.peerId === String(args.peer)) : null;
if (args.peer && !conv) throw new Error(`No conversation found with ${args.peer}`);
if (conv) {
  const { messages } = await api.getMessages(conv, { limit: 10 });
  log(`Last 10 messages with ${name[conv.peerId] ?? conv.peerId}:`);
  for (const m of messages) log('  ', m.isSelf ? '→' : '←', m.kind, m.text.slice(0, 50), m.image ? `${m.image.width}x${m.image.height}` : '');
  const img = messages.find((m) => m.image);
  if (img) {
    const buf = await api.downloadImage(img);
    log('Downloaded + decrypted image:', buf.length, 'bytes, header', buf.subarray(0, 4).toString('latin1'));
  }
}

const echoes = [];
api.listener.on('connected', () => log('Listener: connected'));
api.listener.on('error', (e) => log('Listener error:', e.message));
api.listener.on('closed', (c, r) => log('Listener closed:', c, r));
api.listener.on('message', (m) => {
  echoes.push(m);
  log('Listener ←', m.isSelf ? '(self)' : name[m.senderId] ?? m.senderId, `${m.kind}/${m.type}`, m.text.slice(0, 60), m.image ? `${m.image.width}x${m.image.height}` : '');
});
api.listener.start();
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('Listener failed to connect within 15s')), 15_000);
  api.listener.once('connected', () => (clearTimeout(t), resolve()));
}).catch((e) => {
  log(e.message);
  process.exit(1);
});

if (conv && args.text) log('Sent text:', (await api.sendMessage(conv, String(args.text))).clientMessageId);
if (conv && args.image) {
  const file = String(args.image);
  log('Sent image:', (await api.sendImage(conv, { data: fs.readFileSync(file), filename: path.basename(file) })).clientMessageId);
}

await new Promise((r) => setTimeout(r, Number(args.listen ?? 10) * 1000));
api.listener.stop();
log(`Done — listener received ${echoes.length} messages.`);
process.exit(0);
