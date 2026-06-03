# Cairn Customer Accounts + Entitlements (backend slice)

Wave: **Cairn Customer Accounts + Entitlement Foundation** (3 Jun 2026, dispatch
`ced83e2e`). Backend keystone that lets customers privately own their archive and
programs the cross-product "free month" rule into the data model. This is the
prerequisite that later gates the companion (Roberta) making cost-controlled
AI/voice calls.

This repo (`thecairn-proxy`) ships the **backend slice only**. The magic-link
sign-in UI + "your archive" landing are **frontend** (`thecairn-app`) and are
re-dispatched separately as `product=thecairn-app-site`.

## What this slice contains

- **`migrations/20260603_008_cairn_customer_accounts.sql`** — reviewable migration
  file. NOT applied (CLAUDE.md forbids the Supabase MCP for this project; the
  service-role key is PostgREST-only and cannot run DDL). Apply via the Supabase
  CLI `--db-url` against `mzjvcntzcfagasxcnuye` or the SQL editor.
- **`shared/src/accounts/index.js`** (`@cairn/shared/accounts`) — the
  provider-agnostic seam: the free-month predicate (mirror of the SQL rule for
  backend reasoning) + the billing-provider seam description.
- **`scripts/test-cairn-accounts.js`** — read-only verify (run after apply).

## Data model

| table | purpose | who writes | who reads |
|---|---|---|---|
| `profiles` | 1:1 with `auth.users`; identity + verified email | owner | owner (RLS) |
| `subscriptions` | tier / status / quota; provider-agnostic billing seam | backend only | owner (RLS) |
| `entitlements` | discrete grants (the free month); idempotent | backend only | owner (RLS) |
| `paid_rescues` | cross-product paid-rescue lookup (ByteMe/CairnFerry) | backend only | **internal — service_role only** |
| `account_overview` (view) | operator-blind admin window: existence + tier + status | — | **service_role only** |

**Operator-blind:** an admin may see *accounts* (existence, tier, status) via
`account_overview`, but **never content**. Content tables stay owner-only RLS;
this migration adds no admin path to content. `paid_rescues` has RLS on with no
policy, so only `service_role` (which bypasses RLS) can touch it.

## The free-month rule (founder-locked — do not loosen)

One free storage month is granted **only** when BOTH are true:

1. the **same verified-email identity** has a **completed PAID rescue**
   (`status='paid'`) on **ByteMe OR CairnFerry**, AND
2. that customer then starts a **PAID, ACTIVE Cairn subscription**.

Never for waiting-list leads, free users, or trial-only users. Granted **once**
per customer (idempotent via `UNIQUE(account_id, kind, source)`), recorded as an
`entitlement` (`kind='free_storage_month'`, `source='paid_rescue_conversion'`,
`product_paid` = the rescue product).

The rule is the SQL function `public.grant_free_month_if_eligible(account_id)`
(single source of truth) and is mirrored as a pure predicate in
`@cairn/shared/accounts` `freeMonthEligibility()`. ByteMe/CairnFerry paid flows
are **not live yet**, so `paid_rescues` is empty for now — the table + lookup +
granting logic are built so the rule fires the moment paid rescues land.

## Deliberate seams (NOT built this wave)

- **Billing provider** — `billing_provider` is a nullable enum
  (`polar|paddle|stripe`), NULL until chosen. No provider wired, no keys. The
  coupon/100%-off-first-period realisation of the free month is a marked
  `TODO(provider-seam)` in the migration + the seam stub in `@cairn/shared/accounts`.
- **OAuth** — magic-link is the default; a clean seam is left for OAuth later.
- **AI / voice** — none wired. Accounts are the keystone that later gates
  Roberta's paid voice/respond powers.
