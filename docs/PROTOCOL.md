# Protocol Notes

Reference for maintainers: how TikTok Web messaging works on the wire. Field lists use protobuf field numbers.

- [Overview](#overview)
- [Session](#session)
- [HTTP IM](#http-im)
- [Message body](#message-body)
- [Websocket](#websocket)
- [Images](#images)
- [Debugging](#debugging)

## Overview

| Channel   | Endpoint                                            | Auth                   |
| --------- | --------------------------------------------------- | ---------------------- |
| HTTP IM   | `POST https://im-api-sg.tiktok.com/<path>?aid=1988` | cookies                |
| Websocket | `wss://im-ws-sg.tiktok.com/ws/v2?aid=1459&fpid=9`   | cookies + `access_key` |
| QR login  | `tiktok.com/passport/web/*`                         | cookies + JS signature |

Messaging endpoints only check cookies — the `X-Gnarly`, `X-Dynosaur`, `X-Bogus`, `msToken` signatures and
`tt-ticket-guard-*` headers sent by the web app can be omitted. The QR login endpoints do verify signatures
(unsigned calls return `error_code 7`), which is why `loginQR` drives a headless browser and only observes its traffic
through CDP.

## Session

| Item          | Notes                                                                 |
| ------------- | --------------------------------------------------------------------- |
| Account check | `passport/web/account/info`                                           |
| `device_id`   | The `wid` issued for a `ttwid` by `/api/v1/web-cookie-privacy/config` |
| HTTP          | Accepts any `device_id`                                               |
| Websocket     | Accepts only the real `wid` (otherwise HTTP 400)                      |

QR login flow (observed via CDP): `get_qrcode` returns the image → `check_qrconnect` reports
`new → scanned → confirmed` (or `expired`, then reload) → read cookies with `Network.getAllCookies`.

## HTTP IM

Request and response bodies are protobuf.

```text
Request  {1 cmd, 2 seq, 3 sdk "1.8.5", 5 3, 6 0, 7 build, 8 {<cmd>: body}, 9 device_id, 11 "web", 15 map, 18 1}
Response {1 cmd, 3 status_code, 4 error, 6 {<cmd>: body}}
```

`status_code 200005` means the session is not logged in.

A JSON body (`{"status_code": 7, …}`, `content-type: application/json`) instead of protobuf comes from the gateway in
front of IM: it refused the request before IM saw it. 12/11/2026 one stored session got 7 on every `message/send`
(even a garbage body) while reads worked; a fresh login passed, unsigned. The web client now also sends
`tt-ticket-guard-*` headers + `X-Gnarly`/`X-Dynosaur` on `message/send` only — not enforced yet.

| Path                              | Cmd  | Body                                                                                  |
| --------------------------------- | ---- | ------------------------------------------------------------------------------------- |
| `/v1/message/send`                | 100  | `{1 convId, 2 1, 3 shortId, 4 content, 5 ext, 6 type, 7 "deprecated", 8 clientMsgId}` |
| `/v2/message/get_by_user_init`    | 203  | `{1 offset}` → `{1 messages, 2 conversations, 4 next, 5 hasMore}`                     |
| `/v1/message/get_by_conversation` | 301  | `{1 convId, 2 1, 3 shortId, 4 1, 5 anchorIndex, 6 limit}`                             |
| `/v3/conversation/mark_read`      | 2002 | body at field 604: `{1 convId, 2 shortId, 3 1, 4 index, 11 4}`                        |
| `/v1/media/upload_config`         | 2059 | empty → ImageX STS credentials                                                        |
| `/v1/message/set_property`        | 705  | see [Reactions](#reactions)                                                           |

A one-to-one `convId` is `0:1:<smaller uid>:<larger uid>`.

## Message body

```text
MessageBody {1 convId, 3 serverMsgId, 4 index, 5 shortId, 6 type, 7 sender, 8 content,
             9 ext, 10 createdAt (ms), 15 reactions, 18 quote, 20 attachments}
```

| Type    | Kind           | Content                    |
| ------- | -------------- | -------------------------- |
| `7`     | Text           | `{"aweType":0,"text":"…"}` |
| `1802`  | Private image  | attachments → 4            |
| `1805`  | Sticker        | attachments → 7            |
| `8`     | Shared video   | —                          |
| `1`     | System         | —                          |
| `50001` | Hidden command | read receipts etc.         |

### Reactions

```text
field 15          {1 "e:<emoji>", 2 {1 [{1 uid, 3 seconds, 4 idempotent_id, 6 µs}]}}
set_property body {1 {1 convId, 2 1, 3 shortId, 4 serverMsgId, 5 clientMsgId,
                      6 [{1 op (0 add, 1 remove), 2 "e:<emoji>", 4 uid}]}, 2 ticket}
```

- One reaction per user: switching emoji adds the new key and removes the old one in the same command.
- The mobile app writes ❤️ as both `e:❤️` and the legacy `e:love`; the library merges them.

### Stickers

```text
attachments → 7   {1 {1 uri, 2 url, 5 {w, h}}, 200 {1 {2 map a:sticker_id, a:sticker_type}}}
```

`sticker_type` 14 = built-in, 15 = user-made. Sticker URLs are on a public CDN. TikTok Web has no sticker sending.

## Websocket

```text
URL         wss://im-ws-sg.tiktok.com/ws/v2?aid=1459&fpid=9&access_key=…&device_id=<wid>&ttwid=…
access_key  md5("9" + "e1bd35ec9db7b8d846de66ed140b1ad9" + wid + "f8a69f1719916z")
Frame       {1 seq, 2 logid, 3 5, 4 1, 5 headers, 6 encoding, 7 "pb", 8 Response}
Ack         {1 seq, 2 logid, 3 5, 4 1, 5 {is_ack: 1, ack_id, ack_code: 0}, 9 ack_id}
```

| Rule        | Value                                                                         |
| ----------- | ----------------------------------------------------------------------------- |
| New message | `Response.cmd = 500`, message at `body[500][5]`                               |
| Compression | `encoding = "__lz4"` → LZ4 block                                              |
| Keep-alive  | send text `"hi"` every 15 s                                                   |
| Ack         | when header `need_ack=1`; `ack_id = <Date.now() base36>:<x_frontier_traceid>` |
| Duplicates  | the same message may be pushed several times — dedupe by id                   |

## Images

### Sending

1. `upload_config` (cmd 2059) → ImageX STS credentials.
2. `ApplyImageUpload` — AWS SigV4, region `cn-north-1`, service `imagex`.
3. `POST https://<UploadHost>/upload/v1/<StoreUri>` with `Authorization`, `Content-CRC32` and `X-Storage-U: <uid>`
   (missing `X-Storage-U` returns 4004).
4. `CommitImageUpload` with `Functions: Encryption cipher_v2` → `Uri`, `SecretKey`, dimensions.
5. Send a type `1802` message referencing the upload.

### Receiving

Image URLs (`p0-tiktok-dm-private-sg…`) require cookies. Content is AES-256-GCM:

```text
IV (12 bytes) ‖ ciphertext ‖ tag (16 bytes)     key = decrypt_key (hex) from the message
```

## Debugging

1. Start Chrome with a remote debugging port and capture `Network.*` for every target, including the chat iframe
   (`tiktok.com/messages?scene=business`).
2. Decode protobuf bodies without a schema to read the field tree.
3. The web app's messaging bundle (`messages-vmok` manifest) contains full protobufjs schemas — the fastest way to find
   new commands.
4. Rebuild the request with `Writer`, drop the signatures, and confirm the server still accepts it.
