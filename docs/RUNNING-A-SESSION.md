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

## Presenter view

`/present` (host or admin sign-in; Admin → Overview → **Open Presenter View**) is the facilitator's
screen while `/host` is on the projector as an extended display. It shows:

- **On the board now** — the current question and options with the correct answer ticked, the
  lesson before the reveal (labelled *shown at the reveal*), the live answer split, and the audience
  percentages once revealed. In the lobby: the join code and address, who has joined.
- **Presenter notes** — the notes for the current question (Admin → Questions → *Presenter notes*, or
  the `notes` column of the CSV). Notes only ever reach this page.
- **Controls** — Start, Close & Reveal, Next (named after what comes next), the lifelines and the
  player vote, Reset at the end (click twice).
- **Next up** — the next question with its answer and notes, the tiebreaker (marked *if more than one
  player is still in*), or the end of the game.
- **Still to answer** — who is still in and has not answered, offline players marked.
- The **Ask IT** hint appears here as well as on the board, so it can be read aloud.

The top bar shows the phase, the question number, how long the question has been open, the join
code, players still in, and the connection state.

## Presentation style and sounds

Admin → **Branding → Presentation** picks how much theatre the game puts on:

- **Standard** (default) — questions change instantly; the board plays short cues only when its
  speaker is on; phones stay silent.
- **Dramatic** — a suspense sting and a staged option reveal when a question lands on the board, a
  drum-roll (about 1.5 s) before the answer is shown, and tap / lock-in / result sounds with sweeping
  transitions on the phones. The phones hold the reveal for the same drum-roll, so nobody sees the
  answer before the board does.

Sounds are synthesised in the browser — nothing to download. Browsers only start audio after a
click, so in dramatic mode the **board** lobby shows **Turn on sound** next to Start Game until the
sound is on (the speaker icon in the corner does the same, and starts muted). **Phones** show
**Tap to turn on sound** in the lobby; otherwise the first tap on an answer unlocks it, and a
speaker button in the corner mutes it for that phone. Both pages honour the device's reduced-motion
setting for the animations.

## Running the questions

- **Joining.** The board prints the join address beside the QR code in large type: the same address
  the QR encodes (Admin → Branding → **Public server URL**, else `PUBLIC_BASE_URL`, else the address
  the board was opened on). Newest names appear first, so people can spot their own.
- **While a question is open.** Admin → Overview shows the correct answer and the lesson as a
  **Talking point**, the live answer split, and **Still to answer** — who is still in and has not
  answered yet, people online first, offline ones marked.
- **Lifeline votes.** While a vote is open, the admin's **Apply** buttons show each lifeline's votes
  so far with the leader marked; the board's **Apply Winner** applies the leader. The **Ask IT**
  pop-up closes itself when the answer is revealed.
- **The reveal.** The board shows how many people were knocked out and the lesson (**Why**) under the
  answers; every phone shows the same lesson under its answers.
- **Finding someone.** Admin → Players has a search box (name or email). During a game anyone offline
  is listed first.

## End of the game

The board's ceremony names the top five places from fifth up. Players on the same score share a
place and are named together ("Joint 4th place…", "And our joint winners are…"); a big tie
below the top place is left to the results list. With no survivors the results are titled **Top
Scores**. Download the results before starting again: Admin → Game Control → **Download results**
(or the Players tab). **Reset (New Game)** clears every player and score; it asks first on both
the board and the admin page.

### End-of-game actions

Every player's final screen has **View My Results** and **Email me my results** (which opens their
mail app with the per-question breakdown pre-filled). Admin → **Branding → End-of-game CTA** adds an
optional third button — a label and a link, for example *Book time with IT* pointing at a booking
page. The board's results screen spells the same link out for anyone who has put their phone away.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Players' phones cannot connect after scanning the QR | The QR encodes a URL the phones cannot reach | Admin → Branding → **Public server URL**. Set it to whatever the phones can actually reach, or set `PUBLIC_BASE_URL` on the server. The board prints the same address beside the QR. |
| The boot banner says `Questions: 0 main + 0 bonus` after a restart, though a pack was loaded | Before this release a saved bank with any question image loaded as empty after every restart | Update the server. On an older build, import the pack again after each restart. The boot log now names the file and the reason if a saved bank cannot be loaded. |
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
