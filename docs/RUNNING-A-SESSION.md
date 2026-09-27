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
| Someone dropped mid-question | Their phone slept, lost Wi-Fi or switched networks | The phone rejoins its own seat by itself when it comes back on screen, at any point in the game. If its screen stops changing, reload the page. Questions closed while they were away count as unanswered. |
| "That email is already playing on another device" | The same email is connected from another phone, tab or laptop, or a phone that dropped hasn't been timed out yet | Close the quiz on the other device, or wait a minute (silent connections are dropped within a minute) and join again. In the lobby a seat whose phone is offline is handed to the new device automatically. |
| "Too many join attempts from this network" | 30 wrong join codes in a minute from one network (everyone on the office Wi-Fi shares one address) | Phones on mobile data are unaffected, so have that phone switch off Wi-Fi and scan again. The block lifts after 5 minutes. Raise `JOIN_FAILURE_MAX` for very large rooms. Phones rejoining their own seat are never blocked. |
| "This network has reached its limit of new players for now" | 150 new players joined from one network within 10 minutes (the office Wi-Fi counts as one) | Set `JOINS_PER_ADDRESS_MAX` higher for very large rooms; **Reset game** also starts the count again. Rejoining phones are never counted. |
| "This device is already in the game" | That browser tab already holds a seat and tried to join again under another name | Use the seat it has, or open the quiz on another device for a second player. |
| Phones went back to the join form: "The facilitator started a new game" | **Reset game** was pressed | Everyone scans the QR on the board again. The board reloads its QR when the code changes. |
| Scoring dispute | — | Admin → Players → edit the score field in that player's row directly. |
| Wrong player eliminated | — | Admin → Players → **Eliminate** / **Revive** toggles their status. |
| Started the game too early | You need to let late-joiners in | Admin → Game Control → **← Return to Lobby**. Only available on Q1 with no eliminations yet. |
| Need to wrap up before everyone finishes | — | Admin → Session control → **Close session**. Rejects new joins and shows a goodbye screen with an optional follow-up call to action. |

## Dropped phones and restarts

A phone that drops (screen locked, Wi-Fi blip, switched to mobile data) rejoins its own seat by
itself as soon as it is back on screen, at any point in the game. The server pings every connection
every 30 seconds and drops any that stop answering, so Admin → Players shows who is really online
within about a minute.

`PLAYER_RECONNECT_WINDOW_SECONDS` (default 300, clamped to 30–900) only sets how long Admin lists a
dropped player as **Disconnected** before **Offline**. It no longer limits rejoining.

Each phone connection can send about 20 messages in a burst and 5 a second after that, far more than
anyone playing needs. A connection that keeps sending past that (a script, not a person) is
disconnected. The board and admin always get the newest state, even over a slow connection.

If the server restarts mid-session (a crash, a deploy, a Fly host move), the game in progress is
lost but the join code is not: it is kept in `DATA_DIR/game.json`. Phones re-register in the fresh
lobby by themselves. Sign in again (sign-ins live in memory), check the lobby count, and start again
from question 1. **Reset game** still issues a new code.
