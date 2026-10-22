# Deploying Blip (free tier)

| Part | Host | Plan | Why |
| --- | --- | --- | --- |
| Frontend (`frontend/`, Next.js 14) | Vercel | Hobby (free, **non-commercial only**) | Native Next.js support, HTTPS, CDN |
| Backend (`backend/`, Express + Socket.IO) | Render | Free web service | Long-running Node process with WebSocket support (serverless platforms would break Socket.IO) |
| Redis | Upstash | Free | TLS Redis that works with the existing `redis` client and TTL-based expiry |

Target cost: **₹0/month**. Limits at the time of writing (check the providers' pricing pages; they change):

- **Render Free**: spins down after 15 min without inbound traffic (open WebSocket traffic keeps it awake); ~1 min cold start; 750 instance-hours/month per workspace (enough for one always-on service); may restart at any time; filesystem is ephemeral.
- **Upstash Free**: 256 MB data, 500K commands/month, 10 GB bandwidth/month, 10 MB max request.
- **Vercel Hobby**: 100 GB Fast Data Transfer/month; personal, non-commercial use only.

## Environment variables

Backend (Render → service → Environment). Full list with comments: [`backend/.env.example`](backend/.env.example).

| Name | Required | Value |
| --- | --- | --- |
| `NODE_ENV` | yes | `production` (set by `render.yaml`) |
| `REDIS_URL` | yes | Upstash **TLS** URL: `rediss://default:<password>@<host>.upstash.io:6379` |
| `FRONTEND_URL` | yes | Your Vercel origin, e.g. `https://blip-xyz.vercel.app` (comma-separate several; no trailing slash) |
| `ADMIN_PASSWORD` | optional | 12+ random characters; leave empty to disable `/admin` |
| `CODE_EXECUTION` | optional | `off` (default in production). See "Code execution" below. |
| `PORT` | no | Injected by Render — don't set it |

Frontend (Vercel → Project → Settings → Environment Variables):

| Name | Required | Value |
| --- | --- | --- |
| `NEXT_PUBLIC_BACKEND_URL` | yes | Your Render URL, e.g. `https://blip-backend.onrender.com` (no trailing slash). The build fails without it. It is public — never put secrets in `NEXT_PUBLIC_*`. |

## Step by step

### 1. Redis (Upstash)

1. Sign in at https://console.upstash.com → **Create Database** → type Redis, pick the region closest to your Render region (e.g. Singapore `ap-southeast-1` for India), Free plan.
2. Open the database → **Connect** → copy the `rediss://...` URL (the one starting with **rediss**, TLS). Keep it private; you'll paste it into Render only.

### 2. Backend (Render)

Option A — Blueprint (uses [`render.yaml`](render.yaml)):

1. https://dashboard.render.com → **New** → **Blueprint** → connect GitHub → select the `Blip` repository.
2. Render reads `render.yaml` and asks for the `sync: false` values: `REDIS_URL`, `FRONTEND_URL` (use a placeholder like `https://placeholder.vercel.app` for now; you'll fix it in step 4), `ADMIN_PASSWORD`.
3. **Apply**. Wait for the deploy to show **Live**.

Option B — manual web service: **New** → **Web Service** → `Blip` repo, then:

- Root Directory: `backend` · Runtime: Node · Build Command: `npm ci --omit=dev` · Start Command: `node server.js`
- Instance Type: **Free** · Health Check Path: `/health`
- Environment: `NODE_ENV=production`, `NODE_VERSION=22`, `CODE_EXECUTION=off`, plus `REDIS_URL`, `FRONTEND_URL`, `ADMIN_PASSWORD`.

Verify (replace the host):

```bash
curl https://blip-backend.onrender.com/health
# {"status":"ok","redis":"ready",...}
curl https://blip-backend.onrender.com/api/public-rooms
# {"rooms":[{"roomId":"PUB10M",...},{"roomId":"PUB20M",...}]}
```

The logs should show `[Config] mode=production ... codeExecution=off` and `[Redis] Ready`.

### 3. Frontend (Vercel)

1. https://vercel.com/new → import the `Blip` repository.
2. **Root Directory**: `frontend` (Framework preset: Next.js is detected; keep default build/output settings).
3. Environment Variables: `NEXT_PUBLIC_BACKEND_URL` = your Render URL.
4. **Deploy**. Note the production domain (e.g. `https://blip-xyz.vercel.app`).

### 4. Connect them

1. Render → service → Environment → set `FRONTEND_URL` to the exact Vercel production origin → **Save** (Render redeploys).
2. If you later change `NEXT_PUBLIC_BACKEND_URL`, redeploy on Vercel (it is baked in at build time).

Preview deployments on Vercel use different URLs; add them to `FRONTEND_URL` (comma-separated) only if you need them to work.

### 5. Smoke test

- Open the Vercel URL over HTTPS; the first visit after idle may show "Waking up the server…" for up to a minute.
- Create a room in one browser, open the invite link in another (or a private window): chat, reactions, typing, code sync, attachments.
- Refresh the host tab: the room should survive (host grace period).
- Browser devtools → Network: no requests to `localhost`.

## Code execution

`/api/run` executes submitted code. Python/Java/C++ are **not sandboxed** (JS/TS use Node's permission model, which still allows network access), and Render's Node runtime does not include Java/C++ toolchains. It is therefore **off in production by default**; the editor shows "Running code is disabled on this server" and everything else works. Only set `CODE_EXECUTION=on` on an isolated host you are prepared to have abused.

## Known limitations

- **Cold starts**: after 15 idle minutes the backend sleeps; the next visitor waits ~1 min. Clients reconnect and rejoin automatically.
- **Restarts**: Render can restart free services at any time. Room data lives in Redis and timers are rebuilt on boot; open sockets reconnect. Editor content typed in the last ~2 s before an abrupt kill can be lost (it is flushed on graceful SIGTERM).
- **Single instance**: state such as timers, rate limits, admin sessions and the code buffer is in memory. Running more than one backend instance would need the Socket.IO Redis adapter and shared timers — not needed on the free plan (one instance).
- **Upstash quota**: ~500K commands/month. Editor writes are batched (≤1 per room per 2 s) and room info is cached per socket, but heavy use can still exhaust it; Redis then rejects writes and users see "Message could not be sent".
- **Storage**: attachments are capped at 3 MB each and 20 MB per room (`ROOM_ATTACHMENT_BUDGET_MB`), within Upstash's 256 MB total.
- **Vercel Hobby** is for non-commercial use.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Render deploy fails with `[Config] Error: FRONTEND_URL is required in production` | Set `FRONTEND_URL` in Render Environment. |
| `[Redis] Failed to connect` / `ECONNRESET` | Use the `rediss://` (TLS) URL from Upstash, not `redis://`; check the password. |
| Vercel build error `NEXT_PUBLIC_BACKEND_URL is not set` | Add it in Vercel env vars, then redeploy. |
| Browser console: CORS error / socket `xhr poll error` | `FRONTEND_URL` on Render must match the Vercel origin exactly (scheme + host, no trailing slash). |
| Site loads but stays on "Waking up the server…" | Backend sleeping or crashed: check Render logs; first wake takes ~1 min. |
| Everyone gets "Too many requests" at once | Proxy IP not detected: keep `NODE_ENV=production` (sets `TRUST_PROXY=1`). |
| Messages fail late in the month | Upstash command quota exhausted — check the Upstash console usage. |
| "Running code is disabled" | Expected in production (see Code execution). |
