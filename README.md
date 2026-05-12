# OmegaQuiz

A self-hosted, multi-device, live quiz built for in-house staff training. You run a 10–15 question session in a room of 5–100 people; their phones are the buzzers, a projector is the game board, and you get an Excel report at the end with every answer and a pass/fail summary.

---

## What it does

Three screens, one game:

| Screen | Where it runs | Who uses it | What it shows |
|---|---|---|---|
| **Player** (`/`) | Each staff member's phone | Players | Joins via QR code, taps A/B/C/D for each question, sees their own correct count at the end |
| **Host** (`/host`) | Boardroom projector / TV | Whoever's running the quiz | The big board: question, answer choices, survivor count, prize ladder |
| **Admin** (`/admin`) | Facilitator's laptop / tablet | You (or whoever moderates) | Roster, live answer tally, question editor, branding, Excel/CSV report download, session close / reopen |

A session goes: open the lobby on the projector → staff scan the QR and join with name + work email → admin clicks **Start Game** → for each question, host clicks **Close & Reveal** once everyone's answered → at the end, admin downloads the results spreadsheet.

Wrong answer = eliminated from the prize race, but the player can keep answering for engagement and accuracy stats. Optional **50:50 / Ask IT / Skip** lifelines if the room votes for them.

There's no database, no third-party SaaS, no telemetry. One Node process, one game at a time, one folder of data on disk.

---

## How to add questions

The app boots **empty** — first thing you do after signing in is load some questions. Three ways, pick whichever fits how your content authors work:

### 1. Bundled sample pack (1 click, for first run / demos)

Admin → **Questions** tab → **Browse sample packs** → pick the bundled phishing-awareness pack. Drops in 10 main questions + 5 bonus tiebreakers covering look-alike domains, BEC, smishing, MFA, and post-click response.

### 2. Excel / CSV import (recommended for most authors)

Admin → **Questions** tab → **Download template** (gives you `omegaquiz-template.csv`) → fill it in in Excel → drag the saved file onto **Import CSV**.

The columns are:

| Column | What it is |
|---|---|
| `section` | `main` for the regular round, `bonus` for sudden-death tiebreaker questions |
| `question` | The question text. Limited HTML allowed: `<em>`, `<br>`, `<span class="mono">` |
| `optionA` … `optionD` | The four answer choices |
| `correct` | The index of the correct answer (0 = A, 1 = B, 2 = C, 3 = D) |
| `lesson` | What players see at the end and on the post-game recap. Usually 1–2 sentences explaining why the right answer is right. |

A row looks like:

```csv
section,question,optionA,optionB,optionC,optionD,correct,lesson
main,An email from support@paypa1.com asks you to verify your account. What's the red flag?,Polite tone,Look-alike domain (paypa1 vs paypal),HTTPS link,No attachment,1,"Look-alike domains swap visually similar characters (1 for l). Always check the sender domain character-by-character."
```

The default round is 10 main questions + 5 bonus. The bonus questions only kick in if multiple players are tied at the end.

### 3. Type them in the admin UI

Admin → **Questions** tab → **Add a question manually**. Useful for small edits between sessions, less useful if you have a content author writing the bank.

### 4. Auto-load from a URL on first boot (deployment-time)

If you maintain a master question bank in a GitHub repo or on an internal share, point the server at it once and it'll seed the bank on first run only (without ever overwriting an existing one):

```bash
node server.js -u https://raw.githubusercontent.com/your-org/quiz-content/main/q1-2026-pack.json
# or via env var:
QUESTIONS_SEED_URL=https://raw.githubusercontent.com/your-org/quiz-content/main/q1-2026-pack.csv pnpm start
```

JSON shape: `{ "main": [...], "bonus": [...] }` where each item is `{ q, options, correct, lesson }`. CSV uses the same columns as the Excel template above.

### Editing rules

Questions can only be added/edited while the lobby is open or after a game has ended. Mid-game edits are blocked server-side to prevent tampering. The bank is sanitised on save — anything that looks like a script tag is escaped before it ever reaches the player's browser.

---

## How to host it

OmegaQuiz is a stateful Node.js + WebSocket app, so it needs to run somewhere that supports a long-lived process with a persistent file system. Pick one:

### Railway (fastest path)

The simplest hosted option:

1. Push this repo to your GitHub org.
2. In Railway, create a new service backed by the GitHub repo.
3. Add a **Volume** mounted at `/app/data` — without this, every redeploy wipes the question bank and branding.
4. Set these environment variables in the Variables tab:

   ```
   NODE_ENV       = production
   HOST_TOKEN     = <32 random bytes hex>
   ADMIN_TOKEN    = <32 random bytes hex>
   COOKIE_SECRET  = <32 random bytes hex>
   DATA_DIR       = /app/data
   ```

   Generate the random values with:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Run that three times, save each value in your password manager. They're recovery tokens you'll only need if the boot-time magic-link expires.
5. Set `PUBLIC_BASE_URL` to your Railway-assigned URL (or your custom domain — see Cloudflare below). This drives the QR code and magic-link URLs in the boot banner.
6. First deploy. Watch the deploy logs for the boot banner — it prints clickable magic-link URLs for the host and admin roles. Click the admin one in your terminal and you're signed in.

For a fuller Railway-specific runbook including healthchecks and the "scale to zero between events" workflow, see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

### Other supported platforms

| Provider | Persistence path | Notes |
|---|---|---|
| **Render** | 1 GB disk at `/opt/render/project/src/data` (`render.yaml` declares it) | Free tier sleeps when idle; fine for occasional sessions, slow first-load |
| **Fly.io** | `fly volumes create omegaquiz_data --size 1` then bound in `fly.toml` | Best for low-latency global hosting |
| **DigitalOcean App Platform** | Add persistent storage in the App spec | $5/mo basic tier covers easily |
| **Docker / self-host** | `docker run -v omegaquiz-data:/app/data ...` | Full control; use behind a TLS-terminating reverse proxy (nginx, Caddy, Traefik) |

**Do not use Vercel, Netlify, or Cloudflare Pages.** Serverless functions can't host a stateful WebSocket server with a writable disk.

### Behind Cloudflare (strongly recommended)

Put Cloudflare in front of whichever origin you deploy to. You get free TLS, DDoS protection, optional Access SSO on `/admin`, and edge rate-limiting on the join endpoint. Setup:

1. DNS: `A` or `CNAME` for `quiz.your-domain.com` → your origin, orange-cloud proxied.
2. Set `PUBLIC_BASE_URL=https://quiz.your-domain.com` on the origin so QR codes carry the public hostname.
3. Cloudflare Access (free tier) → policy on `/admin` requiring your corporate IdP. This means even if the admin token leaks, an attacker still needs SSO.
4. Cloudflare Rate Limiting → 10 requests per minute per IP on `/auth/login`; the edge enforces this before any traffic touches your app.

The app's CSP works through the Cloudflare proxy with no changes, **provided you disable Rocket Loader and Email Obfuscation** on this hostname (Cloudflare dashboard → Speed → Optimization → Content Optimization). Both inject scripts the CSP nonce policy will block.

### Local trial run

If you want to evaluate it before hosting it anywhere:

```bash
git clone <your-fork-url>
cd omegaquiz
corepack enable
pnpm install --frozen-lockfile
pnpm start
```

Open `http://localhost:3000`. The terminal prints magic-link URLs for the admin and host roles — click them in your terminal and they auto-sign-you-in. Test players from another phone on the same Wi-Fi by navigating to `http://<your-laptop-ip>:3000`.

### Sign in: how the tokens fit together

There are two ways to sign in to `/admin` and `/host`:

- **Magic link** — printed on the boot banner in your deploy logs every time the server starts. Single-use, 10-minute TTL. The intended day-to-day path.
- **Recovery token** — the `HOST_TOKEN` and `ADMIN_TOKEN` env vars. Long-lived. Only used if every magic link has expired and you need to bootstrap a new one. Treat them like password-manager entries, not like daily passwords.

Sessions are httpOnly cookies signed with `COOKIE_SECRET`. Set `COOKIE_SECRET` to a stable random value in production — otherwise every restart invalidates everyone's session.

### Operational hygiene: take it offline between events

OmegaQuiz is event-driven software. There's **no good reason for it to be reachable on the public internet 24/7** between training sessions. The join URL is technically guessable (6-digit code, rate-limited but not impossible), and PII accumulates in `data/` over time. Recommended pattern:

1. Scale to zero in your hosting dashboard 30 minutes after the event ends. The admin UI has a **Session control → Close session** button that does this from inside the app (rejects new joins, shows a goodbye screen with optional CTA), but the cloud-side scale-to-zero is the real off-switch.
2. Download the Excel report (see below) and delete `data/` after each event if your retention policy allows.
3. Rotate `HOST_TOKEN` and `ADMIN_TOKEN` after each event.

Treat this like a pop-up shop, not a permanent storefront.

---

## What kind of reports come out of it

Two downloads from the admin **Players** tab, both available once a game has ended (or any time the admin wants a snapshot mid-session):

### Excel — `omegaquiz-results.xlsx` (recommended)

One row per player. Cells are colour-coded so you can scan a printout: green for correct, red for wrong, amber for "no answer". The columns:

| Column | What it is |
|---|---|
| Name | Player's name as typed at join |
| Email | Player's work email |
| Score (in-race correct) | Number of questions they got right *while they were still in the prize race* |
| Total correct (all answers) | Includes any questions they answered after being eliminated (engagement metric) |
| Total answered | How many of the questions they actually responded to |
| Survived to End | Yes / No |
| Status | `WINNER / FINALIST`, `still alive`, or `eliminated` |
| Q1 answer, Q1 result | Their letter choice and the result (`correct`, `wrong`, `no answer`; appended `(eliminated)` if they answered after being knocked out) |
| Q2 answer, Q2 result | (one pair per main question) |
| … | |
| B1 answer, B1 result | One pair per bonus question (only present if a tiebreaker happened) |

The Excel file opens cleanly in Excel, Google Sheets, and Numbers. No macros, no formulas — just data and cell fills. It's the right deliverable for a manager who wants to see who passed and who needs a re-do.

### CSV — `omegaquiz-results.csv`

Same columns, no colours. Useful for:

- Importing into your LMS / training-records system
- Mail-merging certificates
- Any analytics workflow that prefers plain text

The CSV escapes leading `=`, `+`, `-`, and `@` characters with an apostrophe so a spreadsheet won't auto-evaluate any player-supplied content as a formula (CWE-1236 / Excel formula injection).

### What's NOT in the export

The reports are **answer history**, not session metadata. They don't include:

- Question text (load `omegaquiz-questions.csv` from Admin → Questions → Export CSV if you also want that)
- Timestamps per answer (the audit log inside the admin Event Log tab has those, but they're not exported)
- IP addresses or user-agent strings
- Lifeline usage

If you need any of those for compliance, raise an issue — they're straightforward to add.

### Reading the reports for training compliance

For "did Alex pass the cybersecurity refresher?" → look at the `Total correct (all answers)` column and your organisation's pass mark (we suggest ≥ 8/10 main + ≥ 60% bonus accuracy).

For "where are we weakest as a team?" → sort by `Q1 result`, `Q2 result`, etc. to see which questions had the most red cells. That tells you which topic to lean into at the next session.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Players' phones can't connect after scanning the QR | The QR encodes the wrong URL | Admin → Branding → **Public server URL**. Set it to whatever your phones can actually reach. |
| Magic link redirects to a sign-in error | Token already used, expired, or the server restarted | Restart minted a new one — check the new boot banner, or use `/auth/login?role=admin` with your recovery token. |
| "Please use your @yourdomain email address" | `Restrict joins to this domain` is on | Either uncheck it in Branding, or have the player use a corporate email. |
| Someone joined with a typo in their name | — | Admin → Players → **Kick**, ask them to rejoin. |
| Someone dropped mid-question | Their phone slept | They have ~30s to reconnect with the same email; admin can **Extend** the window. |
| Scoring dispute | — | Admin → Players → click their score → set manually. |
| Started Game too early | Need more late-joiners | Admin → Game Control → **← Return to Lobby** (only available on Q1 with no eliminations yet). |
| Need to wrap up before everyone finishes | — | Admin → Session control → **Close session** (rejects new joins, shows a goodbye screen with optional follow-up CTA). |

A more complete deployment runbook is in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md), security details in [`SECURITY.md`](SECURITY.md).

---

## License

MIT — see [`LICENSE`](./LICENSE). Use it, fork it, ship it. Format inspired by *Who Wants to Be a Millionaire?* (ITV / Sony Pictures Television); this implementation is original.
