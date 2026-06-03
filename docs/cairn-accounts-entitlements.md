# The Cairn — Customer Accounts + Entitlement Foundation

Backend keystone for The Cairn customer accounts, the provider-agnostic billing
seam, and the cross-product **free-month interlock**. Dispatched by claude_app
(`ced83e2e`, 3 Jun 2026) on Amanda's explicit GO.

> **Scope of THIS repo's slice.** `thecairn-proxy` is the backend monorepo
> (`web/` Express + `worker/` BullMQ + `shared/`). The deliverable here is the
> **data model + RLS + the free-month grant logic** as a reviewable migration
> file. The customer-facing **sign-in UI** (magic-link screen, the locked
> Product UI Card style) is **frontend** work and lives in `thecairn-app` — it
> was re-dispatched as `product=thecairn-app-site` so the frontend session
> builds it (the router routes `product=thecairn-app` only to this backend repo;
> see the cairn-build-topology note). Nothing here is applied or deployed.

Migration: `migrations/20260603_008_accounts_subscriptions_entitlements.sql`
(branch-only; **not applied** — see *Applying* below).

## 1. Authentication — passwordless magic-link

Customer sign-in uses **Supabase Auth, passwordless email magic-link** as the
default — calm, private, no password storage. After sign-in the customer lands
in their own private archive. OAuth is left as a clean seam (Supabase Auth
supports it natively) but is **not built now**.

The account identity is `auth.users.id`. The existing `public.profiles` row
(already present, keyed `profiles.id = auth.users.id`) is the human-facing
account anchor; this wave layers billing + entitlements onto it rather than
recreating it.

## 2. Account model + RLS — operator-blind

Every table added here holds **account metadata only** — tier, status, billing
pointers, entitlements — **never archive content**. Combined with the existing
content-table RLS, this preserves the operator-blind posture:

- An operator with elevated access can see that an **account exists** and its
  **tier / status**.
- There is **no path in this schema** to a customer's media. Media stays in the
  stones/galleries tables, which are already customer-scoped.
- Customer-facing RLS scopes every row to `auth.uid()`. **Writes are
  backend-only** (`service_role`); customers get `SELECT` on their own rows
  only — billing state is never client-mutable.

## 3. Subscriptions — provider-agnostic billing seam

`public.subscriptions` — one row per account (`UNIQUE(account_id)`):

| column | notes |
| --- | --- |
| `tier` | plan tier; a paid tier (`<> 'free'`) + active/trialing status = "started a paid Cairn subscription" |
| `storage_quota_gb` | nullable quota |
| `status` | `inactive` / `trialing` / `active` / `past_due` / `canceled` |
| `current_period_end` | nullable |
| `billing_provider` | **nullable** seam: `polar` / `paddle` / `stripe` / `NULL` |
| `provider_customer_id`, `provider_subscription_id` | **nullable** provider pointers |

**No provider is wired.** The Merchant-of-Record decision (Polar / Paddle /
Stripe) is still open, so the billing layer is a clean seam — `billing_provider`
and both provider id columns are nullable and unused until a provider is chosen.

## 4. Entitlements + the free-month rule (founder-locked)

`public.entitlements` records granted perks, with `UNIQUE(account_id, kind)` so
a given entitlement is **granted at most once per account** (DB-enforced
idempotency).

The first entitlement kind is the **paid-rescue → Cairn free storage month**.
The rule is exact and founder-locked. A `free_storage_month` is granted **only
when BOTH** are true:

- **(a)** the *same customer identity* (matched by **verified email**) has a
  **completed PAID rescue** on **ByteMe OR CairnFerry**
  (`paid_rescues.status = 'paid'`), **AND**
- **(b)** that customer has **started a PAID Cairn subscription**
  (`subscriptions.status IN ('active','trialing')` **and** `tier <> 'free'`).

It is **NOT** granted to waiting-list leads, free users, trial-only users, or
anyone who has not paid for a rescue. It is granted **once per customer**,
recorded as an entitlement with
`kind='free_storage_month'`, `source='paid_rescue_conversion'`,
`product_paid = 'byteme' | 'cairnferry'`.

Implemented as `public.grant_free_storage_month(account_id uuid)` —
`SECURITY DEFINER`, locked `search_path`, called by the backend at Cairn
checkout. It reads the account email, checks rules (a) and (b), and
`INSERT ... ON CONFLICT DO NOTHING` on the uniqueness guard (safe to re-run).
Returns the entitlement id when eligible (granted or pre-existing), `NULL`
otherwise.

> **SEAM / TODO:** the actual realisation of the perk — a 100%-off-first-period
> coupon or a 1-month trial — is applied **later behind the chosen billing
> provider**. The function only **records** the earned entitlement now.

## 5. Paid-rescue lookup (cross-product)

`public.paid_rescues` is the cross-product ledger. ByteMe and CairnFerry live in
this same Supabase project (`mzjvcntzcfagasxcnuye`), so their completed paid
rescues are written here, and the Cairn side queries it to test rule (a).

> **The ByteMe / CairnFerry paid flows are NOT live yet**, so this table will be
> **empty** until they start landing. The table + lookup + grant logic are built
> so they are correct the moment the first paid rescue arrives. Identity match
> is by **verified email** (lower-cased), not `account_id` — a rescue may be
> paid before the customer ever signs up for Cairn.

## Built here vs. deliberately left as a seam

**Built (backend, this PR):**

- `subscriptions`, `entitlements`, `paid_rescues` tables + indexes + RLS.
- Operator-blind, customer-read-only, backend-write data model keyed to
  `auth.users`.
- `grant_free_storage_month()` — the exact founder-locked interlock, idempotent.

**Seams left clean (NOT built — by design / by guardrail):**

- **Payment provider wiring** — no Polar/Paddle/Stripe keys, SDKs, webhooks, or
  coupon/trial application. The MoR decision is open.
- **Sign-in UI** — the magic-link screen + Product UI Card styling are frontend
  (`thecairn-app`), re-dispatched as `product=thecairn-app-site`.
- **OAuth** — Supabase Auth seam only; not built.
- **AI / voice (Roberta)** — none here. The accounts keystone is the prerequisite
  that later gates Roberta's paid voice/respond powers.

## Applying

**Not applied by the CC session that wrote it — branch + PR only.** Per
`CLAUDE.md` (HippoSwitch Layer 1), the Supabase MCP is not used for this project,
and the web/worker service-role key (PostgREST) cannot run DDL. claude_app /
Amanda apply migration 008 to project `mzjvcntzcfagasxcnuye` via the Supabase CLI
with `--db-url`, or via the Supabase SQL editor. Depends on `public.profiles` and
`auth.users` already existing.
