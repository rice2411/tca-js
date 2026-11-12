# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-11-12

No breaking changes — every previously exported symbol keeps its name and type.

### Added

- Dual ESM + CommonJS build (`dist/index.mjs` / `dist/index.js`) with matching type definitions and an `exports` map.
- `loginQR`: `chromePath` is now optional — Chrome / Chromium is auto-detected from `CHROME_PATH` and common install
  locations on macOS, Linux and Windows. Throws `TikTokError('LOGIN_FAILED')` when none is found.
- `findChrome()` export to locate a Chrome / Chromium executable.
- Unit test suite (vitest) covering protobuf encoding, LZ4, message parsing, reactions, websocket framing and cookie
  handling.
- ESLint + Prettier, CI (Node 22 / 24) and tag-based release workflow with npm provenance.
- `examples/` (`echo-bot.ts`, `qr-login.ts`), `CONTRIBUTING.md`, issue / PR templates.

### Changed

- Source reorganised into `api/`, `auth/`, `listener/`, `models/` and `protocol/` modules. No behaviour change.
- Build switched from `tsc` to `tsup`; the package is marked `sideEffects: false`.

### Removed

- `scripts/qr-login.mjs` — superseded by `examples/qr-login.ts`.

## [0.3.1] - 2026-11-12

### Changed

- README and package metadata updates.

## [0.3.0] - 2026-11-12

Initial public release.

### Added

- Cookie login (`new TikTok().login`) and QR login via headless Chrome (`loginQR`).
- Conversations, message history, user profiles, mark as read.
- Send text and images; download and decrypt private images, stickers and avatars.
- Reactions: read (mobile `e:love` merged into ❤️) and set (`api.setReaction`).
- Real-time websocket listener with auto-reconnect.

[0.4.0]: https://github.com/rice2411/tca-js/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/rice2411/tca-js/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/rice2411/tca-js/releases/tag/v0.3.0
