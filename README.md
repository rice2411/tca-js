# tca-js — Unofficial TikTok Chat API

Read and send TikTok **direct messages** (text, images, reactions) and receive new messages in real time over
websocket — **using session cookies only, no browser needed**. Same idea as [`zca-js`](https://github.com/RFS-ADRENO/zca-js)
for Zalo: it speaks the same protocol as TikTok Web (`tiktok.com/messages`, `tiktok.com/business-suite/messages`).

> [!WARNING]
> This is an **unofficial** library, not affiliated with or endorsed by TikTok / ByteDance. It relies on undocumented
> internal APIs that can change or break at any time. Automating a TikTok account may violate TikTok's Terms of Service
> and **can get the account restricted or banned** — use it at your own risk, don't spam.

## Install

```bash
npm install tca-js
```

Node.js ≥ 22. QR login additionally needs a local Chrome / Chromium (see below); cookie login does not.

## Quick start

```ts
import { TikTok, loginQR } from 'tca-js';

const api = await new TikTok().login(await loginQR({ chromePath, onEvent }));  // or saved cookies
api.listener.on('message', async (msg) => {
  if (msg.isSelf) return;
  if (msg.image) await api.downloadImage(msg);       // decrypted image Buffer
  await api.sendMessage(msg, 'Got it, thanks!');     // a message carries its conversation
});
api.listener.start();                                 // reconnects on drop
await api.sendImage(conv, { data: buf, filename: 'photo.jpg' });
```

## API

| Method | Does |
|---|---|
| `loginQR({chromePath, onEvent, signal})` | QR login through headless Chrome → `Credentials` |
| `new TikTok().login({cookies, deviceId?, userAgent?})` | validate cookies (`passport/web/account/info`), resolve `wid` as `device_id` → `API` |
| `api.getConversations(cursor?)` | 10 conversations per page + latest message; page with `cursor` |
| `api.getMessages(conv, {limit, before})` | messages of a conversation, newest → oldest |
| `api.getUsers(uids)` | display name, `@username`, avatar |
| `api.sendMessage(conv, text)` / `api.sendImage(conv, {data, filename})` | send |
| `api.setReaction(msg, emoji \| null)` | your reaction on a message (one per user, `null` = remove); read via `msg.reactions` |
| `api.downloadSticker(msg.sticker)` | sticker image (public CDN) |
| `api.downloadImage(msg)` | download + decrypt AES-256-GCM (listener messages carry no link — looked up from history) |
| `api.markRead(msg)` · `api.isAlive()` · `api.getCookies()` | |
| `api.listener` | events `connected` · `message` · `command` (read receipts…) · `closed` · `error` |

Errors: `TikTokError.code` — `SESSION_EXPIRED` (get fresh cookies), `IM_ERROR`, `UPLOAD_FAILED`, `DOWNLOAD_FAILED`, `HTTP_ERROR`.

## Session — QR login and cookies

```ts
import { loginQR, TikTok } from 'tca-js';
const creds = await loginQR({ chromePath: '/usr/bin/chromium-browser', onEvent: (e) => { /* qr | scanned | confirmed */ } });
const api = await new TikTok().login(creds);   // SAVE creds (cookies) to skip scanning next time
```

- **Reading / sending / websocket only need cookies.** The `X-Gnarly`, `X-Dynosaur`, `X-Bogus`, `msToken` signatures
  and `tt-ticket-guard-*` headers the page attaches to IM requests are **not checked** by the server.
- **The QR login API (`passport/web/check_qrconnect`) DOES check signatures** — calling it bare from Node returns
  `error_code 7`. So `loginQR` opens **headless Chrome/Chromium** at `tiktok.com/login/qrcode`, lets the page sign its
  own requests, and only LISTENS via CDP: the QR image comes from the `get_qrcode` response, status
  (`new → scanned → confirmed`, or `expired` → reload for a new QR) from `check_qrconnect`. Once confirmed it reads the
  cookies (`Network.getAllCookies`) and closes Chrome. Works with `--no-sandbox` Chromium on Alpine.
- Core cookies: `sessionid`, `sid_tt`, `sid_guard`, `uid_tt`, `ttwid`, `odin_tt`, `store-idc`, `tt-target-idc`.
  `sessionid` lives ~6 months. TikTok allows concurrent sessions — logging in here doesn't kick other devices.
- `device_id` = the `wid` TikTok issues for a `ttwid` (`/api/v1/web-cookie-privacy/config`). HTTP IM accepts any id
  but **the websocket only accepts the real `wid`** (made-up id → 400).

## Protocol (for fixing it when TikTok changes)

**HTTP IM** — `POST https://im-api-sg.tiktok.com/<path>?aid=1988&…`, protobuf request and response.
`Request {1 cmd, 2 seq, 3 sdk "1.8.5", 5 3, 6 0, 7 build, 8 {<cmd>: body}, 9 device_id, 11 "web", 15 map, 18 1}`,
`Response {1 cmd, 3 status_code, 4 error, 6 {<cmd>: body}}` (`200005` = not logged in).

| path | cmd | body |
|---|---|---|
| `/v1/message/send` | 100 | `{1 convId, 2 1, 3 shortId, 4 content JSON, 5 ext, 6 type, 7 "deprecated", 8 clientMsgId, [13 image, 14 "private_image", 17 image]}` |
| `/v2/message/get_by_user_init` | 203 | `{1 offset}` → `{1 messages[], 2 conversations[], 4 next offset, 5 has more}` |
| `/v1/message/get_by_conversation` | 301 | `{1 convId, 2 1, 3 shortId, 4 1 (older), 5 index anchor, 6 limit}` |
| `/v3/conversation/mark_read` | 2002 (body at 604) | `{1 convId, 2 shortId, 3 1, 4 index, 11 4}` |
| `/v1/media/upload_config` | 2059 | empty → ImageX STS keys |
| `/v1/message/set_property` | 705 | `{1 {1 convId, 2 1, 3 shortId, 4 serverMsgId, 5 clientMsgId, 6 [{1 op 0 add/1 remove, 2 "e:<emoji>", 4 own uid}]}, 2 ticket}` → `{1 status (0 ok, 1 duplicate), 2 version}` |

`MessageBody {1 convId, 3 serverMsgId, 4 index, 5 shortId, 6 type, 7 sender, 8 content JSON, 9 ext, 10 time ms, 15 reactions, 18 quote, 20 image/sticker}`.
Types: `7` text (`{"aweType":0,"text":…}`), `1802` private image, `1805` sticker, `8` shared video, `1` system, `50001` hidden command.

**Reactions** (field 15): `{1 "e:<emoji>", 2 {1 [{1 uid, 3 seconds, 4 idempotent_id, 6 µs}]}}`.
The mobile app writes ❤️ as both `e:❤️` and the legacy `e:love` key (web ignores `e:love`) → `tca-js` merges them into ❤️.
Web offers 12 emoji, one reaction per user (add the new key + remove your old one in the same 705 command).
**Stickers** (`1805`, field 20 → 7): `{1 {1 uri, 2 public CDN url, 5 {w,h}}, 200 {1 {2 map a:sticker_id, a:sticker_type (14 stock / 15 custom)…}}}`.
TikTok Web only DISPLAYS stickers, it has no send button — sending stickers is not implemented.
1-1 `convId` = `0:1:<smaller uid>:<larger uid>`.

**Websocket** — `wss://im-ws-sg.tiktok.com/ws/v2?aid=1459&fpid=9&access_key=…&device_id=<wid>&ttwid=…`
+ cookies. `access_key = md5("9" + "e1bd35ec9db7b8d846de66ed140b1ad9" + wid + "f8a69f1719916z")`.
Frame `{1 seq, 2 logid, 3 5, 4 1, 5 headers, 6 encoding ("__lz4" = block compression), 7 "pb", 8 Response}`;
new message = `Response.cmd 500`, `body[500][5]` is a `MessageBody`. Keep-alive: send text `"hi"` every 15 s.
Frames with header `need_ack=1` → reply `{1 seq, 2 logid, 3 5, 4 1, 5 {is_ack:1, ack_id, ack_code:0}, 9 ack_id}`,
`ack_id = <Date.now() base36>:<x_frontier_traceid>`. The server may push a message several times → dedupe by message id.

**Sending images** — `upload_config` → ImageX signed with AWS SigV4 (`cn-north-1`/`imagex`): `ApplyImageUpload` →
`POST https://<UploadHost>/upload/v1/<StoreUri>` (headers `Authorization: <Auth>`, `Content-CRC32`,
**`X-Storage-U: <uid>`** — missing it gives 4004) → `CommitImageUpload` with `Functions: Encryption cipher_v2`
→ returns `Uri` + `SecretKey` + dimensions → send message type `1802`.
**Receiving images** — `p0-tiktok-dm-private-sg…` links (need cookies), content is AES-256-GCM:
`12-byte IV ‖ ciphertext ‖ 16-byte tag`, key = `decrypt_key` (hex) in the message.

## Re-discovering the protocol when it breaks

Run Chrome with a debug port and capture traffic over CDP (`Network.*` for every target, including the chat iframe
`tiktok.com/messages?scene=business`), then print the protobuf tree without a `.proto`. The web app's message bundle
(`messages-vmok` manifest) ships full protobufjs schemas — the fastest way to find new commands. Requests the browser
sends are the reference: rebuild them with `Writer`, drop the signatures, check the server still accepts them.

## Development

```bash
npm install && npm run build
node scripts/qr-login.mjs <chromePath> <output dir>   # try QR login (writes qr.png)
node scripts/smoke.mjs --cookies <cookies.json> [--peer <uid>] [--text "…"] [--image <file>] [--listen 10]
```

`cookies.json` holds a real session — keep it out of the repo (already in `.gitignore`).

Source comments are in Vietnamese. Issues and PRs welcome in English or Vietnamese.

## License

[MIT](LICENSE)
