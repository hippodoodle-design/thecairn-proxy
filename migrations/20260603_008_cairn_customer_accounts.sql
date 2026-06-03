-- Migration 008 — cairn_customer_accounts
-- Wave Cairn Customer Accounts + Entitlement Foundation (3 Jun 2026), project The
-- Cairn (mzjvcntzcfagasxcnuye). The keystone that lets customers sign in and
-- privately own their archive, and that programs the cross-product "free month"
-- rule into the data model. This is the prerequisite that later gates the
-- companion (Roberta) making cost-controlled AI/voice calls.
--
-- DESIGN LOCKS (from the dispatch, founder-locked — do not loosen):
--   * Auth = Supabase Auth, passwordless email magic-link default (no passwords).
--     The sign-in UI is FRONTEND (thecairn-app); this migration is the data
--     keystone behind it.
--   * Operator-blind: an admin may see ACCOUNTS (existence, tier, status) but
--     NEVER a customer's content. Content tables (user_companions, media, …) stay
--     owner-only RLS — this migration adds NO admin path to content.
--   * Billing is PROVIDER-AGNOSTIC. billing_provider is a nullable enum
--     ('polar'|'paddle'|'stripe'); NOTHING here hard-wires a provider, and no
--     provider keys/wiring exist. The Polar/Paddle/Stripe (MoR) call is still open.
--   * THE FREE-MONTH RULE (exact): one free storage month is granted ONLY when
--     BOTH are true — (a) the SAME verified-email identity has a COMPLETED PAID
--     rescue (status='paid') on ByteMe OR CairnFerry, AND (b) that customer then
--     starts a PAID Cairn subscription. NEVER for waiting-list leads, free users,
--     or trial-only users. Granted ONCE per customer (idempotent), recorded as an
--     entitlement. Realising it as a coupon/100%-off-first-period is left behind
--     the provider seam as a marked TODO; the ENTITLEMENT is recorded now.
--
-- ByteMe + CairnFerry live in this SAME Supabase project, so paid_rescues is the
-- lookup the Cairn side queries for rule (a). Those paid flows are NOT live yet,
-- so paid_rescues will be empty for now — the table + lookup + granting logic are
-- built so the rule fires correctly the moment paid rescues start landing.
--
-- Canonical entitlement seam reference: shared/src/accounts/index.js in this repo.
--
-- APPLY NOTE (3 Jun 2026): per CLAUDE.md (HippoSwitch Layer 1), the Supabase MCP
-- is NOT used for this project. Apply via the Supabase CLI with --db-url against
-- project mzjvcntzcfagasxcnuye, or via the Supabase SQL editor. The web/worker
-- service-role key (PostgREST) cannot run DDL. This migration depends on the
-- auth schema (auth.users) only; it does not depend on 006/007. claude_app /
-- Amanda apply — CC writes the reviewable file but does not apply it.

SET search_path = public, pg_temp;

-- ===========================================================================
-- 1. profiles — one row per customer, keyed 1:1 to auth.users. Identity only.
--    Tier/status live on subscriptions; this stays the calm "who you are" row.
--    A customer reads/writes ONLY their own profile (RLS). Operator-blind: the
--    admin overview view (below) exposes existence/tier/status, never content.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  user_id      uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Verified email, mirrored from auth.users at sign-up by the backend. Used as
  -- the cross-product identity key for the free-month rule (match by email).
  email        text NOT NULL,
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.profiles IS
  'One row per customer (1:1 with auth.users). Identity only; tier/status live on subscriptions. Owner-only RLS.';
COMMENT ON COLUMN public.profiles.email IS
  'Verified email mirrored from auth.users. Cross-product identity key for the free-month rule.';

-- ===========================================================================
-- 2. subscriptions — a customer's Cairn subscription. tier + status + quota live
--    here. billing_provider is PROVIDER-AGNOSTIC and nullable (no provider is
--    wired). provider_* ids are nullable until a provider is later chosen.
--    Customer reads own; only the backend (service_role) writes — a customer can
--    never set their own tier/status.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              uuid NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  tier                    text NOT NULL DEFAULT 'free'
                            CHECK (tier IN ('free','paid')),
  storage_quota_gb        integer NOT NULL DEFAULT 0,
  status                  text NOT NULL DEFAULT 'inactive'
                            CHECK (status IN ('inactive','active','past_due','canceled','paused')),
  current_period_end      timestamptz,
  -- Provider-agnostic seam. NULL until a provider is chosen + wired. The enum is
  -- deliberately a CHECK (not a pg enum type) so adding a provider later is a
  -- one-line migration, not an ALTER TYPE dance.
  billing_provider        text
                            CHECK (billing_provider IS NULL
                                   OR billing_provider IN ('polar','paddle','stripe')),
  provider_customer_id     text,
  provider_subscription_id text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  -- One subscription row per account (the current subscription). History, if ever
  -- needed, goes to a separate ledger — keep the live row single + simple.
  CONSTRAINT subscriptions_one_per_account UNIQUE (account_id)
);

COMMENT ON TABLE public.subscriptions IS
  'A customer''s Cairn subscription (tier/status/quota). Provider-agnostic billing seam; no provider wired. Backend-write only.';
COMMENT ON COLUMN public.subscriptions.billing_provider IS
  'Nullable, provider-agnostic. polar|paddle|stripe. NULL = no provider chosen/wired yet. Do not hard-wire a provider.';

-- ===========================================================================
-- 3. entitlements — discrete grants attached to an account (e.g. the free
--    storage month). source records WHY it was granted. The uniqueness guard
--    makes granting idempotent: a given (account, kind, source) is granted at
--    most once, so re-running the granting logic never double-grants.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.entitlements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  kind         text NOT NULL
                 CHECK (kind IN ('free_storage_month')),
  source       text NOT NULL
                 CHECK (source IN ('paid_rescue_conversion')),
  -- Which paid rescue product triggered the grant ('byteme'|'cairnferry'). Null
  -- for sources that are not rescue-driven (none yet, but the column is ready).
  product_paid text
                 CHECK (product_paid IS NULL OR product_paid IN ('byteme','cairnferry')),
  quantity     integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  consumed_at  timestamptz,
  -- Idempotency guard: at most one grant of a given kind+source per account.
  CONSTRAINT entitlements_once_per_account UNIQUE (account_id, kind, source)
);

COMMENT ON TABLE public.entitlements IS
  'Discrete account grants (e.g. free_storage_month). UNIQUE(account_id,kind,source) makes granting idempotent. Backend-write only.';

-- ===========================================================================
-- 4. paid_rescues — cross-product lookup of COMPLETED PAID rescues on ByteMe /
--    CairnFerry. ByteMe + CairnFerry share this Supabase project, so the Cairn
--    side queries this to test free-month rule (a). NOT live yet — empty until
--    the paid rescue flows land; the table + lookup are built ahead so the rule
--    fires the moment they do. INTERNAL: service_role only, no customer/anon
--    access (it is cross-customer payment data).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.paid_rescues (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product     text NOT NULL CHECK (product IN ('byteme','cairnferry')),
  -- Verified email of the paying customer; the identity join key to profiles.
  email       text NOT NULL,
  status      text NOT NULL DEFAULT 'paid'
                CHECK (status IN ('paid','refunded','disputed')),
  amount_cents integer,
  currency     text,
  paid_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.paid_rescues IS
  'Cross-product COMPLETED PAID rescues (ByteMe/CairnFerry) keyed by verified email. Internal lookup for the Cairn free-month rule. service_role only.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS subscriptions_account_idx
  ON public.subscriptions (account_id);
CREATE INDEX IF NOT EXISTS entitlements_account_idx
  ON public.entitlements (account_id);
-- The free-month lookup matches paid rescues by lower(email) + status='paid'.
CREATE INDEX IF NOT EXISTS paid_rescues_email_status_idx
  ON public.paid_rescues (lower(email), status);

-- ---------------------------------------------------------------------------
-- updated_at touch triggers (reuse the shared helper from migration 006;
-- CREATE OR REPLACE keeps this safe even if 006 has not run in this DB).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_touch_updated_at ON public.profiles;
CREATE TRIGGER profiles_touch_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS subscriptions_touch_updated_at ON public.subscriptions;
CREATE TRIGGER subscriptions_touch_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ===========================================================================
-- 5. THE FREE-MONTH RULE, as a SQL function — the single source of truth.
--    SECURITY DEFINER so the backend can call it; it reads paid_rescues
--    (service-role-only) on the caller's behalf. It grants ONLY when BOTH
--    conditions hold and is idempotent via ON CONFLICT DO NOTHING.
--
--    It RECORDS the entitlement. It does NOT apply any coupon/trial — that is
--    realised at Cairn checkout behind the (not-yet-chosen) provider seam. See
--    the TODO marker below and shared/src/accounts/index.js.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.grant_free_month_if_eligible(p_account_id uuid)
RETURNS TABLE (granted boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_email          text;
  v_paid_product   text;
  v_has_paid_sub   boolean;
  v_inserted       boolean := false;
BEGIN
  -- Identity for this account.
  SELECT email INTO v_email FROM public.profiles WHERE user_id = p_account_id;
  IF v_email IS NULL THEN
    RETURN QUERY SELECT false, 'no_profile';
    RETURN;
  END IF;

  -- Rule (a): a COMPLETED PAID rescue on ByteMe OR CairnFerry under the SAME
  -- verified email. Match case-insensitively; pick a product for the record.
  SELECT product INTO v_paid_product
  FROM public.paid_rescues
  WHERE lower(email) = lower(v_email)
    AND status = 'paid'
  ORDER BY paid_at NULLS LAST
  LIMIT 1;

  IF v_paid_product IS NULL THEN
    RETURN QUERY SELECT false, 'no_paid_rescue';
    RETURN;
  END IF;

  -- Rule (b): that customer has started a PAID Cairn subscription.
  SELECT EXISTS (
    SELECT 1 FROM public.subscriptions
    WHERE account_id = p_account_id
      AND tier = 'paid'
      AND status = 'active'
  ) INTO v_has_paid_sub;

  IF NOT v_has_paid_sub THEN
    RETURN QUERY SELECT false, 'no_paid_cairn_subscription';
    RETURN;
  END IF;

  -- Both true → record the entitlement ONCE (idempotent via the unique guard).
  -- TODO(provider-seam): when a billing provider is wired, realise this as a
  -- 100%-off-first-period / 1-month trial at Cairn checkout. The entitlement
  -- recorded here is the durable source of truth; the coupon is the realisation.
  INSERT INTO public.entitlements (account_id, kind, source, product_paid)
  VALUES (p_account_id, 'free_storage_month', 'paid_rescue_conversion', v_paid_product)
  ON CONFLICT (account_id, kind, source) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted THEN
    RETURN QUERY SELECT true, 'granted';
  ELSE
    RETURN QUERY SELECT false, 'already_granted';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.grant_free_month_if_eligible(uuid) IS
  'Founder-locked free-month rule: grants free_storage_month iff (paid rescue on byteme/cairnferry under same email) AND (paid active Cairn sub). Idempotent. Records entitlement only; coupon realisation lives behind the provider seam.';

-- ---------------------------------------------------------------------------
-- 6. account_overview — operator-blind admin view: existence + tier + status,
--    NEVER content. service_role only (no authenticated/anon grant). This is the
--    ONLY admin window onto accounts, and it deliberately exposes no media.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.account_overview AS
  SELECT
    p.user_id        AS account_id,
    p.created_at     AS account_created_at,
    s.tier,
    s.status,
    s.current_period_end,
    s.billing_provider
  FROM public.profiles p
  LEFT JOIN public.subscriptions s ON s.account_id = p.user_id;

COMMENT ON VIEW public.account_overview IS
  'Operator-blind admin window: account existence + tier + status only, never content. service_role only.';

-- ===========================================================================
-- Grants. Backend (web + worker) uses service_role and bypasses RLS; it scopes
-- every query to the authenticated account in code. authenticated gets exactly
-- the surface RLS then filters; paid_rescues + account_overview are backend-only.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.profiles, public.subscriptions, public.entitlements, public.paid_rescues
  TO service_role;
GRANT SELECT ON public.account_overview TO service_role;

-- profiles: owner reads + writes own row.
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
-- subscriptions: owner reads own; backend writes (no authenticated write grant).
GRANT SELECT ON public.subscriptions TO authenticated;
-- entitlements: owner reads own; backend writes (granting fn runs service_role).
GRANT SELECT ON public.entitlements TO authenticated;
-- paid_rescues: INTERNAL — no authenticated/anon grant at all.
-- account_overview: admin-only — no authenticated/anon grant at all.

-- Let authenticated callers invoke the granting function (it is SECURITY DEFINER
-- and validates the rule internally; it never leaks paid_rescues content).
GRANT EXECUTE ON FUNCTION public.grant_free_month_if_eligible(uuid) TO authenticated, service_role;

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
ALTER TABLE public.profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entitlements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paid_rescues  ENABLE ROW LEVEL SECURITY;

-- profiles: a customer may see/insert/update ONLY their own row.
DROP POLICY IF EXISTS profiles_owner_select ON public.profiles;
CREATE POLICY profiles_owner_select
  ON public.profiles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS profiles_owner_insert ON public.profiles;
CREATE POLICY profiles_owner_insert
  ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS profiles_owner_update ON public.profiles;
CREATE POLICY profiles_owner_update
  ON public.profiles
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- subscriptions: a customer may READ only their own subscription. No write
-- policy for authenticated by design — tier/status are backend-set.
DROP POLICY IF EXISTS subscriptions_owner_select ON public.subscriptions;
CREATE POLICY subscriptions_owner_select
  ON public.subscriptions
  FOR SELECT TO authenticated
  USING (account_id = auth.uid());

-- entitlements: a customer may READ only their own entitlements. Writes are
-- backend-only (the granting function runs as service_role / definer).
DROP POLICY IF EXISTS entitlements_owner_select ON public.entitlements;
CREATE POLICY entitlements_owner_select
  ON public.entitlements
  FOR SELECT TO authenticated
  USING (account_id = auth.uid());

-- paid_rescues: NO policy for authenticated/anon — RLS on + no policy means
-- only service_role (which bypasses RLS) can touch it. Internal cross-product
-- lookup; never customer-readable.
