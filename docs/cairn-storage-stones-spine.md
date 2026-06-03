# Cairn storage + stones spine

Backend dual-storage on LIVE per-account data. Dispatch `db871533`. Branch-only;
migration is FILE-ONLY (apply to `mzjvcntzcfagasxcnuye` after review, **after**
migration 008).

## The shape

```
HippoDelivery rescue ──(cairnward deposit contract)──▶ folder_items   (the "normal folder": canonical R2/EU store, NO-DELETE)
                                                          │
                                          copy-to-stone (User OR Roberta, no blob copy)
                                                          ▼
                              stone_collections ◀── stone_collection_items (membership join → folder_items)

every reversible op ──▶ undo_log  (per-account ~20-step ring; before/after snapshots)
```

- **folder_items** — one row per rescued item; the blob lives in Cloudflare R2
  (EU); `r2_key` references it. `status` is `active`/`trashed` only — **no hard
  delete** (retention). Operator-blind (RLS own-only).
- **stone_collections** — named stacks (the product's "stones"/cairns).
- **stone_collection_items** — membership; references `folder_items`, never
  duplicates the blob. `added_by` = `user` | `roberta`.
- **undo_log** — ~20-step ring (trigger-capped) across folder + stone ops.

### Terminology note
The existing `public.stones` table holds **URL-video media-pipeline items** — it
is NOT a collection. The product's stone-stacks are the new `stone_collections` +
`stone_collection_items` over `folder_items`. Unifying URL-video `stones` into
`folder_items` is a deliberate later decision (seam), not done here.

## Endpoints (`/api/cairn`, own data only, operator-blind)

| Method + path | What |
|---|---|
| `POST /deposit` | **service-to-service** (HippoDelivery). Bearer `CAIRN_DEPOSIT_SECRET`. Lands a deposit batch as folder_items (idempotent on `owner_id,r2_key`). 501 when the secret is unset (seam). |
| `GET /folder` | the account's folder (`?trashed=1` to include trashed) |
| `POST /folder/:id/trash` · `/restore` · `/rename` | reversible folder ops |
| `GET /stones` · `POST /stones` · `POST /stones/:id/rename` | stones |
| `GET /stones/:id/items` | items in a stone (joined to folder_items) |
| `POST /stones/:id/items` | copy-to-stone `{ folderItemId, addedBy }` |
| `DELETE /stones/:id/items/:folderItemId` | remove from stone (membership only) |
| `POST /undo` · `GET /undo` | undo the last op / read the undo stack |

## Live vs seamed
- **Live-data-ready:** every endpoint reads/writes REAL Supabase rows for the
  signed-in account under RLS. No placeholder rows.
- **Seam — deposit auth:** `CAIRN_DEPOSIT_SECRET` shared-secret today; real
  HippoDelivery service auth (signed handoff / mTLS) is a later hardening pass.
  Not in `required_env_vars` — the endpoint is a no-op (501) until set.
- **Seam — R2 byte placement:** the deposit records `r2_key`s; placing the bytes
  in R2 is HippoDelivery's job (the deposit precondition). Reading items back uses
  the existing `signR2Url` path (`/api/r2`).
- **Seam — Roberta curation:** membership can be tagged `added_by='roberta'`, but
  no AI/voice is wired (gated later behind the accounts keystone).
- **Paired frontend:** the "my memories are really here" folder + stones view on
  live rows is `thecairn-app-site` (dispatch `a8bec1ef` / re-dispatch line).

## Apply order
`008_accounts_entitlements_foundation.sql` → `009_storage_stones_spine.sql`
(009 references `public.accounts(id)`). Verify with `scripts/test-storage-spine.js`.
