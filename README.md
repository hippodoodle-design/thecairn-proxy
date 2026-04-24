# thecairn-proxy

Cairn backend. Two Node services plus a Redis queue. Designed to scale horizontally to 50k+ users.

- **thecairn-web** — Express API. Validates Supabase JWT, enqueues jobs, serves status polling.
- **thecairn-worker** — BullMQ worker. Fetches URLs, parses OG tags, writes `stones` rows.
- **Redis** — BullMQ backing store.

## Repo layout

```
thecairn-proxy/
├── package.json            npm workspaces root
├── railway.json            Nixpacks builder hint for Railway
├── docker-compose.yml      Redis for local dev
├── .env.example            env var reference
├── shared/                 cross-service code (supabase, ogParser, queue, logger, validateUrl)
├── web/                    Express API (thecairn-web)
└── worker/                 BullMQ worker (thecairn-worker)
```

## Railway services

Two services, one repo, one builder (Nixpacks auto-detects Node from the root `package.json`). Each service uses the same codebase but a different start command.

| Service            | Start command                                  | Health check  |
| ------------------ | ---------------------------------------------- | ------------- |
| `thecairn-web`     | `npm --workspace @cairn/web run start`         | `/health`     |
| `thecairn-worker`  | `npm --workspace @cairn/worker run start`      | — (no HTTP)   |

Set the start command in each service's *Settings → Deploy → Custom Start Command*.
Set the health check path in the web service's *Settings → Deploy → Healthcheck Path*.

## Environment variables

Shared across both services:

| Variable                      | Default                  | Purpose                                                    |
| ----------------------------- | ------------------------ | ---------------------------------------------------------- |
| `SUPABASE_URL`                | —                        | Supabase project URL.                                      |
| `REDIS_URL`                   | —                        | Provided by Railway's Redis add-on in prod.                |
| `NODE_ENV`                    | `development`            | `production` on Railway.                                   |
| `LOG_LEVEL`                   | `info`                   | `debug` / `info` / `warn` / `error`.                       |
| `LOG_FORMAT`                  | (pretty)                 | Set to `json` to emit single-line JSON for log aggregators.|

### thecairn-web (only)

| Variable                      | Default                                                                | Purpose                                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_SERVICE_ROLE_KEY`   | —                                                                      | Verifies user JWTs via `supabase.auth.getUser(token)`. Works with any signing scheme (HS256, ECC P-256). Never expose to a browser. |
| `SUPABASE_JWT_SECRET`         | —                                                                      | Legacy, optional. No longer used — kept for possible fallback to local HS256 verification.                                         |
| `ALLOWED_ORIGINS`             | `https://www.thecairn.app,https://thecairn.app,http://localhost:5173`  | Comma-separated CORS allowlist.                                                                                                    |
| `PORT`                        | `3001`                                                                 | HTTP port.                                                                                                                         |

### thecairn-worker (only)

| Variable                      | Default | Purpose                                                           |
| ----------------------------- | ------- | ----------------------------------------------------------------- |
| `SUPABASE_SERVICE_ROLE_KEY`   | —       | Service-role key; inserts into `stones` bypassing RLS. Never expose to a browser. |
| `WORKER_CONCURRENCY`          | `10`    | Parallel jobs per worker process.                                 |

**Full env lists for paste-into-Railway:**

- **thecairn-web**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL`, `ALLOWED_ORIGINS`, `PORT`, `NODE_ENV`, `LOG_LEVEL`, `LOG_FORMAT`
- **thecairn-worker**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REDIS_URL`, `NODE_ENV`, `LOG_LEVEL`, `LOG_FORMAT`, `WORKER_CONCURRENCY`

Copy `.env.example` to `.env` locally. Do **not** commit `.env`.

## Local dev

Requires Node 20+, Docker Desktop, npm.

```powershell
# From C:\thecairn-proxy

# 1. Install workspaces
npm install

# 2. Start Redis (separate terminal)
npm run dev:redis

# 3. Start web (separate terminal)
npm run dev:web

# 4. Start worker (separate terminal)
npm run dev:worker
```

Web listens on `http://localhost:3001`. Health check: `GET /health`.

## API

### `POST /api/digest`
Auth: `Authorization: Bearer <supabase access token>`.
Body: `{ "url": "https://example.com/article" }`
Response: `202 { ok: true, jobId }`.

### `GET /api/digest/:jobId`
Auth: same. Only the job's `ownerId` can read it (404 otherwise — we don't leak existence).
Response: `{ ok: true, jobId, state, progress, result, error }`.

### `GET /health`
Unauthenticated. Returns Redis connectivity.

## Stones insert shape

The worker inserts exactly these columns into `public.stones`:

```json
{
  "owner_id": "<uuid from JWT sub>",
  "kind": "url",
  "title": "…",
  "content_url": "https://…",
  "metadata": {
    "description": "…",
    "hero_image_url": "…",
    "site_name": "…",
    "favicon_url": "…",
    "og_raw": { "og:title": "…", "twitter:card": "summary_large_image" }
  },
  "is_favourite": false
}
```

`created_at` / `updated_at` default to `now()` in Postgres. No other columns are written.

## Emoji log legend

The pretty logger prefixes every event with an emoji so you can scan Railway logs at a glance. A good session reads like stones landing one after another.

| Emoji | Event            | Meaning                                                  |
| ----- | ---------------- | -------------------------------------------------------- |
| 🪨    | `stone_landed`   | A stone was successfully inserted into `stones`.         |
| 🌐    | `url_fetched`    | Worker fetched a URL (status + bytes + duration).        |
| 📥    | `job_enqueued`   | Web accepted a request and queued a job.                 |
| 🚀    | `job_started`    | Worker began processing a job.                           |
| ⚠️    | `job_failed`     | A job threw; BullMQ will retry per `attempts: 3`.        |
| 🔁    | `job_retrying`   | Retry in progress.                                       |
| 🔒    | `auth_rejected`  | JWT missing / invalid / mis-configured.                  |
| 🚦    | `rate_limited`   | 429 for this caller.                                     |
| ✅    | `health_ok`      | Healthcheck ping (debug level — silent at info).         |
| 💛    | `server_ready`   | Web started listening.                                   |
| 💛    | `worker_ready`   | Worker connected to Redis and is pulling jobs.           |
| •     | *(other)*        | Untyped / ad-hoc log line.                               |

Set `LOG_FORMAT=json` in Railway to flip to machine-parseable JSON (Logtail, Datadog, etc.) without touching code.

## Safety

- **SSRF** — `validateUrl` rejects non-http(s), literal private IPs, and hostnames that resolve to private / loopback / link-local / CGNAT / multicast addresses. Re-validated at worker time.
- **Body cap** — fetch enforces 10s timeout, 5 MB max (streamed, not trusted Content-Length), `text/html` only.
- **Rate limit** — in-memory token bucket per userId (60 req/min). Stable interface so a Redis-backed swap is a one-file change.
- **Auth** — Supabase JWT verified by `supabase.auth.getUser(token)` using the service-role key (handles HS256 and ECC-signed asymmetric JWTs uniformly). Service-role writes happen only after that check.
- **Retry** — BullMQ `attempts: 3` with exponential backoff (2s, 4s, 8s).
- **Graceful shutdown** — web drains in-flight requests; worker waits for in-flight jobs before closing the Redis connection.

## Production notes

- Web and worker scale independently. Run 1+ web replicas behind a load balancer, N worker replicas sized to queue depth.
- The in-memory rate limiter becomes inaccurate across >1 web replica. Before that milestone, swap `web/src/middleware/rateLimit.js` for a Redis-backed limiter.
- Supabase service client is cached per process — do **not** instantiate per request.
- Logs default to pretty (human-readable) on stdout/stderr. Set `LOG_FORMAT=json` when you wire up structured log ingestion.
