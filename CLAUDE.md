# CLAUDE.md — thecairn-proxy

> **TODO** — this file is a stub. Expand with project context (what thecairn-proxy is, its architecture, the `web/` + `worker/` monorepo layout, deploy story, any standing snags) as future sessions touch this repo. Created during HippoSwitch Layer 1 rollout (23 May 2026) to carry the Supabase credentials rule before broader context is documented.

## Supabase credentials (HippoSwitch Layer 1)

For any database work in this project, use the credentials appropriate to this repo's role:

**This repo's role**: BACKEND_MONOREPO (`web/` + `worker/` subdirs — the worker side is the database client; the web side is anon-key only)

**Backend / Worker repos**:
- `.env.local` should contain `SUPABASE_SERVICE_ROLE_KEY` + `SUPABASE_URL` (or project-prefixed equivalents like `POD_SUPABASE_SERVICE_ROLE_KEY` for cross-project workers)
- Use these credentials directly via supabase-js or the supabase CLI with `--db-url`
- For Cloudflare Workers: secrets live in Worker Secrets store, set via `wrangler secret put`

**Frontend repos**:
- `.env.local` will only contain `VITE_*` anon-key variables — this is the correct security posture, not a gap
- For service-role DB ops (one-off scripts, migrations), the service_role key lives at:
  - Supabase dashboard → Settings → API → service_role
  - Or in the related backend Worker's Secrets if there is one
- Frontend code itself NEVER touches service role keys

**For all repos — universal rules**:
1. NEVER call the Supabase MCP for this project's database work. The MCP may be connected to a different org, and switching is expensive. Amanda Is Not the Bridge.
2. Migrations: use `supabase` CLI with `--db-url`, or apply SQL directly via `supabase-js` from a one-off Node script, or via the Supabase web SQL editor
3. If credentials appear missing or wrong: surface `disagreement.surfaced` to cc-outbox before guessing — don't proceed with anon keys when service_role is needed
4. Exception: cross-project verification (comparing schemas across two projects) may use the MCP, but document why in the ship report
