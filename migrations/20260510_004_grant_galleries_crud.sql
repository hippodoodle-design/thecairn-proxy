-- Phase 6+ media pipeline writes peakapoo gallery rows + harvest
-- candidate rows into public.galleries (kind='peakapoo' or
-- 'photo-from-video'). The original galleries grants only
-- included REFERENCES/TRIGGER/TRUNCATE for service_role and
-- authenticated — missing the standard CRUD set that
-- public.stones already has. This migration brings galleries
-- into parity with stones so the worker can insert and the
-- frontend can read.
--
-- Run 6 (10 May 2026) surfaced this gap as Postgres error 42501
-- "permission denied for table galleries" during media-ingest.
-- Treated as non-fatal in code (stone preserved) but blocked the
-- harvest flow and Phase 10's galleries.file_path ownership path.
--
-- Already applied to production via Supabase MCP on 10 May 2026.

-- service_role (used by the worker via the service-role key)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.galleries TO service_role;

-- authenticated (used by the Cairn frontend reading the user's own galleries via RLS)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.galleries TO authenticated;
