# Changelog

All notable changes to `omegaquiz` are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Re-key without a restart.** `node server.js remint <admin|host|all>` rotates a recovery token in place and `node server.js links [role]` mints fresh single-use magic sign-in links, both from a shell on the server (`fly ssh console -C "node /app/server.js links"`, `docker exec …`). The running server picks the new values up lazily — on the next recovery sign-in or the first click of the link — so nothing restarts and nobody is signed out. Works for tokens kept in `DATA_DIR/secrets.json` (`AUTO_PROVISION_SECRETS=true`, the `fly.toml` default); env-managed tokens are refused with a ready-to-paste `fly secrets set` line instead. Run as root (as `fly ssh console` does), the subcommands drop to the owner of `DATA_DIR` so the server can still read what they write.
- **Admin → Settings → Sign-in & keys.** Mint a new host or admin magic link (the `auth:mint-magic-link` action existed but had no UI), rotate either recovery token (`auth:rotate-recovery-token`), and see where each token comes from (`admin:init` now carries `keys`; `auth:keys-status` on demand). Rotated values are shown once, to the requesting socket only.
- `just remint`, `just links`, `just fly-remint`, `just fly-links` recipes, and a "Keys — lost, expired or compromised" section in `docs/DEPLOYMENT.md`.

### Accessibility

Closes six confirmed WCAG 2.2 AA findings from the pre-ship audit follow-up. Mouse users only see darker state colours and a few extra words; keyboard and screen-reader users get working tabs, a submittable join form and answer states they can actually perceive.

- **Admin tabs are real tabs.** The six dashboard tabs were `<div>`s with a click listener — unreachable by keyboard and not announced. They are now `<button role="tab">` inside a `role="tablist"`, with `aria-selected`, `aria-controls`, a roving `tabindex` and Left/Right/Home/End arrow-key navigation; every panel is a `role="tabpanel"` labelled by its tab. The Branding form still lazy-loads on first show, now regardless of whether the tab was reached by click, keyboard or the Overview "View all" button — which is now a `<button>` (it was an `<a>` with no `href`).
- **Player answer state is no longer colour-only.** Each answer button's accessible name ends with its state ("— your answer", "— correct", "— wrong, your answer", "— removed by 50/50"), the selection is exposed via `aria-pressed`, options removed by 50/50 are genuinely `disabled` (previously only `pointer-events:none`, which did not stop Enter/Space), and a visible text tag (✓ Correct / ✗ Your answer / Selected / Removed, plus strike-through) mirrors the colour.
- **Pinch-zoom re-enabled on the player page** — `user-scalable=no` removed from the viewport meta (WCAG 1.4.4).
- **Join screen is a real `<form>`.** Enter and the phone keyboard's Go key now submit; inputs carry `required` and `aria-describedby` pointing at the error message; on a validation or server error the offending field gets `aria-invalid="true"` (red ring) and takes focus. The error no longer auto-hides after 4 s — it stays until the next attempt or a successful join.
- **Contrast.** Selected/pending answers (white on `#d97706`, 2.9:1), correct answers (white on `#16a34a`, 3.0:1), wrong answers (4.3:1 after opacity), the Lock In button (white on `#22c55e`, 2.3:1) and the host projector's correct-answer letter (gold on `#16a34a`, 2.0:1) now use darker fills (`#9a3412`, `#15803d`, `#b91c1c`) with white letters — every state is ≥ 5.0:1.
- **Admin banners are announced and stay put.** `#banner-area` is a `role="status"` polite live region, and the 5 s auto-dismiss on success banners (JS timer plus the CSS fade-out) is gone; the existing Dismiss button closes them.

### Security

- **HIGH — One oversized WebSocket frame from an unauthenticated visitor crashed the server.** `ws` re-emits protocol errors (frame over `maxPayload`, invalid UTF-8) as an `'error'` event on the socket; no listener was registered, so the event became an `uncaughtException` and ran the full graceful shutdown. A single 5 MiB frame dropped every player and restarted the process (reproduced against `main`). Patched: per-socket `'error'` listener that logs `ws.socket-error`, plus a 16 KiB cap on messages from non-admin sockets, closed with 1009 before parsing.
- **`qs` and `body-parser` advisories closed with pnpm override floors.** `pnpm audit --prod` reported three moderate advisories in `qs` 6.15.1 (GHSA-q8mj-m7cp-5q26, GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g) and one low in `body-parser` 2.2.2 (GHSA-v422-hmwv-36x6), all transitive via `express`. New `pnpm-workspace.yaml` sets `overrides` of `qs >=6.16.0` and `body-parser >=2.3.0` (pnpm 10+ no longer reads a `pnpm` field in `package.json`); the lockfile now resolves 6.16.0 / 2.3.0 and the audit is clean.
- **`aquasecurity/trivy-action` pinned to a commit SHA** (`ed142fd0…`, v0.36.0), matching every other action in the workflow. The old `@0.36.0` ref pointed at a tag that does not exist upstream (releases are tagged `v0.36.0`), so the container-scan job had failed at set-up on every run.
- **Docker runtime image applies Alpine security patches and no longer ships npm.** With the scan able to run for the first time, Trivy flagged the base image itself: `libcrypto3` / `libssl3` CVE-2026-14456 (fixed in 3.5.8-r0) and HIGH advisories in npm's own bundled `brace-expansion`, `ip-address` and `tar`, none of them application dependencies. The runtime stage now runs `apk upgrade --no-cache` and removes npm / npx (nothing at runtime uses them; the CLI is `node server.js …`). The image scans clean with CI's flags and `/health` still answers.

### Changed

- `secrets.json` is written atomically (temp file + rename) and records `rotatedAt` per role. `HOST_TOKEN` / `ADMIN_TOKEN` are mutable inside the process; `COOKIE_SECRET` is not.
- Structured JSON log lines are suppressed while a subcommand runs — its output is for a human.
- Test suite: 519 → 576 checks (re-keying unit + WS + end-to-end child-process coverage, WS robustness).
- **One pnpm version pin.** The `packageManager` field in `package.json` is the single source of truth. The Dockerfile (hard-coded 11.1.3) and `render.yaml` (Corepack + 11.0.6) now resolve the version from `package.json` at build time and install it with `npm install -g`. Corepack is no longer used anywhere: Node 25+ does not bundle it.
- **Supported Node is now 22.13 or newer** (`engines.node`), and the CI matrix is Node 22 / 24 / 26 instead of 18 / 20 / 22 / 24. pnpm 11 refuses to run on older Node, which is why the Node 18 and 20 jobs had failed at `pnpm install` on every run since May; both versions are also end-of-life.
- **The `Test` workflow is enabled again.** It had been disabled manually while every run was red for the two reasons above. It runs on push, pull request and nightly.
- Docs: README and CONTRIBUTING quick-starts use `npm install -g pnpm` instead of `corepack enable`; the test count and Node matrix are current; CONTRIBUTING records that Renovate (shared `privacykey/renovate-config` preset) is the only dependency bot and that Dependabot was retired.
- Test suite: 576 → 616 checks. New `A11Y:` sections assert the served markup keeps every fix above: tab/tabpanel wiring and key handling, the live region and absence of the auto-dismiss, form semantics, `aria-pressed` / `disabled` / state text on answers, the computed contrast ratio of every state fill, zoomable viewports, and no inline `on*=` handlers on any page.

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
