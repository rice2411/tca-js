<div align="center">

# tca-js

**Unofficial TikTok Chat API for Node.js**

Read and send TikTok direct messages, react, and receive new messages in real time.

[![npm](https://img.shields.io/npm/v/tca-js)](https://www.npmjs.com/package/tca-js)
[![license](https://img.shields.io/github/license/rice2411/tca-js)](LICENSE)
[![node](https://img.shields.io/node/v/tca-js)](package.json)

</div>

> [!WARNING]
> This project is not affiliated with or endorsed by TikTok / ByteDance. It relies on undocumented APIs that can change
> at any time. Automating an account may violate TikTok's Terms of Service and can get it restricted — use at your own risk.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Authentication](#authentication)
- [API Reference](#api-reference)
- [Listener](#listener)
- [Error Handling](#error-handling)
- [Examples](#examples)
- [Contributing](#contributing)
- [Support Us](#support-us)
- [License](#license)

## Features

- 💬 Send text and image messages
- 📥 List conversations, page through message history, look up users
- ⚡ Real-time listener over websocket with auto-reconnect
- 🖼️ Download and decrypt private images, download stickers and avatars
- ❤️ Read and set reactions, mark conversations as read
- 🔐 Cookie-based session — no browser at runtime
- 📱 Optional QR-code login
- 📦 Written in TypeScript, ships ESM + CommonJS builds with type definitions, one runtime dependency (`ws`)

## Installation

```bash
npm install tca-js
```

Requires **Node.js 22+**. Both ESM and CommonJS are supported:

```ts
import { TikTok } from 'tca-js'; // ESM / TypeScript
const { TikTok } = require('tca-js'); // CommonJS
```

QR login also needs a local Chrome or Chromium; cookie login does not.

## Quick Start

```ts
import { TikTok } from 'tca-js';

const api = await new TikTok().login({ cookies });

api.listener.on('message', async (msg) => {
  if (msg.isSelf) return;
  await api.sendMessage(msg, `You said: ${msg.text}`);
});

api.listener.start();
```

## Authentication

### Cookies

Log in with the cookies of a `tiktok.com` session. Accepted formats:

```ts
await new TikTok().login({ cookies: [{ name: 'sessionid', value: '…' } /* … */] }); // array
await new TikTok().login({ cookies: { sessionid: '…', ttwid: '…' } }); // object
await new TikTok().login({ cookies: 'sessionid=…; ttwid=…' }); // header string
```

Required cookies: `sessionid`, `sid_tt`, `sid_guard`, `uid_tt`, `ttwid`, `odin_tt`, `store-idc`, `tt-target-idc`.
A session lasts about 6 months, and logging in does not sign out other devices.

### QR code

`loginQR` opens a headless Chrome on TikTok's QR page, emits the QR image, and resolves with credentials once the code is
scanned and confirmed on the phone.

```ts
import { loginQR, TikTok } from 'tca-js';

const credentials = await loginQR({
  onEvent: (e) => {
    if (e.type === 'qr') showQr(e.image); // data:image/png;base64,…
  },
});

const api = await new TikTok().login(credentials);
// Save `credentials` to skip scanning next time.
```

| Option       | Type          | Default     | Description                                                                        |
| ------------ | ------------- | ----------- | ---------------------------------------------------------------------------------- |
| `chromePath` | `string`      | auto-detect | Path to Chrome / Chromium (falls back to `CHROME_PATH`, then common install paths) |
| `onEvent`    | `(e) => void` | —           | `qr` · `scanned` · `confirmed`                                                     |
| `signal`     | `AbortSignal` | —           | Cancel the login                                                                   |
| `timeoutMs`  | `number`      | `300000`    | Total time to wait for a scan                                                      |
| `maxRefresh` | `number`      | `3`         | Max QR regenerations after expiry                                                  |
| `userAgent`  | `string`      | —           | Browser user agent                                                                 |

## API Reference

`new TikTok(options?)` — `logger?: (level, msg) => void`, `timeoutMs?: number`.
`.login(credentials)` resolves to an `API` instance.

### Conversations & messages

| Method                                   | Returns            | Description                                          |
| ---------------------------------------- | ------------------ | ---------------------------------------------------- |
| `getConversations(cursor?)`              | `ConversationPage` | 10 conversations per page with their latest messages |
| `getMessages(conv, { limit?, before? })` | `MessagePage`      | Messages of a conversation, newest first             |
| `sendMessage(conv, text)`                | `SendResult`       | Send a text message                                  |
| `sendImage(conv, { data, filename })`    | `SendResult`       | Send an image (`Buffer`)                             |
| `setReaction(msg, emoji \| null)`        | `void`             | Set your reaction; `null` removes it                 |
| `markRead(msg)`                          | `void`             | Mark the conversation as read up to `msg`            |

`conv` is any object with `conversationId` and `conversationShortId` — every message satisfies it, so you can reply
with `sendMessage(msg, …)`.

### Users & media

| Method                                    | Returns                  | Description                          |
| ----------------------------------------- | ------------------------ | ------------------------------------ |
| `getUsers(uids)`                          | `TikTokUser[]`           | Nickname, `@username`, avatar        |
| `downloadImage(msg, 'origin' \| 'thumb')` | `Buffer`                 | Download and decrypt a private image |
| `downloadSticker(sticker)`                | `{ data, type }`         | Download a sticker image             |
| `downloadAvatar(user)`                    | `{ data, type } \| null` | Download a user's avatar             |

### Session

| Method / property | Description                                                  |
| ----------------- | ------------------------------------------------------------ |
| `account`         | Logged-in account: `uid`, `username`, `screenName`, `avatar` |
| `getOwnId()`      | Own user id                                                  |
| `getCookies()`    | Current cookies — persist them to resume the session         |
| `isAlive()`       | `true` while the session is still valid                      |

### Message object

| Field                 | Type                                                               | Description              |
| --------------------- | ------------------------------------------------------------------ | ------------------------ |
| `kind`                | `'text' \| 'image' \| 'sticker' \| 'video' \| 'system' \| 'other'` | Message kind             |
| `text`                | `string`                                                           | Text content             |
| `image` / `sticker`   | `object \| null`                                                   | Attachment details       |
| `reactions`           | `{ emoji, userIds }[]`                                             | Reactions on the message |
| `senderId` / `isSelf` | `string` / `boolean`                                               | Sender                   |
| `createdAt`           | `number`                                                           | Epoch milliseconds       |

Full typings are shipped in `dist/index.d.ts`.

## Listener

```ts
api.listener.on('connected', () => console.log('connected'));
api.listener.on('message', (msg) => {
  /* new message */
});
api.listener.on('command', (msg) => {
  /* read receipts and other hidden commands */
});
api.listener.on('closed', (code, reason) => {});
api.listener.on('error', (err) => {});

api.listener.start(); // reconnects automatically; start({ retryOnClose: false }) to disable
api.listener.stop();
```

## Error Handling

All library errors are instances of `TikTokError` with a `code`:

| Code                                | Meaning                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `SESSION_EXPIRED`                   | Cookies are no longer valid — log in again                                                    |
| `SESSION_BLOCKED`                   | TikTok's gateway refuses this session (JSON `status_code: 7`, seen on sending) — log in again |
| `IM_ERROR`                          | TikTok rejected the request                                                                   |
| `HTTP_ERROR` · `BAD_RESPONSE`       | Network or unexpected response                                                                |
| `UPLOAD_FAILED` · `DOWNLOAD_FAILED` | Media transfer failed                                                                         |
| `LOGIN_FAILED` · `LOGIN_ABORTED`    | QR login failed or was cancelled                                                              |

```ts
import { TikTokError } from 'tca-js';

try {
  await api.sendMessage(conv, 'hi');
} catch (err) {
  if (err instanceof TikTokError && err.code === 'SESSION_EXPIRED') {
    // refresh credentials
  }
}
```

## Examples

- [`examples/qr-login.ts`](examples/qr-login.ts) — log in with a QR code and save the credentials to a file
- [`examples/echo-bot.ts`](examples/echo-bot.ts) — reply to every incoming text message

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Protocol notes for maintainers are in [docs/PROTOCOL.md](docs/PROTOCOL.md).

```bash
npm install
npm test                                        # unit tests (no network)
npm run lint && npm run typecheck
npm run build
node scripts/smoke.mjs --cookies cookies.json   # read-only smoke test against a real account
```

## Support Us

- ⭐ **Star the repository** if you find it useful
- 🔄 **Share** it with others
- 💡 **Contribute** ideas and code
- ☕ **Buy me a coffee** — VietQR (MB Bank · `0776750418`)

<img src=".github/assets/vietqr-mb.png" alt="VietQR MB Bank 0776750418" width="220">

## License

[MIT](LICENSE) © rice2411
