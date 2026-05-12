# Security policy

## Supported versions

`omegaquiz` is event-driven training software, not a long-running service. We try to keep the `main` branch shippable; older commits do not receive security backports.

| Version | Supported |
|---|---|
| `main` (HEAD) | ✅ |
| Tagged releases (`v1.x.y`) | ✅ — current minor only |
| Forks / older commits | ❌ |

If you're running a fork, please rebase onto current `main` before reporting.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security findings. Send a private report instead:

- Or use **GitHub's private vulnerability reporting** (Security tab → Report a vulnerability) if you have the repo open.

In your report, please include:

- The version (commit SHA or tag) you tested against
- A clear description of the vulnerability and its impact
- Steps to reproduce (PoC code is welcome but not required)
- Your name / handle if you'd like credit in the changelog
- Whether you've disclosed it elsewhere (e.g. a CVE has been requested)

## What to expect

- **Acknowledgement** within 5 business days (often sooner).
- **Triage and severity assessment** within 10 business days.
- **Fix targeted** for the current `main` branch. We do not backport to older releases.
- **Disclosure timeline** of 90 days from initial report, or earlier with your agreement. If we can't fix within 90 days, we'll discuss extension or coordinated disclosure with you.
- **Credit** in the CHANGELOG and (if you want) a thank-you in the release notes.

## Out of scope

The following are documented limitations, not vulnerabilities:

- **6-digit join code is guessable** — there's a per-IP rate limit on `player:join` (8 attempts / 60s, 5-minute cooldown) and the README recommends deploying behind Cloudflare for edge rate limiting. The threat model assumes the app is taken offline between events.
- **Admin role is a strict superset of host** — by design. Two separate identities aren't necessary for an event-driven tool.
- **PII (player names + emails) is collected** — the join screen carries a configurable privacy notice and the admin "Maintenance" tab includes a one-click wipe. The retention policy is the operator's responsibility.
- **Theme editor allows arbitrary CSS colour values** — validated against a hex regex; no user-controlled values reach `style` attributes verbatim.
- **No multi-tenancy** — one game per server. If you need multiple concurrent games, run multiple instances.

## Out of scope (the spirit of)

- Reports that boil down to "you should use feature X for defence in depth" without a specific exploit path.
- Findings that require unrealistic prerequisites (e.g. "if the admin pastes attacker-controlled HTML into the question editor…" — yes, that's why the editor has an HTML allowlist).
- Reports about dependencies that are already at the latest patch version per `pnpm audit`.

If you're unsure, send the report anyway — we'd rather receive false positives than miss a real issue.
