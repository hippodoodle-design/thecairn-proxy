# The Cairn — customer accounts + entitlement foundation

> Backend slice of dispatch **ced83e2e** (Wave Cairn Customer Accounts, 3 Jun 2026).
> Branch `cairn-customer-accounts-entitlements`. Migration **008**.
>
> This repo (`thecairn-proxy`) ships the **backend** only. The magic-link
> sign-in UI is **frontend** (`thecairn-app`, product `thecairn-app-site`) and is
> re-dispatched separately — see the routing note at the end.

## What this is

The customer-account keystone: customers sign in (Supabase Auth, passwordless
**magic-link** by default) and land in their own private archive. The data model
also programs the cross-product **"one free storage month"** rule so it works the
moment the ByteMe / CairnFerry paid flows go live.

It deliberately wires **no payment provider** and **no AI/voice** — both are
clean seams. Accounts are the prerequisite that later gates the companion
(Roberta) making cost-controlled AI/voice calls (dispatch bdb4720a + later).

## Data model (migration `20260603_008_cairn_accounts_entitlements.sql`)

| Table | Purpose | RLS |
| --- | --- | --- |
| `accounts` | One row per customer, 1:1 with `auth.users`. Account metadata only — `tier` (`free`/`paid`), `status`. `email` is a lower-cased copy of the verified auth email for the paid-rescue match. **No archive content lives here.** | Owner reads/inserts/updates only their own row (`id = auth.uid()`). |
| `subscriptions` | Cairn subscription. **Provider-agnostic**: `billing_provider` is a nullable enum `polar`/`paddle`/`stripe`, with nullable `provider_customer_id` / `provider_subscription_id`. Nothing is hard-wired. | Owner **reads** their own; writes are backend-only (service_role) — billing webhooks. |
| `entitlements` | Granted perks. `UNIQUE(account_id, kind)` makes every entitlement at-most-once per account (the idempotency guard). Home of `free_storage_month`. | Owner **reads** their own; grants are backend-only. |
| `paid_rescues` | Cross-product lookup of **completed paid rescues** on ByteMe / CairnFerry (same Cairn Supabase project). Read by the free-month rule. | **No authenticated access** — service_role only (system/operator data). |

**Operator-blind.** An admin (service_role) may see an account's *existence,
tier, and status*, but never a customer's archive content — content lives in the
stones/media tables under their own owner-only RLS. The account tables here hold
no content.

## The free-month rule (founder-locked, exact)

A `free_storage_month` is granted **only** when **both** are true:

- **(a)** the same customer identity (matched by **verified email**) has a
  **completed paid rescue** on **either** ByteMe **or** CairnFerry
  (`paid_rescues.status = 'paid'`), **and**
- **(b)** that customer then starts a **paid Cairn subscription**
  (`subscriptions.tier = 'paid'` and `status in ('trialing','active')`).

Never granted to waiting-list leads, free users, or trial-only users who haven't
paid for a rescue. Granted **once per customer** (idempotent via the `UNIQUE`
guard), recorded as an entitlement:

```
kind         = 'free_storage_month'
source       = 'paid_rescue_conversion'
product_paid = 'byteme' | 'cairnferry'
```

Implemented in `shared/src/entitlements/index.js` →
`grantFreeMonthIfEligible(supabase, { accountId, email })`. It returns a
structured outcome (`granted` + `reason`) and never throws on the expected
not-eligible paths. Reasons: `granted`, `already_granted`, `no_paid_rescue`,
`no_paid_subscription`, `no_account`, `schema_not_applied`, `lookup_error`,
`grant_error`.

> **paid_rescues is empty until the ByteMe/CairnFerry paid flows go live.** That
> is expected. The schema + lookup + granting logic are built so the perk lands
> automatically the moment a paid-rescue record appears.
>
> **Forward contract:** the ByteMe/CairnFerry paid-flow ingest must write
> `paid_rescues.email` **lower-cased** (the lookup matches on the normalised
> address; the index is on `lower(email)`).

## Billing seam (no provider wired)

`shared/src/billing/index.js` defines the provider interface. The MoR /
provider decision (Polar / Paddle / Stripe) is **still open**, so:

- `getBillingProvider()` returns the **null adapter** today (even a named
  `CAIRN_BILLING_PROVIDER` falls through until an adapter is built; an *unknown*
  name is a config error).
- `createCheckoutSession()` throws `BillingNotConfiguredError` — checkout
  genuinely can't happen without a provider.
- `applyFreeMonth()` no-ops (`{ applied: false, reason: 'no_provider' }`) so the
  entitlement can still be **recorded** without a provider present.

**TODO (provider):** realise a recorded `free_storage_month` at checkout as a
**100%-off-first-period / 1-month trial** using the chosen provider's coupon or
trial primitive. The entitlement row is the durable source of truth; the coupon
is its realisation.

## HTTP surface (`web/src/routes/account.js`)

- `GET /api/account` — ensures the account row exists (idempotent, on first
  authenticated call — no separate sign-up step), then returns the caller's own
  account + subscriptions + entitlements. Opportunistically self-heals the
  free-month grant if the account already has a paid subscription (best-effort).
- `POST /api/account/claim-free-month` — the checkout-time / post-payment trigger
  that evaluates the rule and records the entitlement if eligible (idempotent).

Both are behind `requireAuth` + `rateLimitPerUser`, like the rest of the API.

## Verify

```
node --env-file=.env scripts/test-accounts.js
```

Read-only schema round-trip against `mzjvcntzcfagasxcnuye`. Passes once migration
008 is applied; an empty `paid_rescues` is a pass. The rule + RLS + sign-in UI
are E2E (need a real auth user + JWT + frontend).

## Applying the migration

Per `CLAUDE.md` (HippoSwitch Layer 1) the Supabase **MCP is not used** for this
project, and this repo has no DB connection string — so a CC session writes the
migration file but **does not apply it**. Apply via the Supabase CLI with
`--db-url` against `mzjvcntzcfagasxcnuye`, or paste into the Supabase SQL editor
(claude_app / Amanda).

## What's a seam, not built (by design)

- **Payment provider** — no Polar/Paddle/Stripe wiring, no keys. Null adapter +
  TODO.
- **AI / voice** — none. The companion's paid voice/respond powers wait behind
  this accounts keystone + the gated AI path (later dispatch).
- **Magic-link sign-in UI** — frontend (`thecairn-app-site`). The backend
  already verifies Supabase tokens (`web/src/middleware/auth.js`); the sign-in
  screen, the Product UI Card Style, and Banana-Tested copy are re-dispatched to
  the frontend repo.
