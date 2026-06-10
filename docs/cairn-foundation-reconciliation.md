# The Cairn — Data Foundation: Live State & Reconciliation Map

**Dispatch:** `cairn-foundation-canvas-2026-06-10-a1` (VERIFY-LIVE-FIRST) · **Project:** The Cairn `mzjvcntzcfagasxcnuye`
**Authored:** 10 Jun 2026 · **Posture:** read-only verification + repo reconciliation. **No DDL, no deploy, no spend this session.**

## TL;DR

The entire BLESSED data foundation — migrations **008 (reworked)**, **009 (reworked)**, **010**, **011 (seams A–D)**, and **the Cairn's own canvas** — was **already applied LIVE** by the 3–8 Jun waves. This session **verified it against the spec and applied nothing** (the dispatch's "DO NOT re-apply anything already present" path). `node scripts/cairn-verify-foundation.js` certifies **48/48 gates GREEN** against the live schema.

The **live database is the source of truth** and is **ahead of the git repo**: `main` carries none of 008–011; the migration files live on scattered, unmerged feature branches behind a tangle of PRs. Reconciling those PRs into `main` is explicitly **Amanda's decision** (PR #10: "do not merge/close any PR this session").

## Spec → live mapping (all GREEN)

Governing specs: **5a50c3ac** (Build-Ready Reconciliation + Canvas Decision), **f4b74a9b** (Retention & Legacy, LOCKED), **d36881a1** (Safe-Landing + Remove≠Delete law).

| Layer | Spec requirement | Live on `mzjvcntzcfagasxcnuye` | ✓ |
|------|------------------|-------------------------------|---|
| Anchor (005) | account = `public.profiles` PK id = `auth.users.id` | `profiles` present | ✓ |
| **008** accounts/entitlements | FK → `auth.users`; founder-locked free-month interlock | `cairn_subscriptions`, `cairn_entitlements`, `cairn_paid_rescues`; `cairn_grant_free_storage_month()` EXECUTE = `service_role`/`postgres` only | ✓ |
| **009** content model | 4 `owner_id` FKs **repointed** `public.accounts(id)` → `auth.users(id)`; NO-DELETE; undo ring | `folder_items` (`status` soft-trash, `r2_key`), `stone_collections`, `stone_collection_items`, `undo_log` (+`undo_log_trim` trigger); all 4 `owner_id` → `auth.users(id)` | ✓ |
| **010** usage/namespace | append-only usage; collision-proof manifest | `cairn_usage_events` (own-row SELECT), `_product_namespace` seeded (`cairn_` + legacy billing) | ✓ |
| **Seam A** placement layer | `{memory_id, surface_id, x, y, scale, rotation, z, room/theme}`; own-row RLS; 0..n placements per memory | `cairn_surfaces` (kind/theme/config jsonb) + `cairn_placements` (full vocabulary; insert/update RLS also checks memory & surface are owner's) | ✓ |
| **Seam B** sealed Roberta space | locked **even from owner**; only Roberta's own systems | `cairn_roberta_space`: RLS on, **zero policies**, **no** authenticated/anon DML → `service_role` only | ✓ |
| **Seam C** retention + next-of-kin | state machine + clocks (bin 30d / legacy 12mo / cold free floor); next-of-kin = **notifier**; legacy reserve accounting | `cairn_retention_states` (state + `bin_grace_days=30`, `legacy_hold_months=12`, `quota_charged_to` user/legacy_reserve/free_floor), `cairn_retention_events`, `cairn_next_of_kin` (`CHECK role='notifier'`, `a_word`, `death_confirmed_at`), `cairn_legacy_reserve` (`reserve_pennies`, `monthly_accrual_pennies`) | ✓ |
| **Seam D** recall-metadata | user/Roberta tags & captions; **never** a machine classifier | `cairn_recall_metadata`: `CHECK authored_by IN (user, roberta)`, `CHECK kind IN (tag, caption)` | ✓ |
| **Canvas** | the Cairn's **own**, fresh; placements-over-vault; operator-blind; rich-media/scenes — **not** a copy of the Pod's | `cairn_surfaces`/`cairn_placements` (own tables, own-row RLS); Pod `pod_canvas*` tables absent here | ✓ |
| Cross-cutting | operator-blind; own-row RLS; NO-DELETE; Gate C | RLS on every data table; every policy `auth.uid()`-scoped; vault/append tables grant no customer DELETE; **every data table 0 rows** | ✓ |

## The one nuance vs. the literal dispatch text (reconciled, NOT a divergence)

The dispatch said "008 = PR #4 (FKs → auth.users)". The **live** 008 uses a **`cairn_` prefix** on the billing tables and has **no `accounts` table** (it anchors on the existing `profiles`). This is the **board-blessed Option A (prefix-in-public)** decision (minutes `e97d2527`), forced because a *different* product's LIVE `public.subscriptions` table already existed — a bare `subscriptions`/`accounts` 008 would have collided. PR #7 reworked PR #4/#6 accordingly and **supersedes PR #2/#3/#4/#6**. Spec 5a50c3ac's own 6 Jun update records this. So the live shape is the *fulfilled intent*, not a contradiction.

## Remove≠Delete: how it's encoded (so the gate isn't misread)

- **Vault** (`folder_items`) and **append/safety** tables (`undo_log`, `cairn_usage_events`, the 8 seam tables, billing) grant **no customer DELETE** — "delete" is quarantined to the vault, by the user's own hand, with the undo grace period.
- **Lens grouping** tables (`stone_collections`, `stone_collection_items`) *do* permit **owner-scoped** DELETE — removing a memory from a stack / disbanding a stack is a **"remove"**: zero effect on the vault, reversible via `undo_log`. This is the "you can't break anything behind a door" promise, and is intentional (PR #6 `removeFromStone`). The verifier asserts this delete stays owner-scoped (operator-blind), rather than banning it.
- Seam-A/C/D tables additionally carry a soft `set_aside_at` column for lens removal without any delete at all.

## PR tangle → recommended reconciliation (Amanda's call, NOT done here)

All foundation PRs are **open and unmerged**; `main` (`7f16052`) has none of them. Live DB = source of truth.

| PR | Branch | Carries | Status vs live | Recommendation |
|----|--------|---------|----------------|----------------|
| **#7** | `cairn-foundation-live-cairn-prefix` | reworked **008 + 009** (cairn_ prefix, auth.users FKs) | **APPLIED LIVE** | **Merge first** — the blessed foundation; supersedes #2/#3/#4/#6 |
| **#8** | `cairn-usage-events-and-namespace-manifest` | **010** | **APPLIED LIVE** | Merge after #7 |
| **#10** | `cairn-seams-a-d-migration-011` | **011** seams A–D | **APPLIED LIVE** | Merge after #8 (its base) |
| **#1** | `stone-columns-dedupe` | pure refactor (`STONE_PIPELINE_COLUMNS`), **no DDL** | independent | Merge any time (code-only) |
| **#9** | `cairn-phone-importer-backend` | importer endpoints, fail-closed until IWF | code; needs Gate C | Hold for IWF / Amanda |
| #2, #3, #4, #6 | (various) | superseded foundation attempts | **superseded by #7** | **Close** (no merge) |
| #5 | `cairn-accounts-entitlement-foundation` | early 008 | already **closed** | — |

> Migration files for what's live are scattered (three competing `008_*.sql`, one `009`, one `011`) across branches. Merging in the order above lands a `migrations/` tree that matches live. This session adds **only** the verifier + this map (no migration files), so it can merge independently without picking a winner among the competing files.

## Gate C — still HARD

Every foundation data table is **empty**. Per the LOCKED principle, **no real memories or photos — not even Amanda's — until the IWF scanner + safety spine are live.** All work to date is structure on experimental/placeholder data only.

## HippoFlow IP seam (canvas engine)

The Cairn's canvas is **data** (`cairn_surfaces` + `cairn_placements`, operator-blind, own-row). The reusable **rendering engine** is HippoFlow's, which the Cairn **rents** via a defined contract (Bloat-pluggable, never absorbed into Cairn IP). Not built here; flagged in 5a50c3ac as a confirm-when-formalised item, non-blocking.

## How to re-verify (anytime, touches nothing)

```bash
node scripts/cairn-verify-foundation.js   # full chain 008/009/010/011 + canvas → 48 gates
node scripts/cairn-verify-011.js          # seams A–D detail (kept for granularity)
```
Both use the Supabase Management API path (`scripts/cairn-db-query.js`, `SUPABASE_ACCESS_TOKEN`) per CLAUDE.md HippoSwitch Layer 1 — **not** the MCP, **not** the service-role PostgREST key.

## Minor hardening note (non-blocking, not a divergence)

Supabase-default `TRUNCATE`/`REFERENCES`/`TRIGGER` grants linger on `authenticated`/`anon` for some tables (e.g. `cairn_usage_events`). These are **not reachable via the PostgREST data API** (the only customer surface), so operator-blind + NO-DELETE hold in practice. A belt-and-braces `REVOKE TRUNCATE, REFERENCES, TRIGGER ON <tables> FROM authenticated, anon;` could be folded into a future additive migration if desired. No action taken this session (verify-only).
