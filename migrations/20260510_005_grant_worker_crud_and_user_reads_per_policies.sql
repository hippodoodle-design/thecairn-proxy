-- Migration 005 — grant_worker_crud_and_user_reads_per_policies
-- Applied 10 May 2026 via Supabase MCP, project The Cairn (mzjvcntzcfagasxcnuye)
-- Follow-up to migration 004 (galleries CRUD GRANT). Surfaced during full-schema
-- audit of every public table's privileges vs RLS policies.
-- profiles, usage_counters, user_products had policies written but the matching
-- GRANTs were never applied, so the policies could never fire.
--
-- Unblocks: worker writing usage_counters on every pipeline run; frontend reading
-- own profile/products/usage directly without round-tripping through proxy.

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.profiles, public.usage_counters, public.user_products
  TO service_role;

GRANT SELECT, UPDATE ON TABLE public.profiles       TO authenticated;
GRANT SELECT          ON TABLE public.usage_counters TO authenticated;
GRANT SELECT          ON TABLE public.user_products  TO authenticated;
