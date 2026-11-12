# Contributing

Thanks for helping out! Bug reports, protocol findings and pull requests are all welcome.

## Setup

Requires Node.js 22+.

```bash
npm install
npm test
```

## Scripts

| Script               | What it does                                    |
| -------------------- | ----------------------------------------------- |
| `npm run build`      | Build ESM + CJS bundles and type definitions    |
| `npm run dev`        | Rebuild on change                               |
| `npm test`           | Run unit tests (vitest, no network)             |
| `npm run test:watch` | Tests in watch mode                             |
| `npm run lint`       | ESLint                                          |
| `npm run format`     | Prettier                                        |
| `npm run typecheck`  | `tsc --noEmit`                                  |
| `npm run smoke`      | Read-only smoke test against a real account (*) |

(*) `node scripts/smoke.mjs --cookies cookies.json` — needs `npm run build` first. Never commit cookie files.

Please run `npm run lint && npm run typecheck && npm test` before opening a pull request. Unit tests must not hit
the network or use real cookies — build protobuf fixtures by hand (see `tests/helpers.ts`).

## Protocol notes

TikTok's IM protocol is undocumented. How field numbers, commands and signing were reconstructed is described in
[docs/PROTOCOL.md](docs/PROTOCOL.md); protocol constants live in `src/protocol/constants.ts`.

## Commit style

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat: …`, `fix: …`, `docs: …`, `refactor: …`,
`test: …`, `chore: …`. Mark breaking changes with `!` (`feat!: …`).

## Releasing

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Commit, then tag `vX.Y.Z` and push the tag.
3. The `Release` workflow tests, builds and publishes to npm (Trusted Publishing, with provenance) and creates a
   GitHub Release.
