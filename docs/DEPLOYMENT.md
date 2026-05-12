# Deployment runbook

A short, opinionated guide for getting `omegaquiz` running on a real public host. The README has the full env-var reference and a per-provider table; this doc walks you through it end-to-end so a non-technical operator can succeed on the first try.

## Compatibility — read this first

| Target | Compatible? | Why |
|---|---|---|
| **Railway** | ✅ | WebSocket-native, persistent processes, mountable volumes. |
| **Render** | ✅ | `render.yaml` blueprint included. Persistent disk supported. |
| **Fly.io** | ✅ | `fly.toml` included. Best for low-latency global hosting. |
| **DigitalOcean App Platform** | ✅ | Standard Node.js app spec works. |
| **Docker on a VPS / your own server** | ✅ | `Dockerfile` is the most flexible path. |
| **Vercel / Netlify / Cloudflare Pages** | ❌ **Do not deploy** | Serverless/edge platforms can't host this app. It's a long-lived stateful Node process with persistent WebSocket connections and a writable file-system volume; serverless function lifetimes can't satisfy that. Vercel's Edge Runtime supports WS but with execution-time caps unsuited to multi-minute training sessions. **Use Railway, Render, Fly.io, or Docker instead.** |

If you're shipping this internally and one of those platforms isn't on your menu, Docker on a small VPS ($5/mo) is the simplest fallback.

---

## Step 1 — Generate three secrets

Open a terminal anywhere with Node 18+ installed and run:

```bash
node -e "console.log('HOST_TOKEN='    + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('ADMIN_TOKEN='   + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('COOKIE_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
```

Save the three lines somewhere safe — a password manager is ideal. These are your **recovery tokens**. You only need them if every active magic link has expired, but you cannot regenerate them after deploy without restarting the server and rotating sessions.

> If you forget to set `HOST_TOKEN` and `ADMIN_TOKEN` when deploying with `NODE_ENV=production`, **the server refuses to start** and logs `FATAL: HOST_TOKEN and ADMIN_TOKEN must be set in production.` That's intentional — but it means a deploy will appear to "fail" if you skip this step. If your platform reports "container exited with code 1" or similar, this is almost always why.

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

```bash
# One-time:
brew install flyctl                              # or: curl -L https://fly.io/install.sh | sh
fly auth login
fly launch --no-deploy --copy-config             # accept defaults; do not deploy yet
fly volumes create omegaquiz_data --size 1 --region <your-region>
fly secrets set HOST_TOKEN=... ADMIN_TOKEN=... COOKIE_SECRET=...
fly secrets set PUBLIC_BASE_URL=https://<your-app>.fly.dev
fly deploy
fly logs                                         # watch the boot banner
```

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

## Step 4 — Load questions and brand the session

In the admin tab:

- **Questions tab → Browse sample packs** loads a curated phishing / nature / pop-culture pack. Or **Import CSV** for your own bank (download the template first).
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
4. **Rotate `HOST_TOKEN` and `ADMIN_TOKEN`** after each event — they're recovery tokens, not permanent passwords.

The README's "operational hygiene" section explains the threat model in more detail.

---

## Common failures

| Symptom | Likely cause | Fix |
|---|---|---|
| Deployment "succeeds" but `/` returns no response and logs show `FATAL: HOST_TOKEN and ADMIN_TOKEN must be set in production` | You forgot Step 1, or didn't paste the secrets into the platform UI before deploying. | Set the env vars on the platform, redeploy. |
| Boot banner appears but `Public URL` is `http://localhost:3000` | `PUBLIC_BASE_URL` not set. | Add `PUBLIC_BASE_URL=https://your-domain.example.com` as a platform env var, or set it via admin → Branding → Public server URL. Then the QR code and magic links will use the right host. |
| Magic link returns `error=1` on click | Token already used / expired (10-min TTL) / server restarted since the boot banner. | Use the recovery URL — `/auth/login?role=admin` + the `ADMIN_TOKEN` from Step 1. |
| `/health` returns 503 | Server is mid-shutdown. | Wait 30s, retry. If it persists, check logs for `uncaughtException` or `unhandledRejection`. |
| Player phones show "Wrong join code" but the code on the projector matches | A reset-game rotated the join code. Players need the QR or 6-digit code that's currently on the projector. | — |
| Player phones show "Too many join attempts from this network" | Rate-limit guard kicked in (8 wrong codes / 60s from one IP, 5-minute cooldown). | Wait 5 minutes. If a corporate NAT puts everyone on one IP, expect this when a lot of players type the code wrong simultaneously — bump the rate-limit constants in `server.js` for high-NAT environments. |
| Behind Cloudflare: scripts blocked, page broken | Cloudflare Rocket Loader injected a script the CSP refuses. | Cloudflare dashboard → Speed → Optimization → turn **Rocket Loader** off for this hostname. |
| Behind Cloudflare: WebSocket disconnects every 100s | Cloudflare default WS idle timeout. | Players will auto-reconnect; the host/admin pages now do too. Or upgrade to a Cloudflare plan with higher limits. |
| First boot: data/questions.json missing | Expected — a fresh deploy boots with an empty bank. | Admin → Questions tab → Browse sample packs or Import CSV. |
