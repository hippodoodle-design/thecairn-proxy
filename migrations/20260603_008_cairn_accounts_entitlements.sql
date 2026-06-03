-- Migration 008 — cairn_accounts_entitlements
-- Wave Cairn Customer Accounts + Entitlement Foundation (3 Jun 2026), project
-- The Cairn (mzjvcntzcfagasxcnuye). Dispatch ced83e2e.
--
-- The customer-account keystone. Customers sign in (Supabase Auth, passwordless
-- magic-link — the sign-in UI itself is frontend, thecairn-app-site) and land in
-- their own private archive. This migration lays the DATA MODEL:
--
--   accounts       — one row per auth.users customer (tier + status). Operator-
--                    blind: an admin (service_role) may see an account's
--                    existence/tier/status, NEVER a customer's archive content
--                    (content lives in the stones/media tables under their own
--                    owner-only RLS).
--   subscriptions  — provider-AGNOSTIC billing seam. billing_provider is a
--                    nullable enum (polar|paddle|stripe|null) — NOTHING is hard-
--                    wired to a provider here. The Polar/Paddle/Stripe (MoR)
--                    decision is still open (Amanda).
--   entitlements   — granted perks, idempotent (UNIQUE per account+kind). Home
--                    of the cross-product "one free storage month" rule.
--   paid_rescues   — lookup of COMPLETED paid rescues on ByteMe / CairnFerry
--                    (same Cairn Supabase project). The Cairn side queries this
--                    to test eligibility for the free month. NOTE: the ByteMe /
--                    CairnFerry PAID flows are NOT live yet, so this table will
--                    be empty until paid rescues start landing — the schema +
--                    lookup + granting logic are built so they work correctly
--                    the moment they do.
--
-- THE FREE-MONTH RULE (founder-locked, exact). A 'one free storage month' on
-- The Cairn is granted ONLY when BOTH are true:
--   (a) the SAME customer identity (match by verified email) has a COMPLETED
--       PAID rescue on EITHER ByteMe OR CairnFerry (paid_rescues.status='paid'),
--       AND
--   (b) that customer then starts a PAID Cairn subscription.
-- It is NOT granted to waiting-list leads, free users, trial-only users, or
-- anyone who has not paid for a rescue. Granted ONCE per customer (idempotent),
-- recorded as an entitlement (kind='free_storage_month',
-- source='paid_rescue_conversion', product_paid='byteme'|'cairnferry'). The
-- actual coupon / 100%-off-first-period / 1-month-trial application is left
-- BEHIND THE PROVIDER SEAM as a clearly-marked TODO (see shared/src/billing).
-- The entitlement is RECORDED now; the realisation is wired when a provider is.
--
-- The granting rule is implemented in code (shared/src/entitlements/index.js),
-- relying on the UNIQUE(account_id, kind) guard below for idempotency.
--
-- APPLY NOTE (3 Jun 2026): per CLAUDE.md (HippoSwitch Layer 1), the Supabase MCP
-- is NOT used for this project. Apply via the Supabase CLI with --db-url against
-- project mzjvcntzcfagasxcnuye, or via the Supabase SQL editor. The web/worker
-- service-role key (PostgREST) cannot run DDL. claude_app / Amanda apply this;
-- a CC session does not (no DB connection string in this repo). This migration
-- is independent of 006/007 (different table set) and may be applied alongside.

SET search_path = public, pg_temp;

-- ---------------------------------------------------------------------------
-- 1. accounts — one row per signed-in customer, keyed 1:1 to auth.users.
--    Holds account-level metadata only (tier, status). NO archive content.
--    email is denormalised from auth.users for the paid-rescue identity match
--    (rule (a)); kept lower-cased by the backend on write.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.accounts (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       text,
  tier        text NOT NULL DEFAULT 'free'
                CHECK (tier IN ('free','paid')),
  status      text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','suspended','closed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.accounts IS
  'One row per customer (1:1 with auth.users). Account metadata only — tier + status. Operator-blind: admin may see existence/tier/status, never archive content.';
COMMENT ON COLUMN public.accounts.email IS
  'Lower-cased copy of the verified auth email, used to match cross-product paid_rescues for the free-month rule.';

CREATE INDEX IF NOT EXISTS accounts_email_idx ON public.accounts (lower(email));

-- ---------------------------------------------------------------------------
-- 2. subscriptions — a customer's Cairn subscription. PROVIDER-AGNOSTIC: the
--    billing_provider / provider_* columns are a clean seam, NOT a Stripe (or
--    Polar/Paddle) hard-wire. status drives entitlement; current_period_end is
--    the renewal/expiry boundary.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id               uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  tier                     text NOT NULL DEFAULT 'paid'
                             CHECK (tier IN ('free','paid')),
  storage_quota_gb         integer NOT NULL DEFAULT 0 CHECK (storage_quota_gb >= 0),
  status                   text NOT NULL DEFAULT 'incomplete'
                             CHECK (status IN ('incomplete','trialing','active','past_due','canceled','expired')),
  current_period_end       timestamptz,
  -- Billing seam. NULL until a provider is wired. No provider is hard-coded.
  billing_provider         text CHECK (billing_provider IN ('polar','paddle','stripe')),
  provider_customer_id     text,
  provider_subscription_id text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.subscriptions IS
  'Cairn subscriptions. Provider-agnostic: billing_provider/provider_* are a seam (polar|paddle|stripe|null), nothing hard-wired. A PAID subscription = status in (trialing,active) AND tier=paid.';

-- One subscription row per provider subscription; allow history per account.
CREATE INDEX IF NOT EXISTS subscriptions_account_idx ON public.subscriptions (account_id);
-- Idempotent webhook upserts key on the provider subscription id when present.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_provider_sub_uniq
  ON public.subscriptions (billing_provider, provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. entitlements — perks granted to an account. UNIQUE(account_id, kind) makes
--    every entitlement at-most-once per account (the idempotency guard the
--    free-month rule relies on). consumed_at marks redemption.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.entitlements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  kind          text NOT NULL
                  CHECK (kind IN ('free_storage_month')),
  source        text NOT NULL
                  CHECK (source IN ('paid_rescue_conversion')),
  product_paid  text CHECK (product_paid IN ('byteme','cairnferry')),
  quantity      integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  granted_at    timestamptz NOT NULL DEFAULT now(),
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- At most once per account+kind. The free-month rule grants exactly one
  -- kind='free_storage_month' per account — this is the idempotency guard.
  CONSTRAINT entitlements_account_kind_uniq UNIQUE (account_id, kind)
);

COMMENT ON TABLE public.entitlements IS
  'Perks granted to an account, idempotent via UNIQUE(account_id, kind). Home of the free_storage_month (paid_rescue_conversion) grant. New kinds/sources extend the CHECKs in a later migration.';

CREATE INDEX IF NOT EXISTS entitlements_account_idx ON public.entitlements (account_id);

-- ---------------------------------------------------------------------------
-- 4. paid_rescues — cross-product lookup of COMPLETED paid rescues on ByteMe /
--    CairnFerry. Written by the ByteMe/CairnFerry paid flows (NOT live yet);
--    read by the Cairn free-month rule (a). System/operator data — service_role
--    only (no authenticated access). identity is the verified, lower-cased email.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.paid_rescues (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product             text NOT NULL CHECK (product IN ('byteme','cairnferry')),
  email               text NOT NULL,
  status              text NOT NULL DEFAULT 'paid'
                        CHECK (status IN ('paid','refunded','disputed')),
  paid_at             timestamptz,
  provider            text,
  provider_payment_id text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.paid_rescues IS
  'COMPLETED paid rescues on ByteMe/CairnFerry (same Cairn project). Read by the Cairn free-month rule to test eligibility (a). Empty until those paid flows go live. service_role-only.';

-- Lookup is "is there a paid rescue for this email on byteme|cairnferry?".
CREATE INDEX IF NOT EXISTS paid_rescues_email_status_idx
  ON public.paid_rescues (lower(email), status);
-- One rescue record per provider payment when known (idempotent ingest).
CREATE UNIQUE INDEX IF NOT EXISTS paid_rescues_provider_payment_uniq
  ON public.paid_rescues (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- updated_at touch triggers (reuse the shared helper from migration 006;
-- CREATE OR REPLACE makes this safe if 006 hasn't run / runs after).
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

DROP TRIGGER IF EXISTS accounts_touch_updated_at ON public.accounts;
CREATE TRIGGER accounts_touch_updated_at
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS subscriptions_touch_updated_at ON public.subscriptions;
CREATE TRIGGER subscriptions_touch_updated_at
  BEFORE UPDATE ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS paid_rescues_touch_updated_at ON public.paid_rescues;
CREATE TRIGGER paid_rescues_touch_updated_at
  BEFORE UPDATE ON public.paid_rescues
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Grants. Backend (web + worker) uses the service-role key and bypasses RLS;
-- it scopes every query to the authenticated account in code. The authenticated
-- role gets exactly the surface RLS then filters.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.accounts, public.subscriptions, public.entitlements, public.paid_rescues
  TO service_role;

-- accounts: a customer reads + writes ONLY their own row.
GRANT SELECT, INSERT, UPDATE ON public.accounts TO authenticated;
-- subscriptions: a customer READS their own; writes are backend-only (billing
-- webhook under service_role) — no authenticated INSERT/UPDATE grant.
GRANT SELECT ON public.subscriptions TO authenticated;
-- entitlements: a customer READS their own; grants are backend-only — no
-- authenticated INSERT/UPDATE grant.
GRANT SELECT ON public.entitlements TO authenticated;
-- paid_rescues: NO authenticated grant. Cross-product/system data, service_role
-- only (the free-month rule reads it server-side).

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE public.accounts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entitlements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paid_rescues  ENABLE ROW LEVEL SECURITY;

-- accounts: a customer may see/insert/update ONLY their own row (id = auth.uid()).
DROP POLICY IF EXISTS accounts_owner_select ON public.accounts;
CREATE POLICY accounts_owner_select
  ON public.accounts
  FOR SELECT TO authenticated
  USING (id = auth.uid());

DROP POLICY IF EXISTS accounts_owner_insert ON public.accounts;
CREATE POLICY accounts_owner_insert
  ON public.accounts
  FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS accounts_owner_update ON public.accounts;
CREATE POLICY accounts_owner_update
  ON public.accounts
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- subscriptions: a customer reads their own subscription rows. No write policy
-- for authenticated — billing writes happen under service_role (RLS-bypassing).
DROP POLICY IF EXISTS subscriptions_owner_select ON public.subscriptions;
CREATE POLICY subscriptions_owner_select
  ON public.subscriptions
  FOR SELECT TO authenticated
  USING (account_id = auth.uid());

-- entitlements: a customer reads their own entitlements. Grants are service_role.
DROP POLICY IF EXISTS entitlements_owner_select ON public.entitlements;
CREATE POLICY entitlements_owner_select
  ON public.entitlements
  FOR SELECT TO authenticated
  USING (account_id = auth.uid());

-- paid_rescues: no authenticated policy by design. Only service_role (which
-- bypasses RLS) touches this table. RLS enabled with no policy = deny-all for
-- authenticated/anon, which is the intent.
