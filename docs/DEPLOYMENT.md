# Deployment runbook

A short, opinionated guide for getting `omegaquiz` running on a real public host. The README has the full env-var reference and a per-provider table; this doc walks you through it end-to-end so a non-technical operator can succeed on the first try.

## Compatibility — read this first

| Target | Compatible? | Why |
|---|---|---|
| **Railway** | ✅ | WebSocket-native, persistent processes, mountable volumes. |
| **Render** | ✅ | `render.yaml` blueprint included; it declares the persistent disk at `/opt/render/project/src/data`. The free tier sleeps when idle, which is fine for occasional sessions but makes the first load slow. |
| **Fly.io** | ✅ | `fly.toml` included. Best for low-latency global hosting. |
| **DigitalOcean App Platform** | ✅ | Standard Node.js app spec works. Add persistent storage in the App spec; the entry-level tier is enough for this workload. |
| **Docker on a VPS / your own server** | ✅ | `Dockerfile` is the most flexible path. |
| **Vercel / Netlify / Cloudflare Pages** | ❌ **Do not deploy** | Serverless/edge platforms can't host this app. It's a long-lived stateful Node process with persistent WebSocket connections and a writable file-system volume; serverless function lifetimes can't satisfy that. Vercel's Edge Runtime supports WS but with execution-time caps unsuited to multi-minute training sessions. **Use Railway, Render, Fly.io, or Docker instead.** |

If you're shipping this internally and one of those platforms isn't on your menu, Docker on a small VPS ($5/mo) is the simplest fallback.

---

## Step 1 — Generate three secrets

Open a terminal anywhere with Node 22.13+ installed and run:

```bash
node -e "console.log('HOST_TOKEN='    + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('ADMIN_TOKEN='   + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('COOKIE_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
```

Save the three lines somewhere safe — a password manager is ideal. These are your **recovery tokens**. You only need them if every active magic link has expired. Lost one after deploy? See [Keys — lost, expired or compromised](#keys--lost-expired-or-compromised): both tokens can be re-minted on the running server without a restart.

> If you forget to set `HOST_TOKEN` and `ADMIN_TOKEN` when deploying with `NODE_ENV=production`, **the server refuses to start** and logs `FATAL: HOST_TOKEN and ADMIN_TOKEN must be set in production.` That's intentional — but it means a deploy will appear to "fail" if you skip this step. If your platform reports "container exited with code 1" or similar, this is almost always why. The exception is `AUTO_PROVISION_SECRETS=true` (the bundled `fly.toml` sets it): the server then generates any missing secret on first boot, stores it in `DATA_DIR/secrets.json` on the volume, and prints the generated tokens once in the boot log.

---

## Step 2 — Deploy

Pick the path that matches your platform.

### Railway

1. Click **New Project → Deploy from GitHub repo → omegaquiz**.
2. Under **Variables**, paste the three values from Step 1, plus `NODE_ENV=production`.
3. Under **Settings → Networking**, **Generate Domain** (or attach a custom one).
4. Under **Settings → Volumes**, add a 1 GB volume mounted at `/app/data`.
5. **Deploy**. Once green, click **View Logs** and look for the boot banner (Step 3).

### Render

1. **New + → Blueprint** → connect this repo. Render reads `render.yaml`.
2. When prompted, paste the three secrets from Step 1. Leave the other fields at their defaults.
3. **Apply**. Once green, click the service name → **Logs** to read the boot banner.

### Fly.io

The bundled `fly.toml` sets `AUTO_PROVISION_SECRETS=true`, so you can skip Step 1 entirely: on first boot the app generates `HOST_TOKEN`, `ADMIN_TOKEN` and `COOKIE_SECRET`, stores them in `/app/data/secrets.json` on the volume, and prints the two tokens once in the boot log. Tokens kept this way can be rotated later without a restart — see [Keys](#keys--lost-expired-or-compromised).

```bash
# One-time:
brew install flyctl                              # or: curl -L https://fly.io/install.sh | sh
fly auth login
fly launch --no-deploy --copy-config             # accept defaults; do not deploy yet
fly volumes create omegaquiz_data --size 1 --region <your-region>
fly deploy
fly logs                                         # boot banner: magic links + the generated tokens (save them)
```

Prefer to manage the secrets yourself? Set them before deploying and they take precedence over the file — but rotating one then means `fly secrets set`, which restarts the app:

```bash
fly secrets set HOST_TOKEN=... ADMIN_TOKEN=... COOKIE_SECRET=...
```

`PUBLIC_BASE_URL` lives in `fly.toml` under `[env]` — change it there if your app name or custom domain differs.

### Docker (self-host)

```bash
# Generate the secrets once and store them somewhere safe.
docker build -t omegaquiz .
docker run -d --name omegaquiz \
  -p 3000:3000 \
  -e HOST_TOKEN=...    \
  -e ADMIN_TOKEN=...   \
  -e COOKIE_SECRET=... \
  -e PUBLIC_BASE_URL=https://quiz.yourdomain.com \
  -v omegaquiz-data:/app/data \
  omegaquiz
docker logs -f omegaquiz
```

Putting this behind Cloudflare (orange-cloud, with WAF + rate-limit rules on `/auth/login` and `/player:join`) is the recommended public-facing posture.

### Cloudflare setup

You get free TLS, DDoS protection, optional Access SSO on `/admin`, and edge rate-limiting on the
join endpoint.

1. DNS: an `A` or `CNAME` record for `quiz.your-domain.com` pointing at your origin, orange-cloud
   proxied.
2. Set `PUBLIC_BASE_URL=https://quiz.your-domain.com` on the origin so QR codes and magic links
   carry the public hostname.
3. Cloudflare Access (free tier) → a policy on `/admin` requiring your corporate IdP. This means
   that even if the admin token leaks, an attacker still needs SSO.
4. Cloudflare Rate Limiting → 10 requests per minute per IP on `/auth/login`, enforced at the edge
   before any traffic reaches your app.

The app's CSP works through the Cloudflare proxy with no changes, **provided you disable Rocket
Loader and Email Obfuscation** for this hostname (dashboard → Speed → Optimization → Content
Optimization). Both inject scripts that the CSP nonce policy will block.

---

## Step 3 — Find your sign-in links

When the server starts you'll see a boot banner like this in the logs:

```
========================================
 Omega Quiz running on port 3000
 Public URL:  https://quiz.example.com    (source: PUBLIC_BASE_URL env var)
 Player URL:  https://quiz.example.com/
 Join code:   8642
 Questions:   0 main + 0 bonus   (empty — import a CSV or load samples from the admin Questions tab)

 ──  Sign in  ─────────────────────────
 Click one of these magic links from your terminal (single-use, 10 min):
    Host  →  https://quiz.example.com/auth/magic?t=mhc_aBcDeF…
    Admin →  https://quiz.example.com/auth/magic?t=mhc_xYz123…

 Recovery sign-in (only needed if all magic links have expired):
    https://quiz.example.com/auth/login?role=host    — enter HOST_TOKEN
    https://quiz.example.com/auth/login?role=admin   — enter ADMIN_TOKEN
========================================
```

1. Click the **Admin** magic link in a fresh browser tab (your facilitator laptop). It signs you in and lands on the admin dashboard.
2. Click the **Host** magic link on the projector laptop (full-screen, F11).
3. Both links are single-use and expire after 10 minutes. If they expire before you click, sign in via `/auth/login?role=...` and enter the recovery token from Step 1.

If the boot banner never appeared, see [Common failures](#common-failures) below.

---

## Keys — lost, expired or compromised

Two kinds of credential exist, and each has an in-place fix — no redeploy, no restart, nobody gets signed out:

| Situation | Do this |
|---|---|
| A magic link expired before you clicked it | Already signed in as admin? **Settings → Sign-in & keys → New host / admin link.** Otherwise mint one on the server (below). |
| You need to sign in another device (a replacement projector laptop, a co-facilitator) | Admin → **Settings → Sign-in & keys → New host link / New admin link**, then open the link on that device. |
| You lost a recovery token, or it may have leaked | Admin → **Settings → Sign-in & keys → Rotate token**. The old value stops working immediately; the new one is shown once. |
| You are locked out completely (links expired, tokens lost) | Run `links` on the server — it prints fresh magic links that the running server honours on first click. |

The two server commands run **on the machine**, next to the live process, because they work through the data directory it already reads:

```bash
# Fly.io
fly ssh console -C "node /app/server.js links"          # fresh magic links, printed in your terminal
fly ssh console -C "node /app/server.js remint admin"   # new ADMIN_TOKEN  (host | admin | all)

# Docker
docker exec omegaquiz node server.js links
docker exec omegaquiz node server.js remint host

# Bare metal, Railway shell, Render shell
node server.js links
node server.js remint all
```

`just fly-links` and `just fly-remint admin` wrap the Fly versions. If `remint` replies that tokens are *regenerated on every boot*, the shell did not inherit the app’s environment — prefix the command with `AUTO_PROVISION_SECRETS=true` (and `DATA_DIR=/app/data` if you changed it).

How it works: `remint` rewrites `secrets.json` (atomically, mode 0600) and the running server re-reads that file the next time someone submits the recovery form. `links` writes single-use tokens to `signin-links.json`; the server imports the file the moment one of them is clicked, then deletes it. Nothing else moves: `COOKIE_SECRET` stays put, sessions stay valid, players stay connected. When a root shell runs the command (as `fly ssh console` does) it switches to the owner of the data directory first, so the server can still read what it wrote.

Two limits, both deliberate:

- **Tokens set as environment variables win over the file.** If you manage `HOST_TOKEN` / `ADMIN_TOKEN` with `fly secrets set` (or `-e` in Docker), `remint` refuses and prints a ready-to-paste replacement instead — apply it with `fly secrets set ADMIN_TOKEN=…`, which restarts the app. Rotating an env-managed token in memory would silently undo itself on the next boot, so the tool won't.
- **Rotating does not sign anyone out.** Sessions live in memory; if you need every device out (say the admin laptop was stolen), rotate the token *and* restart (**Settings → Developer options → Restart server**, or `fly machine restart`).

Magic links printed by `links` or the boot banner are single-use and expire after 10 minutes, so their appearance in `fly logs` or your terminal history is harmless once clicked. Anyone with shell access to the machine could mint them anyway — the same people who can read `secrets.json`.

---

## Step 4 — Load questions and brand the session

In the admin tab:

- **Questions tab → Browse sample packs** loads a curated phishing / nature / pop-culture pack. Or **Import CSV / JSON** for your own bank — download the CSV template first, or download one of the [`samples/*.json`](../samples) packs from GitHub and import it as-is.
- **Branding tab** — set company name, email domain (with optional join restriction), logo, tagline, and the **Privacy notice** that appears on the player join screen.
- The Privacy notice ships with an Australian-Privacy-Act–compatible default. **Rewrite it for your jurisdiction** before sharing the join URL publicly.

---

## Step 5 — Verify it's healthy

`GET /health` returns 200 with JSON when the server is ready, 503 when it's shutting down. PaaS health checks (Render, Fly) are already wired to it. To smoke-test manually:

```bash
curl https://your-public-url/health
# {"ok":true,"uptimeSec":42,"questionsLoaded":10,...}
```

---

## After the event — tear down

This is event-driven software. The recommended posture is:

1. **Export results** — admin → Players tab → "Download Results XLSX".
2. **Wipe data** — admin → Settings tab → "Maintenance — Export & Wipe Data". Type `WIPE DATA` to confirm. The action downloads a final XLSX snapshot, deletes `data/config.json` + `data/questions.json` from the server, and resets the in-memory state.
3. **Scale the service to zero** between events (Railway / Render / Fly all support this with one click) **or** stop the Docker container.
4. **Rotate `HOST_TOKEN` and `ADMIN_TOKEN`** after each event — they're recovery tokens, not permanent passwords. `node server.js remint all` on the server (or Admin → Settings → Sign-in & keys) does it in place.

### Why bother — the threat model

There's **no good reason for this to be reachable on the public internet 24/7** between training
sessions. The join code is short and, while rate-limited, not impossible to guess, and PII
accumulates in `data/` over time. Scaling to zero is the real off-switch; the in-app **Session
control → Close session** button rejects new joins and shows a goodbye screen, but it does not take
the process off the network.

Treat this like a pop-up shop, not a permanent storefront.

---

## Common failures

| Symptom | Likely cause | Fix |
|---|---|---|
| Deployment "succeeds" but `/` returns no response and logs show `FATAL: HOST_TOKEN and ADMIN_TOKEN must be set in production` | You forgot Step 1, or didn't paste the secrets into the platform UI before deploying. | Set the env vars on the platform, redeploy. |
| Boot banner appears but `Public URL` is `http://localhost:3000` | `PUBLIC_BASE_URL` not set. | Add `PUBLIC_BASE_URL=https://your-domain.example.com` as a platform env var, or set it via admin → Branding → Public server URL. Then the QR code and magic links will use the right host. |
| Magic link returns `error=1` on click | Token already used / expired (10-min TTL) / server restarted since the boot banner. | Use the recovery URL — `/auth/login?role=admin` + your `ADMIN_TOKEN` — or mint a fresh link on the server: `fly ssh console -C "node /app/server.js links"` (see [Keys](#keys--lost-expired-or-compromised)). |
| `/health` returns 503 | Server is mid-shutdown. | Wait 30s, retry. If it persists, check logs for `uncaughtException` or `unhandledRejection`. |
| Player phones show "Wrong join code" but the code on the projector matches | A reset-game rotated the join code. Players need the QR or 6-digit code that's currently on the projector. | — |
| Player phones show "Too many join attempts from this network" | Rate-limit guard kicked in (8 wrong codes / 60s from one IP, 5-minute cooldown). | Wait 5 minutes. If a corporate NAT puts everyone on one IP, expect this when a lot of players type the code wrong simultaneously — bump the rate-limit constants in `server.js` for high-NAT environments. |
| Behind Cloudflare: scripts blocked, page broken | Cloudflare Rocket Loader injected a script the CSP refuses. | Cloudflare dashboard → Speed → Optimization → turn **Rocket Loader** off for this hostname. |
| Behind Cloudflare: WebSocket disconnects every 100s | Cloudflare default WS idle timeout. | Players will auto-reconnect; the host/admin pages now do too. Or upgrade to a Cloudflare plan with higher limits. |
| First boot: data/questions.json missing | Expected — a fresh deploy boots with an empty bank. | Admin → Questions tab → Browse sample packs or Import CSV / JSON. |
| **Browse sample packs** shows `bundled sample "manifest.json" is missing from this deployment` (older builds instead sat on "Loading…" forever) | The container image was built without the `samples/` directory. The boot banner prints a `Samples: NOT FOUND` line when this is the case. | Rebuild from a Dockerfile that includes `COPY samples ./samples` (the repo's Dockerfile does; older forks may not) and redeploy, e.g. `fly deploy`. Or set `SAMPLE_PACKS_URL` to a hosted manifest. **Import CSV / JSON** works regardless. |
