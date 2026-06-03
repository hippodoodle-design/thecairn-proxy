-- Migration 008 — accounts_entitlements_foundation
-- Wave Cairn Customer Accounts (3 Jun 2026), project The Cairn (mzjvcntzcfagasxcnuye).
-- Dispatch ced83e2e-15cd-4d71-8e65-4ac867d9105e.
--
-- The customer-account keystone for The Cairn: customers sign in (Supabase Auth,
-- passwordless email magic-link — see auth seam note below), privately own their
-- archive (RLS, operator-blind), and the cross-product "free month" rule is
-- programmed into the data model. Billing is PROVIDER-AGNOSTIC — a clean seam,
-- no Stripe/Polar/Paddle hard-wiring, no provider keys.
--
-- This migration is a FILE ONLY. Per the founder dispatch + CLAUDE.md (HippoSwitch
-- Layer 1) the Supabase MCP is NOT used for this project. Apply via the Supabase
-- CLI with --db-url against mzjvcntzcfagasxcnuye, or via the Supabase SQL editor.
-- The web/worker service-role key (PostgREST) cannot run DDL. claude_app/Amanda
-- apply after review. Idempotent (IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT)
-- so it is safe to re-run.
--
-- RELATION TO EXISTING SCHEMA: `public.profiles` already exists (keyed to
-- auth.users; holds PII + suspension state — migration 005). This migration adds
-- a thin `public.accounts` anchor (1:1 with auth.users, account_id === auth.uid)
-- that subscriptions/entitlements hang off, WITHOUT recreating profiles. accounts
-- carries only operator-visible facts (existence, tier, status) — never content,
-- per the operator-blind rule.

SET search_path = public, pg_temp;

-- updated_at touch helper (shared; created in 006, re-asserted here for
-- standalone-apply safety).
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

-- ---------------------------------------------------------------------------
-- 1. accounts — the Cairn customer-account anchor. 1:1 with auth.users.
--    Operator-blind: an admin may read account existence/tier/status here, but
--    NEVER a customer's archive content (which lives in stones/galleries/
--    folder_items under their own RLS). A customer reads only their own row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.accounts (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Denormalised VERIFIED email, copied from auth.users at account creation.
  -- This is the identity used to match cross-product paid rescues (rule a).
  email       text,
  tier        text NOT NULL DEFAULT 'free'
                CHECK (tier IN ('free','paid')),
  status      text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','suspended','closed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.accounts IS
  'Cairn customer account anchor (1:1 auth.users). Operator may see existence/tier/status; never archive content.';

-- ---------------------------------------------------------------------------
-- 2. subscriptions — a customer's Cairn subscription. PROVIDER-AGNOSTIC: the
--    billing_provider column is a NULLABLE enum and provider_* ids are nullable.
--    Nothing here hard-wires Stripe/Polar/Paddle — the provider is chosen later
--    (the MoR decision is still open) and wired behind the billing seam.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id               uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  tier                     text NOT NULL DEFAULT 'free'
                             CHECK (tier IN ('free','paid')),
  storage_quota_gb         integer NOT NULL DEFAULT 0 CHECK (storage_quota_gb >= 0),
  status                   text NOT NULL DEFAULT 'none'
                             CHECK (status IN ('none','trialing','active','past_due','canceled','incomplete')),
  current_period_end       timestamptz,
  -- Nullable provider enum — null means "no provider wired yet". The set of
  -- allowed providers is fixed but the choice is deferred.
  billing_provider         text CHECK (billing_provider IN ('polar','paddle','stripe')),
  provider_customer_id     text,
  provider_subscription_id text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.subscriptions IS
  'Cairn subscriptions. Provider-agnostic: billing_provider is a nullable enum; no provider hard-wired. The PAID interlock for the free-month rule = a row with tier=paid AND status IN (trialing,active).';

CREATE INDEX IF NOT EXISTS subscriptions_account_idx
  ON public.subscriptions (account_id);
-- One live subscription row per account keeps the "is this customer paid?" test
-- unambiguous. (Historical/canceled rows are allowed; this partial unique index
-- only guards the active set.)
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_live_per_account_idx
  ON public.subscriptions (account_id)
  WHERE status IN ('trialing','active','past_due','incomplete');

-- ---------------------------------------------------------------------------
-- 3. entitlements — granted perks. The free storage month is recorded here.
--    Uniqueness guard (account_id, kind, source) makes every grant idempotent:
--    a given entitlement is granted AT MOST ONCE per account.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.entitlements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  kind         text NOT NULL,           -- e.g. 'free_storage_month'
  source       text NOT NULL,           -- e.g. 'paid_rescue_conversion'
  -- Which paid product earned this entitlement (free-month rule). Null for
  -- entitlements not sourced from a paid rescue.
  product_paid text CHECK (product_paid IN ('byteme','cairnferry')),
  quantity     integer NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  consumed_at  timestamptz,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Idempotency guard: at most one (kind, source) per account.
  CONSTRAINT entitlements_once_per_account UNIQUE (account_id, kind, source)
);

COMMENT ON TABLE public.entitlements IS
  'Granted perks. The cross-product free storage month lands here (kind=free_storage_month, source=paid_rescue_conversion). UNIQUE(account_id,kind,source) makes grants idempotent.';

CREATE INDEX IF NOT EXISTS entitlements_account_idx
  ON public.entitlements (account_id);

-- ---------------------------------------------------------------------------
-- 4. paid_rescues — ByteMe + CairnFerry paid-rescue records, in the SAME Cairn
--    Supabase project. The Cairn side queries this to test free-month rule (a):
--    "the same verified email has a COMPLETED PAID rescue (status='paid')".
--
--    NOTE: the ByteMe/CairnFerry PAID flows are NOT live yet, so these rows
--    won't exist yet. The table + lookup + granting logic are built so they
--    work correctly the moment paid rescues start landing. Those products will
--    INSERT a status='paid' row (service_role) when a rescue is paid for.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.paid_rescues (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product      text NOT NULL CHECK (product IN ('byteme','cairnferry')),
  -- Verified customer identity. Matched case-insensitively against accounts.email.
  email        text NOT NULL,
  -- Linked to a Cairn account once the same identity has one (nullable until then).
  account_id   uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','paid','refunded')),
  paid_at      timestamptz,
  -- Provider/order reference from the upstream rescue product (idempotent landing).
  external_ref text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.paid_rescues IS
  'Cross-product paid-rescue ledger (ByteMe + CairnFerry). The Cairn reads status=paid rows by verified email to test free-month rule (a). Upstream products write these when a rescue is paid. Not live yet.';

CREATE INDEX IF NOT EXISTS paid_rescues_email_idx
  ON public.paid_rescues (lower(email));
CREATE INDEX IF NOT EXISTS paid_rescues_account_idx
  ON public.paid_rescues (account_id);
-- Idempotent landing of an upstream paid rescue.
CREATE UNIQUE INDEX IF NOT EXISTS paid_rescues_product_extref_idx
  ON public.paid_rescues (product, external_ref)
  WHERE external_ref IS NOT NULL;

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
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
-- 5. Auto-provision an account row when a Supabase auth user is created.
--    Magic-link sign-in creates the auth.users row; this trigger gives the
--    customer their account anchor so they land in their own private archive.
--    SECURITY DEFINER so it can write public.accounts from the auth schema.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.accounts (id, email)
  VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_make_account ON auth.users;
CREATE TRIGGER on_auth_user_created_make_account
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_account();

-- ---------------------------------------------------------------------------
-- 6. THE FREE-MONTH RULE — founder-locked, built EXACTLY to spec.
--
--    Grant a 'one free storage month' on The Cairn ONLY when BOTH are true:
--      (a) the SAME customer identity (verified email) has a COMPLETED PAID
--          rescue on EITHER ByteMe OR CairnFerry (paid_rescues.status='paid'),
--      (b) that customer then starts a PAID Cairn subscription
--          (subscriptions.tier='paid' AND status IN ('trialing','active')).
--
--    NOT granted to waiting-list leads, free users, trial-only-without-paid-
--    rescue users, or anyone who has not paid for a rescue. Granted ONCE per
--    customer (idempotent via the entitlements uniqueness guard).
--
--    This function RECORDS the entitlement. Realising it as a 100%-off-first-
--    period / 1-month trial is left BEHIND THE BILLING PROVIDER SEAM (a clearly
--    marked TODO in the application layer) — no provider is wired here.
--
--    Returns the entitlement id when granted (or the already-existing one),
--    NULL when the rule is not satisfied.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.grant_free_storage_month(p_account_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_email          text;
  v_product_paid   text;
  v_has_paid_sub   boolean;
  v_entitlement_id uuid;
BEGIN
  -- Identity for matching (rule a).
  SELECT email INTO v_email FROM public.accounts WHERE id = p_account_id;
  IF v_email IS NULL THEN
    RETURN NULL; -- no verified identity → cannot match a paid rescue
  END IF;

  -- Rule (a): a COMPLETED PAID rescue on ByteMe OR CairnFerry for this identity.
  SELECT product INTO v_product_paid
  FROM public.paid_rescues
  WHERE status = 'paid'
    AND lower(email) = lower(v_email)
  ORDER BY paid_at NULLS LAST
  LIMIT 1;

  IF v_product_paid IS NULL THEN
    RETURN NULL; -- (a) not satisfied — never granted to non-paid-rescue customers
  END IF;

  -- Rule (b): the customer has STARTED A PAID Cairn subscription.
  SELECT EXISTS (
    SELECT 1 FROM public.subscriptions
    WHERE account_id = p_account_id
      AND tier = 'paid'
      AND status IN ('trialing','active')
  ) INTO v_has_paid_sub;

  IF NOT v_has_paid_sub THEN
    RETURN NULL; -- (b) not satisfied — leads/free/trial-only never qualify
  END IF;

  -- Both true → grant ONCE (idempotent). ON CONFLICT returns the existing row.
  INSERT INTO public.entitlements (account_id, kind, source, product_paid, metadata)
  VALUES (
    p_account_id,
    'free_storage_month',
    'paid_rescue_conversion',
    v_product_paid,
    jsonb_build_object('matched_email', lower(v_email))
  )
  ON CONFLICT (account_id, kind, source) DO NOTHING;

  SELECT id INTO v_entitlement_id
  FROM public.entitlements
  WHERE account_id = p_account_id
    AND kind = 'free_storage_month'
    AND source = 'paid_rescue_conversion';

  RETURN v_entitlement_id;
END;
$$;

COMMENT ON FUNCTION public.grant_free_storage_month(uuid) IS
  'Founder-locked free-month rule. Grants kind=free_storage_month ONLY when (a) a status=paid rescue exists for the account email AND (b) the account has a paid Cairn subscription. Idempotent. Realisation as a coupon/trial is a provider-seam TODO.';

-- ---------------------------------------------------------------------------
-- Grants. The backend (web + worker) uses the service-role key and bypasses
-- RLS, scoping every query to the authed user in code. The authenticated role
-- gets the minimal surface RLS then filters to own-rows.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.accounts, public.subscriptions, public.entitlements, public.paid_rescues
  TO service_role;

-- A customer may read (only) their own account, subscription and entitlements.
-- They may NOT read paid_rescues directly (cross-product ledger; service_role
-- only) and may NOT write subscriptions/entitlements (backend-granted only).
GRANT SELECT ON public.accounts      TO authenticated;
GRANT SELECT ON public.subscriptions TO authenticated;
GRANT SELECT ON public.entitlements  TO authenticated;

-- Only the backend may run the grant logic; it is SECURITY DEFINER and must not
-- be callable by end users (a customer cannot self-grant a free month).
REVOKE ALL ON FUNCTION public.grant_free_storage_month(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.grant_free_storage_month(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security — operator-blind, own-rows-only.
-- ---------------------------------------------------------------------------
ALTER TABLE public.accounts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entitlements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paid_rescues  ENABLE ROW LEVEL SECURITY;

-- accounts: a customer may read only their own account row.
DROP POLICY IF EXISTS accounts_owner_select ON public.accounts;
CREATE POLICY accounts_owner_select
  ON public.accounts
  FOR SELECT TO authenticated
  USING (id = auth.uid());

-- subscriptions: a customer may read only their own subscription rows. Writes
-- are service_role only (no authenticated INSERT/UPDATE policy by design).
DROP POLICY IF EXISTS subscriptions_owner_select ON public.subscriptions;
CREATE POLICY subscriptions_owner_select
  ON public.subscriptions
  FOR SELECT TO authenticated
  USING (account_id = auth.uid());

-- entitlements: a customer may read only their own entitlements. Writes are
-- service_role only (granting is backend logic; no self-grant).
DROP POLICY IF EXISTS entitlements_owner_select ON public.entitlements;
CREATE POLICY entitlements_owner_select
  ON public.entitlements
  FOR SELECT TO authenticated
  USING (account_id = auth.uid());

-- paid_rescues: NO authenticated policy. This is the cross-product ledger —
-- only service_role (which bypasses RLS) ever reads it. RLS-enabled with no
-- permissive policy means authenticated/anon see zero rows.
