# Cairn phone-importer — backend (thecairn-proxy)

Server-side half of the phone-importer. The frontend LIVE seam
(`thecairn-app` PR #11, `/bring-it-home`, gated by `VITE_CAIRN_IMPORT_LIVE=true`)
calls three JWT-auth endpoints on `VITE_CAIRN_BACKEND_URL`. This document is the
backend contract; the frontend-facing contract lives in
`thecairn-app/docs/cairn-phone-importer.md`.

Dispatch: `e1c0d2a7-phone-importer-backend` (board verdict `c3a8e1f6`).

## Status — built, fail-closed, no customer-facing arm yet

The endpoints are built and wired (`web/src/routes/import.js`), but the
**licensed IWF/known-CSAM hash-list is not yet provisioned**. Until it is, the
safety matcher (`shared/src/cairn-import/safety.js`) **fails CLOSED**: every
hash is treated as blocked and `safety-match` returns `503`. `/item` refuses to
store anything. There is no customer-facing import until the licence lands.

Activation is two locked steps (both required — a half-configured env can never
fail-open):

1. Set env: `CAIRN_IWF_HASHLIST_ENABLED=true` and `CAIRN_IWF_HASHLIST_URL=<source>`
   (plus its credential).
2. Implement `matchHashesLive()` in `shared/src/cairn-import/safety.js` against
   the confirmed hash-list contract and flip the in-file `LIVE_CLIENT_WIRED`
   lock to `true`.

## Guardrails (all enforced in code)

- **operator-blind** — own-row only (`owner_id = auth.uid()`), no all-users path.
- **hash-only safety** — the matcher receives only hashes; never media, never a
  human, never an AI classifier. It logs counts only, never the hash strings.
- **NO-DELETE** — items insert with `status='active'`; there is no delete path.
- **COPY-only** — no source-delete server path (the native app's later job).
- **fail-closed** — no licence ⇒ nothing allowed, nothing stored.

## Endpoints

All require `Authorization: Bearer <supabase-jwt>` and are rate-limited per user.

### `POST /api/import/safety-match`

Body `{ hashes: string[] }` (≤ 500) → `{ allow: string[], blocked: string[] }`.

Operator-blind, server-side match of client-computed hashes against the licensed
known-CSAM list. **Fail-closed:** while unprovisioned, returns `503`
`{ error: 'safety_unavailable', allow: [], blocked: <all hashes> }`.

### `POST /api/import/item`

Multipart `{ file, hash, meta(JSON), stack_id? }` → inserted `folder_items` row
(`201`).

1. Re-checks `hash` server-side (authoritative) before any store/insert —
   `503` if safety unavailable, `422` if blocked.
2. Stores the blob to R2 (EU bucket; set `R2_JURISDICTION=eu`). Key is opaque +
   owner-scoped (`cairn-import/<owner_id>/<uuid>`); no filename is carried in.
3. Inserts a `folder_items` row under the user's own row (`source='manual'`,
   `status='active'`), preserving `kind` / `mime_type` / `title` / `captured_at`
   from `meta`.
4. If `stack_id` is given (and owned by the user), links the item into that
   `stone_collections` stack via `stone_collection_items`.

### `POST /api/import/stack`

Body `{ name }` → inserted `stone_collections` row (`201`). Optional grouping
(e.g. `'Brought home <date>'`) under own-row RLS.

## Schema dependency

Relies on migration `009` (PR #7) being live on the Cairn DB
(`mzjvcntzcfagasxcnuye`): `folder_items`, `stone_collections`,
`stone_collection_items`. These were applied 4 Jun 2026.

## Test

```
node scripts/test-cairn-import.js
```

Verifies the matcher fails closed offline and that all three endpoints are wired
behind `requireAuth` (401 without a token, not 404). Live ingest (R2 + DB) is
exercised once the IWF licence lands.
