<div align="center">

# OmegaQuiz

A self-hosted, multi-device live quiz for in-house staff training.

[![Project status](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FadamXbot%2F.github%2Fmain%2Fbadges%2FOmegaQuiz.json)](https://github.com/adamXbot/.github/blob/main/STATUS.md#omegaquiz)
[![Licence](https://img.shields.io/github/license/adamXbot/OmegaQuiz?label=licence)](LICENSE)

</div>

<!-- disclosure:start -->
> [!WARNING]
> **Pre-1.0 — no stable release yet.** Anything can change in any release, including a patch: APIs, CLI flags, config keys, file formats, and data already on disk. Keep your own backups.
> **Project status.** The badge above is generated from [the adamXbot status list](https://github.com/adamXbot/.github/blob/main/STATUS.md), which says what I promise for this project and every other one.
<!-- disclosure:end -->

---

You run a 10–15 question session in a room of 5–100 people; their phones are the buzzers, a projector is the game board, and you get a spreadsheet at the end with every answer and a pass/fail summary.

A session goes: open the lobby on the projector → staff scan the QR code and join with name and work email → admin clicks **Start Game** → for each question, host clicks **Close & Reveal** once everyone has answered → at the end, admin downloads the results.

Wrong answer means elimination from the prize race, but the player can keep answering for engagement and accuracy stats. Optional **50:50 / Ask IT / Skip** lifelines if the room votes for them.

There is no database, no third-party SaaS, and no telemetry. One Node process, one game at a time, one folder of data on disk.

## What it does

**Three screens, one game.** The player screen (`/`) runs on each staff member's phone. The host screen (`/host`) is the big board for the projector: question, answer choices, survivor count, prize ladder. The admin screen (`/admin`) is the facilitator's control panel: roster, live answer tally, question editor, branding, report download, and session close/reopen.

**Starts empty, and you load the questions.** Four ways to fill the bank: the bundled sample packs, a CSV import, typing them into the admin UI, or seeding from a URL at deploy time. See [`docs/QUESTIONS.md`](docs/QUESTIONS.md).

**Three sample packs are bundled** in [`samples/`](samples) — a 10-question phishing-awareness round with 5 tiebreakers (the default), plus shorter nature and pop-culture packs.

**Reports come out as XLSX or CSV**, one row per player, with per-question answers and results. The XLSX is colour-coded so a printout is scannable. See [`docs/REPORTS.md`](docs/REPORTS.md).

**Tamper-resistant by design.** Questions can only be edited while the lobby is open or after a game ends; mid-game edits are blocked server-side. The bank is sanitised on save, and CSV exports escape leading `=`, `+`, `-`, and `@` so a spreadsheet will not evaluate player-supplied text as a formula.

**Magic-link sign-in.** The boot banner prints single-use, 10-minute sign-in URLs for the host and admin roles. `HOST_TOKEN` and `ADMIN_TOKEN` are long-lived recovery tokens for when every magic link has expired — treat them as password-manager entries, not daily passwords.

## Get it

Requires Node 18 or newer. The package manager is pnpm, pinned in `package.json`; npm and yarn are not supported here.

```bash
git clone https://github.com/adamXbot/OmegaQuiz.git
cd OmegaQuiz
corepack enable
pnpm install --frozen-lockfile
pnpm start
```

Open `http://localhost:3000`. The terminal prints magic-link URLs for the admin and host roles — click one to sign in. Test from another phone on the same Wi-Fi at `http://<your-laptop-ip>:3000`.

To host it for real, it needs a long-lived process and a writable disk: Railway, Render, Fly.io, DigitalOcean App Platform, or Docker all work. **Vercel, Netlify and Cloudflare Pages will not** — serverless functions cannot host a stateful WebSocket server with persistent storage. [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) is the full runbook, including secret generation, volumes, Cloudflare, and teardown between events.

## Docs

- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — hosting, secrets, Cloudflare, and tearing down after an event
- [`docs/QUESTIONS.md`](docs/QUESTIONS.md) — authoring and importing the question bank
- [`docs/REPORTS.md`](docs/REPORTS.md) — what the XLSX and CSV exports contain
- [`docs/RUNNING-A-SESSION.md`](docs/RUNNING-A-SESSION.md) — in-session controls and troubleshooting
- [`SECURITY.md`](SECURITY.md) — threat model and reporting
- [`CHANGELOG.md`](CHANGELOG.md) — release history

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the full guide. Run these before you open a pull request:

```bash
pnpm install --frozen-lockfile
pnpm audit --prod --audit-level=high
pnpm test
```

A [`justfile`](justfile) wraps the common ones — `just setup`, `just test`, `just run`. There is also a 50-player stress run, `pnpm stress`.

The [`Test` workflow](.github/workflows/test.yml) defines the same three commands across Node 18, 20, 22 and 24, plus a Trivy container scan. **It is currently disabled, so nothing runs automatically on push or pull request** — please run the commands locally until it is switched back on.

## Licence

MIT — see [`LICENSE`](LICENSE). Use it, fork it, ship it.

> **Not affiliated with, or endorsed by, the rights holders of *Who Wants to Be a Millionaire?*** The gameplay format is inspired by the show (ITV / Sony Pictures Television); this implementation is original and shares no code or assets with it.
