# Changelog

All notable changes to `omegaquiz` are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-05-12

Ship-readiness release. Closes the residual gaps from the OWASP Top 10 and WCAG 2.2 AA reviews, plus operations + OSS-release essentials needed for self-hosted deployment.

### Added

- **Privacy notice on the join screen** (APP 5 / Privacy Act compliance). Default text is admin-configurable from Branding → Privacy notice, or via the `CONSENT_TEXT` env var. Empty string opts out.
- **`/health` endpoint** returns JSON readiness signal. `fly.toml` and `render.yaml` updated to use it (previously polled `/` which is always 200).
- **WebSocket `player:join` rate limit** — 8 wrong codes / 60s from one IP triggers a 5-minute cooldown. Closes the 6-digit join-code brute-force window without requiring Cloudflare in front.
- **`uncaughtException` + `unhandledRejection` handlers** that log structured context and run the existing graceful-shutdown sequence so connected clients see the "reconnecting" banner instead of a silent drop.
- **Structured JSON logging** for operational events (auth, rate-limit hits, shutdown, crashes). Boot banner stays plain. Mute with `LOG_DISABLE_JSON=1` or `NODE_ENV=test`.
- **Host + admin auto-reconnect** with exponential backoff (1.5s → 30s, 10 attempts) and a manual "Reconnect" button + recovery sign-in link after the cap.
- **Maintenance → Export & Wipe Data** admin action. One click streams a final XLSX, then deletes `data/config.json` + `data/questions.json` and resets state. Refuses mid-game; requires literal "WIPE DATA" confirmation.
- **`SECURITY.md`** with private disclosure path.
- **`CONTRIBUTING.md`** describing what is in/out of scope.
- **GitHub Dependabot config** for npm, GitHub Actions, and Dockerfile ecosystems.
- **GitHub issue + PR templates** in `.github/`.
- **`docs/DEPLOYMENT.md`** — operator-friendly per-platform runbook with token-generation snippets, common failure modes, and Vercel incompatibility warning.

### Changed

- Test suite grew from 371 → 410 checks. New coverage: consent-text round-trip + sanitisation, WS join rate limiter, `/health` shape, SSRF guard explicit refusals, data-wipe end-to-end.
- README cross-links the new docs and explicitly flags Vercel as incompatible with this app's architecture.
- `package.json` version bumped to 1.1.0.

### Removed

- Dead `.drag-handle` CSS rule from `admin.html` (no HTML element used it; the up/down buttons cover the keyboard path for reordering).

### Security

- `Content-Security-Policy` migrated to per-response nonces. Inline `<script>` blocks now carry a `nonce="..."` attribute; `'unsafe-inline'` is gone from `script-src`. Any future sanitiser bypass in question content is no longer immediately weaponisable via inline-script injection.

## [1.0.0] - 2026-05-12

Initial public release of `omegaquiz`. The codebase had already received an OWASP Top 10 (2021) and a WCAG 2.2 AA review before tagging; see `OWASP-Top-10-Review-omegaquiz.md` and `A11Y-Review-omegaquiz.md` in the repo root.
