# Contributing

Thanks for thinking about contributing to `omegaquiz`. This is small, intentionally minimal event software — a single `server.js`, three vanilla HTML pages, no build step, no database. PRs that preserve that shape are easier to land.

## Quick start

```bash
git clone https://github.com/<your-fork>/omegaquiz
cd omegaquiz
npm install -g pnpm # any recent pnpm; it switches itself to the version pinned in package.json
pnpm install --frozen-lockfile
pnpm test          # ~576 checks, should be green
pnpm start         # http://localhost:3000
```

The boot banner prints clickable magic-link URLs for both roles — click one in your terminal to sign in.

## What's in scope

Welcome contributions:

- **Bug fixes** — game-flow edge cases, accessibility regressions, security hardening.
- **Question packs** — `samples/` accepts new JSON packs. Open a PR with the pack file plus a manifest entry.
- **Documentation** — clearer wording in `README.md`, `docs/DEPLOYMENT.md`, in-line code comments where the WHY isn't obvious.
- **Accessibility improvements** — anything that moves the player / host / admin UX closer to WCAG 2.2 AA.
- **Deploy-target docs** — if you've shipped this on a platform that's not in the deploy table, a short writeup helps the next person.

## What's out of scope

These will probably be closed without a merge:

- **Multi-tenancy / multi-game-per-server** — this is event software for one room at a time. If you need many concurrent games, run many instances.
- **Database backends** — questions live in `data/questions.json`, branding in `data/config.json`, game state in memory. Replacing that with PostgreSQL adds operational surface area without solving any user problem.
- **Auth providers** (OAuth, SAML, OIDC) — recovery-token + magic-link is the chosen model. Cloudflare Access in front of `/admin` is the recommended way to add SSO.
- **Build pipelines** — no Webpack, Vite, esbuild, etc. The three HTML files load directly. If a feature needs a transpiler, please open an issue to discuss first.
- **New runtime dependencies** — the current set is `express` + `ws` + `qrcode`. Adding a fourth needs a strong justification (e.g. a security finding that can't be fixed in-tree).

If you're unsure whether a change fits, open an issue describing the problem before writing code.

## How to submit a PR

1. **Open an issue first** for anything beyond a small bug fix or doc tweak. It saves time on both sides.
2. **Fork**, branch, commit, push, open a PR against `main`.
3. **CI must be green** — the `Test` workflow runs `pnpm test` across Node 22 / 24 / 26 with `pnpm audit --prod` gated on HIGH severity, plus a Trivy scan of the Docker image.
4. **Write a test** for new behaviour. The suite in `test/security.test.js` exercises the live server in-process; follow the existing patterns.
5. **Keep the diff focused** — one PR per concern. Refactors mixed with bug fixes are hard to review.
6. **Update CHANGELOG.md** under `[Unreleased]` if your change is user-visible.
7. **Document any new env var** in `.env.example` and the README's env-var table.

## Coding conventions

- **Single-file server**. `server.js` is large but intentional; please don't split it without prior discussion.
- **Vanilla DOM in HTML**. No frameworks. No CSS preprocessors. Inline `<style>` and `<script>` are fine — the CSP has been migrated to nonces, so new inline blocks need a nonce attribute (see existing examples).
- **Comments explain WHY, not WHAT**. Identifiers should be self-explanatory; comments are for hidden constraints or non-obvious decisions.
- **No emojis in code or commit messages** unless the user-facing UI already uses one.
- **Match the existing style** — 2-space indent, semicolons, single quotes for strings.

## Dependency updates and toolchain pins

**Renovate is the only dependency bot.** `renovate.json` extends the shared [`privacykey/renovate-config`](https://github.com/privacykey/renovate-config) preset: one grouped PR for every non-major update (including lock-file maintenance) on Monday mornings, majors held on the Dependency Dashboard issue until someone ticks them, and GitHub Actions pinned to commit SHAs with the version in a trailing comment. Dependabot version updates were retired when Renovate was adopted (`.github/dependabot.yml` was deleted), so any `dependabot/*` branch or PR predates that switch — close it rather than merge it, and don't add a second bot.

**The pnpm version is pinned once**, in the `packageManager` field of `package.json`. CI reads it through `pnpm/action-setup`; the Dockerfile and `render.yaml` resolve it from `package.json` at build time. Bump it in that one place and nothing else. Corepack is not used anywhere (Node 25+ no longer bundles it).

**Security floors for transitive packages** live in `pnpm-workspace.yaml` as pnpm `overrides` (pnpm 10+ ignores a `pnpm` field in `package.json`). Add one when `pnpm audit --prod` flags a package that `express`'s own ranges already allow, and remove it once the lockfile resolves past it on its own.

## Security

If you find a vulnerability, **do not open a public issue**. See [SECURITY.md](SECURITY.md) for the private disclosure path.

## License

By submitting a PR you agree your contribution is licensed under the same [MIT License](LICENSE) as the rest of the repository.
