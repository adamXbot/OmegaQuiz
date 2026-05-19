# Changelog

All notable changes to `omegaquiz` are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.1] - 2026-05-19

Blue-hat security audit follow-up. Closes nine findings raised in a Railway-targeted review, none of which were caught by the existing 487-check suite.

### Security

- **HIGH — Remote unauthenticated DoS via malformed cookie on WebSocket upgrade.** `parseCookies` called `decodeURIComponent` unguarded; a single WS upgrade with `Cookie: omegaquiz_sess=%X` threw `URIError`, escaped the `wss.on('connection')` handler, and tripped the `uncaughtException` listener into `gracefulShutdown` — i.e. one packet, one full restart. Patched: `parseCookies` now swallows malformed `%` sequences and treats the raw value as opaque (the cookie verifier rejects it downstream).
- **HIGH — Login rate-limiter was non-functional.** A fresh entry started with `blockedUntil = 0`, which is always `< Date.now()`, so the "reset expired block" branch fired on every call and the counter never reached 5. `HOST_TOKEN` / `ADMIN_TOKEN` brute-force was effectively unthrottled. Patched: mirrored the `recordJoinFailure` shape with a `firstAt` field and an explicit `LOGIN_WINDOW_MS` window check.
- **MEDIUM — `getClientIp` ignored Railway / Render / Fly reverse proxies**, collapsing every per-IP rate-limit bucket to one entry (the PaaS edge IP). Patched: `TRUST_PROXY=auto` (default) trusts `X-Forwarded-For` when the socket peer looks like a reverse proxy (loopback / RFC1918 / 100.64-CGN / Cloudflare edge / IPv6 ULA + link-local). `TRUST_PROXY=1` forces trust, `TRUST_PROXY=0` disables it.
- **MEDIUM — Open redirect on `/auth/login?next=…`.** The path-validation regex permitted `//attacker.example/path` because `/` is in the character class and the anchored regex only required a single leading `/`. Patched: dedicated `isSafeNext()` helper rejects `//`, `/\`, oversized values, and now backs both the GET render and the POST redirect.
- **LOW — `lifeline:askit` correct-answer broadcast** reached every WebSocket connection, including unauthenticated listeners with no `player:join`. Patched: broadcast filter now requires `player` / `host` / `admin` role.
- **LOW — SSRF redirect bypass in `fetchTextSafe`.** The initial URL was validated, but `fetch({ redirect: 'follow' })` would chase 30x responses to `http://`, private IPs, or loopback without re-running the guards. Patched: `redirect: 'manual'`, every `Location` re-validated through `assertSafeFetchUrl`, redirect chain capped at 3 hops.
- **LOW — HTTPS redirect echoed `req.headers.host`.** A forged `Host` header on a non-TLS deploy could be redirected to `https://attacker.example/…`. Patched: redirect target is now built from `branding.publicBaseUrl` / `PUBLIC_BASE_URL`; a 400 is returned if neither is set so the operator's misconfiguration is loud, not silently exploitable.
- **Defence-in-depth — Generic error-handler middleware.** Express's default error renderer was echoing JS stacks back to the client when middleware threw (visible during F1 testing on the HTTP path). Replaced with a tail handler that logs the error and returns a plain `Server error` body in every `NODE_ENV`.
- **Defence-in-depth — `COOKIE_SECRET` is now required in production**, matching the existing fatal check for `HOST_TOKEN` and `ADMIN_TOKEN`. Restart-driven session rotation was a UX foot-gun, not a security gap, but worth being explicit about.

### Added

- `TRUST_PROXY` env var (documented in `.env.example`) with `auto` / `1` / `0` modes.
- 32 new regression tests under "F1: … F7: …" headings in `test/security.test.js` (487 → 519 checks). Each finding has at least one unit + one end-to-end assertion.

### Changed

- `recordLoginFailure` / `isBlocked` / `clearLoginFailures` now exported (alongside their join-failure counterparts) for test coverage.
- `getClientIp` decision tree rewritten around an `isPrivateOrLoopbackIp` helper; the Cloudflare CIDR check is preserved.
- `parseSeedBody` / `fetchTextSafe` redirect handling rewritten to manual mode.

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
