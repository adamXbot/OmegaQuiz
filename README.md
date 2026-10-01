<div align="center">

# OmegaQuiz

[![Project status](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FadamXbot%2F.github%2Fmain%2Fbadges%2FOmegaQuiz.json)](https://github.com/adamXbot/.github/blob/main/STATUS.md#omegaquiz)
[![Licence](https://img.shields.io/github/license/adamXbot/OmegaQuiz?label=licence)](LICENSE)

A live, game-show-style quiz for staff training.<br>
Phones are the buzzers, a projector is the board, you run it from a laptop,<br>
and you get a spreadsheet of every answer at the end.

</div>

<!-- disclosure:start -->
> [!WARNING]
> **Pre-1.0 — no stable release yet.** Anything can change in any release, including a patch: APIs, CLI flags, config keys, file formats, and data already on disk. Keep your own backups.
> **Project status.** The badge above is generated from [the adamXbot status list](https://github.com/adamXbot/.github/blob/main/STATUS.md), which says what I promise for this project and every other one.
<!-- disclosure:end -->

## Getting started

You need a laptop with **Node 22.13 or newer** and **pnpm**, a room with Wi-Fi,
and phones that can reach the laptop. Install it, start it, and open the admin
page:

```bash
git clone https://github.com/adamXbot/OmegaQuiz.git
cd OmegaQuiz
npm install -g pnpm              # any recent pnpm; it switches itself to the pinned version
pnpm install --frozen-lockfile
pnpm start
```

The terminal prints two sign-in links, one for the **admin** page and one for
the **board**. Open the admin link, press **Sign in**, and load a sample pack
from **Questions → Browse sample packs**. Open the board link on the projector
laptop, and have a phone on the same Wi-Fi scan the QR code it shows. That is
a complete session, end to end, in a few minutes.

Choose what you want to do next:

| I want to… | Next step |
| --- | --- |
| Run a session for my team | [How a session runs](#how-a-session-runs), then [Running the game](#running-the-game). |
| Use my own questions | [Questions and packs](#questions-and-packs), or [`docs/QUESTIONS.md`](docs/QUESTIONS.md) for the file format. |
| Put it on a server people can reach | [Hosting it](#hosting-it), or the full runbook in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md). |
| See who answered what | [Reports and past games](#reports-and-past-games). |
| Make it look like ours | [Branding and settings](#branding-and-settings). |

## Explore the app

| Section | What you can do |
| --- | --- |
| [How a session runs](#how-a-session-runs) | The flow of a session, and the four screens it uses. |
| [Questions and packs](#questions-and-packs) | Load sample packs, write your own, preview them, keep several sets. |
| [Running the game](#running-the-game) | Timer, lifelines, stopping or rewinding, the presenter view and a clicker. |
| [Reports and past games](#reports-and-past-games) | Excel and CSV results, and every game kept on the server. |
| [Signing in and keys](#signing-in-and-keys) | Magic links that survive mail scanners, sign-ins that last, recovery tokens. |
| [Branding and settings](#branding-and-settings) | Company name, colours, presentation style, what players agree to. |
| [Hosting it](#hosting-it) | What it needs, where it runs, what it stores. |
| [Troubleshooting](#troubleshooting) | The things that go wrong in a real room, and the fix for each. |
| [Commands and configuration](#commands-and-configuration) | Every command and environment variable. |

Nothing leaves your server: there is no database, no third-party service and
no telemetry. One Node process runs one game at a time and keeps its data in
one folder on disk.

## How a session runs

A session is 10 to 15 questions for a room of 5 to 100 people. Everyone starts
in the race; a wrong answer (or no answer) knocks you out of the prize race,
but you can keep answering for the engagement and accuracy stats. Whoever is
still in at the end wins; a tiebreaker round settles it if more than one
person is.

The flow on the day:

1. **Open the lobby.** The board shows a QR code, a six-digit join code and the address to type.
2. **People join** on their phones with their name and work email. Names appear on the board as they arrive.
3. **Start the game.** The first question goes to the board and every phone at once, with an optional countdown.
4. **Each question:** people tap an answer; the board shows how many have answered; you can offer a lifeline; when you are ready, **Close & Reveal** shows the right answer, how the room split, and the lesson behind it.
5. **Next question**, until the end, when the board runs a top-five ceremony and you download the results.

Four screens take part:

| Screen | Address | Who looks at it |
| --- | --- | --- |
| **Player** | `/` | Each person's phone. Join, answer, see the lesson, see their own result. |
| **Board** | `/host` | The projector. Question, answers, timer ring, survivor count, prize ladder, the reveal and the ceremony. |
| **Presenter** | `/present` | The facilitator's laptop while the board is on the projector. The answer and notes you do not want on the big screen, what comes next, who is still to answer, the controls. |
| **Admin** | `/admin` | The control room: players, questions, past games, branding, settings, event log. Sign in as admin and you can open the other three too. |

## Questions and packs

The app starts empty. Fill the bank in any of these ways:

- **Browse sample packs.** Three come bundled in [`samples/`](samples): a ten-question phishing-awareness round with five tiebreakers, plus shorter nature and pop-culture packs for a demo.
- **Import a CSV or JSON file.** Download the template from Admin → Questions, fill it in a spreadsheet, import it. JSON packs use the same format as the bundled ones, so a pack downloaded from GitHub loads as-is.
- **Type them in.** The editor has a card per question: the question, four options with the right one ticked, the lesson shown at the reveal, an optional image, a time limit, and presenter notes that only you see.
- **Seed from a URL** at deploy time, for a server that should come up with questions already in it.

Every card has a **Preview** button, and **Preview all** walks through the set,
showing the real board and the real presenter view at projector size. It says
whether a question fits at full size, had to shrink, or does not fit even at
60%, so a long lesson or a big image is never a surprise on the day. The editor
warns under a card when something is long.

**Packs** keep several sets on the server. Save the current bank as a named
pack, load another (it asks whether to switch the quiz title and tagline too),
and **Clear all questions** when you want a clean slate. Before a load or a
clear replaces the bank, the old bank is kept as an automatic snapshot in the
same list, so neither can lose anything. Questions can only be changed while
the lobby is open or after a game ends.

[`docs/QUESTIONS.md`](docs/QUESTIONS.md) has the file format, the rules the
editor applies, and the limits.

## Running the game

**Timer.** Each question stays open for a set number of seconds (45 by default,
per question if you like). The board draws a ring, phones a bar, and the last
five seconds go red. When time is up, answers lock, but nothing is revealed
until you press **Close & Reveal**, so you can talk the room through it first.

**Lifelines.** 50/50 removes two wrong answers, **Ask IT** shows a hint, **Skip**
reveals without scoring. Apply one yourself, or open a vote and let the phones
decide. Each is one-shot by default; a setting refills them every question or
at the tiebreaker.

**Stopping or rewinding.** From any question, reveal or the results screen:
**Back to lobby, keep players** sends everyone to the lobby with the same join
code, alive and on zero, so you can start over or swap the pack without sixty
people re-scanning. **Rewind to question N** re-asks a question and undoes the
scores and knock-outs from that point on. Both take two clicks, so a stray
click never ends a live game.

**Presenter view and clicker.** Open `/present` on the facilitator laptop with
the board on the projector as an extended display. It shows the current
question with the right answer ticked and the lesson before the reveal, your
notes for it, the live answer split, who has not answered, what comes next,
and the controls. A presentation clicker (Logitech, Verbatim and most others)
drives it: forward starts, closes and reveals, or moves on; back looks at past
reveals on your screen only.

**Sounds and theatre.** Standard mode changes questions instantly with short
cues on the board. Dramatic mode adds a suspense sting, a staged option reveal,
a drum-roll before the answer and sounds on the phones. Each screen has a
speaker button, which you can hide from the settings; **M** mutes the board
either way.

[`docs/RUNNING-A-SESSION.md`](docs/RUNNING-A-SESSION.md) covers all of this
in detail, including dropped phones and restarts.

## Reports and past games

**Download results** at the end of a game (or any time from Admin → Players)
as **Excel** or **CSV**: one row per player with their score, whether they
survived, and their answer and result for every question. The Excel file is
colour-coded so a printout is scannable. CSV exports escape anything that a
spreadsheet might try to run as a formula.

Every game is also kept in Admin → **Sessions**: when it ran, who played, who
won, and a record of every answer and the questions asked. From there you can
view the standings and a per-question breakdown, download the same Excel or
CSV, load that game's questions to run them again, rename, or delete. Games
stopped part-way are kept too, marked *abandoned*. Turn recording off in
Branding if nothing should be kept.

[`docs/REPORTS.md`](docs/REPORTS.md) lists every column and suggests a pass
mark for training records.

## Signing in and keys

There are no accounts and no passwords to manage. Two roles exist: **host**
runs the game and opens the board and presenter view; **admin** does
everything.

**Magic links** are the day-to-day way in. The boot banner prints one for each
role, and Admin → Settings → **Sign-in & keys** mints more. Opening a link
shows a page with a **Sign in** button; only that button signs the device in,
so mail scanners and chat previews that fetch the link cannot use it up. A link
is single-use and valid for an hour unless you choose otherwise: pick 10 minutes
to 7 days, make it **reusable until it expires** to send a co-presenter, or let
them scan the QR shown next to it. **Revoke all links** stops every unused one.

A sign-in lasts a week and extends every time you use it, and it survives a
restart or a redeploy, so the facilitator laptop stays signed in between
rehearsal and the event.

**Recovery tokens** (`HOST_TOKEN`, `ADMIN_TOKEN`) are the long-lived fallback
for the form at `/auth/login`, for when every link has expired. Keep them in a
password manager. Lost one? Rotate it from Settings, or with
`node server.js remint <role>` on the server, without a restart and without
signing anyone out.

## Branding and settings

Admin → **Branding** sets what people see: company name and logo, quiz title
and tagline, the colour theme, the prize ladder (money or plain levels), and
whether names are shown at the end. You can restrict joining to your company's
email domain, write the privacy notice players agree to when they join, and
add a call to action to the final screen ("Book time with IT").

The same page holds the game rules: the question timer, lifeline refills,
whether answers lock in on the first tap or need a confirm, whether eliminated
players can keep answering, the presentation style, the speaker buttons, and
whether games are recorded. Everything here can also be set with an
environment variable for a server that should come up configured; see
[`.env.example`](.env.example).

## Hosting it

For a room on one Wi-Fi network, the laptop running `pnpm start` is enough:
phones use `http://<your-laptop-ip>:3000`. Set **Public server URL** in
Branding to that address so the QR code and the board print it.

To host it on the internet it needs a long-lived process and a writable disk:
**Railway, Render, Fly.io, DigitalOcean App Platform and Docker** all work.
Vercel, Netlify and Cloudflare Pages will not, because serverless functions
cannot hold a WebSocket connection or persistent storage.
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) is the runbook: secrets, volumes,
Cloudflare, checking it is healthy, and tearing down after an event.

Everything it keeps lives in one data folder (`DATA_DIR`, `./data` by default):
the question bank and saved packs, branding, the current join code, past
games, sign-ins, and (optionally) the generated secrets. Back that folder up
and you have backed up the app. Delete it and you have a fresh install.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Phones scan the QR and cannot connect | The QR encodes an address the phones cannot reach. Set **Public server URL** in Branding to one they can, and the board prints it beside the QR. |
| A sign-in link says it has expired or been used | Mint another in Settings → Sign-in & keys (a reusable one if you are sharing it), or use the recovery form at `/auth/login`. |
| The board shows `----` for the join code | No game state is arriving. Usually a proxy that does not pass WebSockets (on Cloudflare, switch WebSockets on), or an old sign-in. Reload; if it persists, check the proxy. |
| Someone dropped mid-question | Their phone rejoins its own seat by itself when it is back on screen. Questions closed while it was away count as unanswered. |
| Started too early, or need a do-over | **Back to lobby, keep players** or **Rewind to question N** in Admin → Overview or the presenter view. |
| Wrong person knocked out, or a scoring dispute | Admin → Players: **Eliminate** / **Revive**, or edit the score in that row. |

The full table, with the error messages players see on their phones and what
each one means, is in
[`docs/RUNNING-A-SESSION.md`](docs/RUNNING-A-SESSION.md#troubleshooting).

## Commands and configuration

| Command | What it's for |
| --- | --- |
| `pnpm start` | Run the server (port 3000 unless `PORT` is set). |
| `pnpm test` | Run the test suite against a live in-process server. |
| `pnpm stress` | A 50-player load run. |
| `node server.js --seed-url <URL>` | Start with a question bank fetched from a JSON or CSV URL, if the bank is empty. |
| `node server.js links [admin\|host\|all] [--hours N] [--reusable]` | Mint fresh sign-in links from a shell on the server; the running server honours them. |
| `node server.js remint <admin\|host\|all>` | Rotate a recovery token in place, no restart. |
| `just setup` / `just test` / `just run` / `just deploy` | The same, wrapped by a [`justfile`](justfile). |

Environment variables are documented in [`.env.example`](.env.example). The
ones most people set:

| Variable | What it does |
| --- | --- |
| `HOST_TOKEN`, `ADMIN_TOKEN`, `COOKIE_SECRET` | The three secrets. Required in production, or set `AUTO_PROVISION_SECRETS=true` and the server generates and stores them on first boot. |
| `PUBLIC_BASE_URL` | The address phones use; drives the QR code, the board and the sign-in links. |
| `DATA_DIR` | Where everything is kept (`./data`). |
| `QUESTION_SECONDS`, `LIFELINE_REFILL`, `PRESENTATION_STYLE` | Game rules, as first-boot defaults for what Branding sets. |
| `SESSION_TTL_HOURS` | How long a sign-in lasts (168). |
| `RECORD_SESSIONS` | Whether games are kept in the Sessions tab (`true`). |
| `TRUST_PROXY` | How many proxy hops to trust for client addresses, behind Cloudflare or a platform router. |

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the full guide, including what is in
and out of scope. The whole app is one Node file and three plain HTML pages
on purpose: no framework, no build step, no database. Run these before you
open a pull request:

```bash
pnpm install --frozen-lockfile
pnpm audit --prod --audit-level=high
pnpm test
```

The [`Test` workflow](.github/workflows/test.yml) runs the same three commands
on Node 22, 24 and 26 for every push and pull request, plus a Trivy scan of the
Docker image, and repeats them nightly so advisory drift in pinned
dependencies surfaces between PRs. Security reports go through
[`SECURITY.md`](SECURITY.md); release history is in
[`CHANGELOG.md`](CHANGELOG.md).

## How this was built

OmegaQuiz was written with the assistance of **Claude** (Anthropic), working
alongside [@AdamXweb](https://github.com/AdamXweb). Every change was reviewed
by a human before it landed, and the app was run in front of a real room
before the features that came out of that were built.

Which commits are which is recorded in the history rather than asserted here:

| Author | |
| --- | --- |
| **`adamXbot`** | AI-assisted. Every one carries a `Co-Authored-By: Claude` trailer. |
| **`Adam Kostarelas`** | Adam. |

```bash
git log --format='%an'                        # who authored each commit
git log --format='%b' | grep Co-Authored-By   # which were AI-assisted
```

## Licence

[MIT](LICENSE). Use it, fork it, ship it.

> **Not affiliated with, or endorsed by, the rights holders of *Who Wants to Be a Millionaire?*** The gameplay format is inspired by the show (ITV / Sony Pictures Television); this implementation is original and shares no code or assets with it.
