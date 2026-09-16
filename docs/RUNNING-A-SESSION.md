# Running a session

In-session controls and the things that actually go wrong on the day. For hosting and deployment
problems, see [`DEPLOYMENT.md`](DEPLOYMENT.md).

## Signing in

There are two ways in to `/admin` and `/host`:

- **Magic link** — printed on the boot banner in your logs every time the server starts. Single-use,
  10-minute TTL. This is the intended day-to-day path.
- **Recovery token** — the `HOST_TOKEN` and `ADMIN_TOKEN` environment variables, used through the
  form at `/auth/login`. Long-lived, and only for bootstrapping a new magic link once every link has
  expired. Treat them like password-manager entries, not daily passwords.

Sessions are httpOnly cookies signed with `COOKIE_SECRET`. Set that to a stable random value in
production, otherwise every restart invalidates everyone's session.

An admin session opens `/host` as well, so one device signed in as admin can drive both screens
(useful when the projector is mirrored from the facilitator laptop). A separate host magic link is
only needed for a second machine.

## Presentation style and sounds

Admin → **Branding → Presentation** picks how much theatre the game puts on:

- **Standard** (default) — questions change instantly; the board plays short cues only when its
  speaker is on; phones stay silent.
- **Dramatic** — a suspense sting and a staged option reveal when a question lands on the board, a
  drum-roll (about 1.5 s) before the answer is shown, and tap / lock-in / result sounds with sweeping
  transitions on the phones. The phones hold the reveal for the same drum-roll, so nobody sees the
  answer before the board does.

Sounds are synthesised in the browser — nothing to download. Browsers only start audio after a
click, so: on the **board**, click the speaker icon once (it starts muted); on a **phone**, the first
tap on an answer unlocks sound, and a speaker button in the corner mutes it for that phone. Both
pages honour the device's reduced-motion setting for the animations.

## End-of-game actions

Every player's final screen has **View My Results** and **Email me my results** (which opens their
mail app with the per-question breakdown pre-filled). Admin → **Branding → End-of-game CTA** adds an
optional third button — a label and a link, for example *Book time with IT* pointing at a booking
page. The board's results screen spells the same link out for anyone who has put their phone away.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Players' phones cannot connect after scanning the QR | The QR encodes a URL the phones cannot reach | Admin → Branding → **Public server URL**. Set it to whatever the phones can actually reach, or set `PUBLIC_BASE_URL` on the server. |
| Magic link redirects to a sign-in error | Token already used, expired, or the server restarted | A restart mints a new one — check the latest boot banner, or use `/auth/login` with your recovery token. |
| Host board shows `----` for the join code and **Start Game** never enables, but the QR code renders | The page loaded over HTTP but no game state is arriving over the WebSocket. After a few seconds the board says so. Usually a proxy that does not pass WebSockets (Cloudflare: check **WebSockets** is on under Network), or a sign-in the server no longer recognises after a restart. | Reload the page; if it persists, check the proxy. Before v1.1.2 this also happened whenever `/host` was opened with the *admin* session — fixed, both sessions now drive the board. |
| "Please use your *example.com* email address" | **Only accept joins from this domain** is ticked in Branding | Either untick it, or have the player join with their company email. The domain itself is the **Company email domain** field. |
| Someone joined with a typo in their name | — | Admin → Players → **Kick**, then ask them to rejoin. |
| Someone dropped mid-question | Their phone slept or lost Wi-Fi | They can reconnect with the same email within the reconnect window — 5 minutes by default. Admin → Players → **Extend** resets that timer for a specific player. |
| Scoring dispute | — | Admin → Players → edit the score field in that player's row directly. |
| Wrong player eliminated | — | Admin → Players → **Eliminate** / **Revive** toggles their status. |
| Started the game too early | You need to let late-joiners in | Admin → Game Control → **← Return to Lobby**. Only available on Q1 with no eliminations yet. |
| Need to wrap up before everyone finishes | — | Admin → Session control → **Close session**. Rejects new joins and shows a goodbye screen with an optional follow-up call to action. |

## Tuning the reconnect window

The player reconnect window defaults to 300 seconds and is set with the
`PLAYER_RECONNECT_WINDOW_SECONDS` environment variable. Values are clamped to between 30 and 900
seconds. A longer window is friendlier on flaky venue Wi-Fi; a shorter one clears out genuine
drop-outs faster.
