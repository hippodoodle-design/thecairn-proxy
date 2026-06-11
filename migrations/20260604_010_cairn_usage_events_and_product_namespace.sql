-- Migration 010 — cairn_usage_events + public._product_namespace (ADDITIVE)
-- Wave Cairn Foundation gap-fill (4 Jun 2026), project The Cairn
-- (mzjvcntzcfagasxcnuye). Dispatch c1d7e4a9 (re-run board e97d2527 closing
-- questions), under Amanda's standing keep-building authority.
--
-- WHY: the re-run board caught two gaps the first-run foundation (008/009, PR #7)
-- missed:
--   1. an eligibility SOURCE table the Cairn free-month logic can read
--      (cairn_usage_events), and
--   2. the family collision-proofing ownership manifest (public._product_namespace)
--      — the "magic" safeguard that records which table-name namespace belongs to
--      which product, so a future product never silently collides the way the
--      pre-existing public.subscriptions (a DIFFERENT product's billing table) did
--      with the Cairn billing model (board verdict e97d2527 -> Option A, cairn_
--      prefix).
--
-- POSTURE: ADDITIVE + NON-DESTRUCTIVE + IDEMPOTENT. Nothing existing is altered,
-- renamed, or dropped — least of all public.subscriptions. Operator-blind: the new
-- events table holds metadata only (an event_type label + timestamp), never
-- archive content. NO-DELETE: no DELETE is granted on cairn_usage_events; events
-- are append-only and read-only to the customer.
--
-- THE LIVE FUNCTION IS LEFT UNCHANGED ON PURPOSE. cairn_grant_free_storage_month()
-- already computes the free-month rule correctly from cairn_paid_rescues (rule a:
-- a paid ByteMe/CairnFerry rescue for the account email) + cairn_subscriptions
-- (rule b: a paid Cairn subscription). It does NOT depend on usage events, so
-- repointing it would change/risk a live interlock for no benefit. Per the
-- dispatch ("if the function already works reading auth.users, just ADD the table
-- for the eligibility logic to use — do not break the live function"), this
-- migration only ADDS cairn_usage_events as an available eligibility/analytics
-- source for future logic; the function is not touched.
--
-- APPLY NOTE: per CLAUDE.md (HippoSwitch Layer 1) the Supabase MCP is NOT used for
-- this project. Applied via the Supabase Management API database/query endpoint
-- with the project access token (sbp_…, reaches mzjvcntzcfagasxcnuye) — NOT the
-- service-role PostgREST key (which cannot run DDL). Safe to re-run.
-- Depends on auth.users already existing (it does).

SET search_path = public, pg_temp;

-- ===========================================================================
-- 1. cairn_usage_events — append-only, own-row eligibility/analytics source.
--    Metadata only (event_type label + timestamp). NEVER content. The free-month
--    eligibility logic (and future Cairn rules) can read this to compute usage,
--    without exposing any media to an operator. One row per recorded event.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.cairn_usage_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cairn_usage_events IS
  'The Cairn: append-only per-account usage events (metadata only — an event_type label + timestamp, never content). Operator-blind, own-row RLS, NO-DELETE. The eligibility/analytics source the re-run board (e97d2527) flagged for the free-month rule; available for cairn_grant_free_storage_month()/future logic to read. Added additively by migration 010 (dispatch c1d7e4a9); the live grant function is unchanged.';
COMMENT ON COLUMN public.cairn_usage_events.event_type IS
  'A short label for the recorded event (e.g. ''import_started'', ''first_stone_placed''). A LABEL only — never content.';

CREATE INDEX IF NOT EXISTS cairn_usage_events_user_created_idx
  ON public.cairn_usage_events (user_id, created_at);
CREATE INDEX IF NOT EXISTS cairn_usage_events_type_idx
  ON public.cairn_usage_events (event_type);

-- Grants. Backend (service_role) appends + reads; it is NOT granted DELETE
-- (NO-DELETE posture — events are append-only). Customers read only their own.
GRANT SELECT, INSERT, UPDATE ON public.cairn_usage_events TO service_role;
GRANT SELECT ON public.cairn_usage_events TO authenticated;

ALTER TABLE public.cairn_usage_events ENABLE ROW LEVEL SECURITY;

-- Owner reads own events. No client write policy (events are backend-written);
-- no delete path (NO-DELETE).
DROP POLICY IF EXISTS cairn_usage_events_owner_select ON public.cairn_usage_events;
CREATE POLICY cairn_usage_events_owner_select
  ON public.cairn_usage_events
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- ===========================================================================
-- 2. public._product_namespace — the family collision-proofing ownership
--    manifest. Records which table-name namespace (prefix) belongs to which
--    product, so a future product never silently collides on a bare name the way
--    the pre-existing other-product public.subscriptions collided with the Cairn
--    billing model. This is a RECORD, not a migration of existing tables — nothing
--    is renamed. Keyed (unique) on prefix.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public._product_namespace (
  prefix       text PRIMARY KEY,
  product_name text NOT NULL,
  owner_role   text NOT NULL DEFAULT 'service_role',
  notes        text,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public._product_namespace IS
  'Family collision-proofing manifest: which table-name namespace (prefix) belongs to which product on this shared Supabase project. A record only — does NOT rename or own existing tables. Born from the public.subscriptions collision (board verdict e97d2527 -> Option A cairn_ prefix). Added by migration 010 (dispatch c1d7e4a9).';
COMMENT ON COLUMN public._product_namespace.prefix IS
  'The table-name prefix that defines the namespace (e.g. ''cairn_''). Going-forward Cairn tables MUST use cairn_. A sentinel value records the legacy shared/unprefixed footprint.';

-- Manifest is internal infra metadata — backend (service_role) only. RLS on with
-- no policy => not readable by anon/authenticated; service_role bypasses RLS.
GRANT SELECT, INSERT, UPDATE ON public._product_namespace TO service_role;
ALTER TABLE public._product_namespace ENABLE ROW LEVEL SECURITY;

-- Seed with what is VERIFIABLY true on this live DB (probed read-only before
-- apply). Idempotent: ON CONFLICT (prefix) DO NOTHING keeps re-runs safe and does
-- not clobber later hand-edits.
INSERT INTO public._product_namespace (prefix, product_name, owner_role, notes) VALUES
  (
    'cairn_',
    'The Cairn',
    'service_role',
    'Going-forward Cairn namespace: all NEW Cairn billing/account/usage tables use this prefix (cairn_subscriptions, cairn_entitlements, cairn_paid_rescues, cairn_pricing, cairn_usage_events). NOTE: the Cairn also owns LEGACY unprefixed tables created before this convention (profiles, spaces, space_members, stacks, shelves, stack_shelves, stone_shelves, stone_stacks, stones, galleries, folder_items, stone_collections, stone_collection_items, undo_log) — the unprefixed namespace is shared, which is exactly why the cairn_ convention now exists.'
  ),
  (
    '(legacy-unprefixed:processor-billing)',
    'Other product — processor-based billing (legacy, unprefixed)',
    'service_role',
    'Verified-present processor-based billing footprint that is NOT the Cairn''s and must never be clobbered: subscriptions (user_id/processor shape, 0 rows), subscription_line_items, subscription_adjustments, stripe_customers, gocardless_customers, adyen_customers, webhook_events, usage_counters, user_products. The public.subscriptions name-collision with the Cairn billing model is the reason for board verdict e97d2527 (Option A: prefix new Cairn billing tables cairn_). Recorded as a sentinel-prefix row because this product predates any prefix convention.'
  )
ON CONFLICT (prefix) DO NOTHING;
