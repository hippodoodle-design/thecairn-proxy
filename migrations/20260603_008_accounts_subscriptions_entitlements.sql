-- Migration 008 — accounts_subscriptions_entitlements
-- Wave Cairn Customer Accounts (3 Jun 2026), project The Cairn
-- (mzjvcntzcfagasxcnuye). Dispatch ced83e2e (claude_app, "customer accounts +
-- entitlement foundation"). BACKEND slice only — the sign-in UI is a separate
-- frontend pass (re-dispatched as product=thecairn-app-site).
--
-- The customer-account keystone: customers sign in (Supabase Auth, passwordless
-- magic-link — see docs/cairn-accounts-entitlements.md) and privately own their
-- archive. This migration layers the BILLING + ENTITLEMENT data model on top of
-- the EXISTING `public.profiles` account row (profiles already exists and is the
-- human-facing account anchor; we do NOT recreate it). It adds:
--   1. subscriptions      — provider-agnostic billing record (no provider wired)
--   2. entitlements       — granted perks, idempotent per (account, kind)
--   3. paid_rescues       — cross-product (ByteMe/CairnFerry) paid-rescue ledger
--   4. grant_free_storage_month() — the founder-locked free-month interlock
--
-- OPERATOR-BLIND POSTURE: every table here holds ACCOUNT METADATA ONLY (tier,
-- status, billing pointers, entitlements) — never archive CONTENT. An operator
-- with elevated access can see that an account exists and its tier/status, but
-- there is no path in this schema to a customer's media. Customer-facing RLS
-- scopes every row to auth.uid(); writes are backend-only (service_role).
--
-- BILLING IS PROVIDER-AGNOSTIC: billing_provider / provider_customer_id /
-- provider_subscription_id are all NULLABLE. No Polar/Paddle/Stripe is wired or
-- assumed — the Merchant-of-Record decision is still open. The actual coupon /
-- trial application for the free month is a clearly-marked seam (TODO) realised
-- later behind whichever provider is chosen; this migration only RECORDS the
-- entitlement.
--
-- APPLY NOTE (3 Jun 2026): per CLAUDE.md (HippoSwitch Layer 1), the Supabase MCP
-- is NOT used for this project. Apply via the Supabase CLI with --db-url against
-- project mzjvcntzcfagasxcnuye, or via the Supabase SQL editor. The web/worker
-- service-role key (PostgREST) cannot run DDL. claude_app / Amanda apply this
-- file; this is BRANCH-ONLY and is NOT applied by the CC session that wrote it.
-- Depends on `public.profiles` and `auth.users` already existing (they do).

SET search_path = public, pg_temp;

-- ===========================================================================
-- 1. subscriptions — one billing record per account, provider-agnostic.
--    account_id = auth.users(id), matching the user_companions / profiles
--    convention (profiles.id IS the auth user id). One row per account for now
--    (UNIQUE account_id); subscription HISTORY, if ever needed, is a later seam.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tier                     text NOT NULL DEFAULT 'free',
  storage_quota_gb         integer,
  status                   text NOT NULL DEFAULT 'inactive'
                             CHECK (status IN ('inactive','trialing','active','past_due','canceled')),
  current_period_end       timestamptz,
  -- Provider-agnostic seam. NULL until a Merchant-of-Record is chosen + wired.
  billing_provider         text
                             CHECK (billing_provider IS NULL
                                    OR billing_provider IN ('polar','paddle','stripe')),
  provider_customer_id     text,
  provider_subscription_id text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_account_uniq UNIQUE (account_id)
);

COMMENT ON TABLE public.subscriptions IS
  'One provider-agnostic billing record per account (account metadata, never content). billing_provider/* are NULL until a Merchant-of-Record is wired.';
COMMENT ON COLUMN public.subscriptions.tier IS
  'Plan tier (e.g. free / paid). A paid tier (<> ''free'') plus status active|trialing is what "starts a PAID Cairn subscription" means for the free-month rule.';
COMMENT ON COLUMN public.subscriptions.billing_provider IS
  'Nullable provider seam: ''polar''|''paddle''|''stripe''|NULL. Do NOT hard-wire a provider — the MoR decision is open.';

-- ===========================================================================
-- 2. entitlements — granted perks, recorded idempotently per (account, kind).
--    The uniqueness guard (account_id, kind) makes "grant once per customer"
--    enforced by the database, not just by application code.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.entitlements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  source        text NOT NULL,
  product_paid  text CHECK (product_paid IS NULL OR product_paid IN ('byteme','cairnferry')),
  quantity      integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  granted_at    timestamptz NOT NULL DEFAULT now(),
  consumed_at   timestamptz,
  CONSTRAINT entitlements_account_kind_uniq UNIQUE (account_id, kind)
);

COMMENT ON TABLE public.entitlements IS
  'Granted perks per account. UNIQUE(account_id, kind) guarantees a given entitlement is granted at most once per account (idempotent).';
COMMENT ON COLUMN public.entitlements.kind IS
  'e.g. ''free_storage_month''. The first entitlement kind is the paid-rescue -> Cairn free month.';
COMMENT ON COLUMN public.entitlements.source IS
  'How it was earned, e.g. ''paid_rescue_conversion''.';
COMMENT ON COLUMN public.entitlements.product_paid IS
  'For free_storage_month: which paid rescue earned it (''byteme'' or ''cairnferry'').';

-- ===========================================================================
-- 3. paid_rescues — cross-product paid-rescue ledger. ByteMe + CairnFerry live
--    in THIS same Supabase project, so they write their completed paid rescues
--    here and the Cairn side reads to test eligibility rule (a). The paid flows
--    are NOT live yet, so this table will be EMPTY until they start landing —
--    the lookup + grant logic below is built so it is correct the moment the
--    first paid rescue arrives. Identity match is by VERIFIED EMAIL.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.paid_rescues (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product     text NOT NULL CHECK (product IN ('byteme','cairnferry')),
  email       text NOT NULL,
  -- Nullable: a rescue may be paid before the customer ever signs up for Cairn.
  -- The free-month rule matches by verified email, so account_id is a convenience
  -- link, not the matching key.
  account_id  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','paid','refunded','failed')),
  paid_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.paid_rescues IS
  'Cross-product (ByteMe/CairnFerry) paid-rescue ledger. EMPTY until paid flows go live. Identity match for the Cairn free-month rule is by verified email (lower-cased).';

-- ===========================================================================
-- Indexes
-- ===========================================================================
CREATE INDEX IF NOT EXISTS subscriptions_status_idx          ON public.subscriptions (status);
CREATE INDEX IF NOT EXISTS subscriptions_provider_cust_idx   ON public.subscriptions (provider_customer_id);
CREATE INDEX IF NOT EXISTS entitlements_account_idx          ON public.entitlements (account_id);
CREATE INDEX IF NOT EXISTS paid_rescues_email_status_idx     ON public.paid_rescues (lower(email), status);
CREATE INDEX IF NOT EXISTS paid_rescues_account_idx          ON public.paid_rescues (account_id);

-- ===========================================================================
-- 4. grant_free_storage_month(p_account_id) — THE founder-locked interlock.
--
--    Grants a 'free_storage_month' entitlement to an account ONLY when BOTH:
--      (a) the SAME customer identity (matched by the account's verified email)
--          has a COMPLETED PAID rescue on ByteMe OR CairnFerry
--          (paid_rescues.status = 'paid'), AND
--      (b) that customer has STARTED A PAID Cairn subscription
--          (subscriptions.status IN ('active','trialing') AND tier <> 'free').
--
--    It is NOT granted to waiting-list leads, free users, trial-only-without-pay
--    users, or anyone who has not paid for a rescue. Granted ONCE per customer
--    via INSERT ... ON CONFLICT DO NOTHING on the (account_id, kind) guard, so
--    re-running is a safe no-op. Returns the entitlement id when granted (or the
--    pre-existing one), or NULL when the account is not (yet) eligible.
--
--    The actual coupon / 100%-off-first-period / 1-month-trial APPLICATION is a
--    SEAM realised later behind the chosen billing provider (see the TODO).
--    This function only RECORDS the earned entitlement.
--
--    SECURITY DEFINER + locked search_path so it can read auth.users.email; it is
--    intended to be called by the backend (service_role) at Cairn checkout.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.grant_free_storage_month(p_account_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_email        text;
  v_product_paid text;
  v_has_paid_sub boolean;
  v_entitlement  uuid;
BEGIN
  -- The account's verified email is the cross-product identity key.
  SELECT lower(email) INTO v_email FROM auth.users WHERE id = p_account_id;
  IF v_email IS NULL THEN
    RETURN NULL;  -- unknown account
  END IF;

  -- (a) a COMPLETED PAID rescue on either product, matched by email.
  --     Capture which product was paid (prefer the earliest paid rescue).
  SELECT product INTO v_product_paid
  FROM public.paid_rescues
  WHERE status = 'paid'
    AND lower(email) = v_email
  ORDER BY paid_at NULLS LAST, created_at
  LIMIT 1;

  IF v_product_paid IS NULL THEN
    RETURN NULL;  -- rule (a) not met: no completed paid rescue
  END IF;

  -- (b) this account has STARTED A PAID Cairn subscription.
  SELECT EXISTS (
    SELECT 1 FROM public.subscriptions
    WHERE account_id = p_account_id
      AND status IN ('active','trialing')
      AND tier <> 'free'
  ) INTO v_has_paid_sub;

  IF NOT v_has_paid_sub THEN
    RETURN NULL;  -- rule (b) not met: no paid Cairn subscription yet
  END IF;

  -- Both rules met. Record the entitlement exactly once (idempotent).
  INSERT INTO public.entitlements (account_id, kind, source, product_paid, quantity)
  VALUES (p_account_id, 'free_storage_month', 'paid_rescue_conversion', v_product_paid, 1)
  ON CONFLICT (account_id, kind) DO NOTHING
  RETURNING id INTO v_entitlement;

  -- ON CONFLICT skipped the row (already granted) -> fetch the existing id so the
  -- caller always gets the entitlement id when eligible.
  IF v_entitlement IS NULL THEN
    SELECT id INTO v_entitlement
    FROM public.entitlements
    WHERE account_id = p_account_id AND kind = 'free_storage_month';
  END IF;

  -- SEAM / TODO: realise the perk at Cairn checkout as a 100%-off-first-period or
  -- 1-month trial via whichever billing provider is later wired
  -- (billing_provider on subscriptions). Do NOT hard-wire a provider here.
  RETURN v_entitlement;
END;
$$;

COMMENT ON FUNCTION public.grant_free_storage_month(uuid) IS
  'Founder-locked interlock: grants free_storage_month iff (a) a paid ByteMe/CairnFerry rescue exists for the account email AND (b) the account has a paid Cairn subscription. Idempotent. Records the entitlement only; coupon/trial application is a provider seam (TODO).';

-- ===========================================================================
-- Grants. Backend (web + worker) uses service_role and bypasses RLS.
-- Customers (authenticated) get READ-ONLY access to their own rows — billing
-- writes are backend-driven, never client-driven.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.subscriptions, public.entitlements, public.paid_rescues
  TO service_role;

GRANT SELECT ON public.subscriptions TO authenticated;
GRANT SELECT ON public.entitlements  TO authenticated;
GRANT SELECT ON public.paid_rescues  TO authenticated;

-- The grant function is invoked by the backend (service_role).
GRANT EXECUTE ON FUNCTION public.grant_free_storage_month(uuid) TO service_role;

-- ===========================================================================
-- Row Level Security — every customer reads ONLY their own rows.
-- ===========================================================================
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entitlements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paid_rescues  ENABLE ROW LEVEL SECURITY;

-- subscriptions: owner reads own billing record. No client write policy —
-- billing state is mutated by the backend (service_role) only.
DROP POLICY IF EXISTS subscriptions_owner_select ON public.subscriptions;
CREATE POLICY subscriptions_owner_select
  ON public.subscriptions
  FOR SELECT TO authenticated
  USING (account_id = auth.uid());

-- entitlements: owner reads own entitlements. Backend-only writes.
DROP POLICY IF EXISTS entitlements_owner_select ON public.entitlements;
CREATE POLICY entitlements_owner_select
  ON public.entitlements
  FOR SELECT TO authenticated
  USING (account_id = auth.uid());

-- paid_rescues: owner reads paid rescues linked to their account_id. Cross-product
-- email matching for the rule itself runs in the SECURITY DEFINER function above,
-- not via client RLS (an unlinked rescue is not visible to the customer until the
-- billing backend links account_id). Backend-only writes.
DROP POLICY IF EXISTS paid_rescues_owner_select ON public.paid_rescues;
CREATE POLICY paid_rescues_owner_select
  ON public.paid_rescues
  FOR SELECT TO authenticated
  USING (account_id = auth.uid());
