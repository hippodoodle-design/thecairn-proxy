-- Migration 009 — storage_stones_spine
-- Wave Cairn Storage + Stones Spine (3 Jun 2026), project The Cairn (mzjvcntzcfagasxcnuye).
-- Dispatch db871533-9c38-4059-9f43-3ff9ad90e1f0.
--
-- The dual-storage spine Amanda re-confirmed: a rescued person's memories land in
-- their ordinary, familiar FOLDER (the canonical store, R2-backed, EU) and can be
-- organised — by the User OR by Roberta — into STONES (named stacks/collections)
-- that REFERENCE the folder items without duplicating blobs. Plus a ~20-step UNDO
-- SPINE across folder + stone operations. Per-account, RLS own-data-only,
-- OPERATOR-BLIND (no admin/all-users media browse), NO-DELETE retention.
--
-- APPLY ORDER: this migration references public.accounts(id) from migration 008
-- (accounts foundation, dispatch ced83e2e). Apply 008 BEFORE 009.
--
-- FILE ONLY. Per CLAUDE.md (HippoSwitch Layer 1) the Supabase MCP is NOT used for
-- this project. Apply via the Supabase CLI with --db-url against mzjvcntzcfagasxcnuye
-- or the SQL editor; the service-role key (PostgREST) cannot run DDL. Idempotent
-- (IF NOT EXISTS / CREATE OR REPLACE) so it is safe to re-run.
--
-- TERMINOLOGY NOTE (engineering call, documented): the EXISTING public.stones
-- table holds individual URL-video memory items produced by the media pipeline
-- (owner_id, content_url, embedding, peakapoo). It is NOT a collection. The
-- product's "stones" (stacked-stone cairns) are NAMED COLLECTIONS the user/Roberta
-- curate. To avoid colliding with that existing table, this migration introduces
-- `stone_collections` + `stone_collection_items` for the collection layer, built
-- over a NEW canonical `folder_items` store (the rescued-media folder, fed by the
-- HippoDelivery deposit contract). Whether the URL-video `stones` items should one
-- day be unified into `folder_items` is a later decision (seam noted in code).

SET search_path = public, pg_temp;

-- updated_at touch helper (shared; re-asserted for standalone-apply safety).
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
-- 1. folder_items — the canonical per-account store ("the normal folder").
--    One row per rescued media item. The blob lives in Cloudflare R2 (EU);
--    this row references it by r2_key. Operator-blind (RLS own-only). NO-DELETE
--    retention: items are never hard-deleted — "trash" is a reversible soft
--    state (status='trashed') and the blob is retained.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.folder_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- Where this item came from. 'hippodelivery' = a finished rescue batch via the
  -- cairnward.js deposit contract; 'manual' = direct user add; others reserved.
  source          text NOT NULL DEFAULT 'hippodelivery'
                    CHECK (source IN ('hippodelivery','manual','media_pipeline','other')),
  source_batch_id text,                       -- the HippoDelivery batch reference
  kind            text NOT NULL DEFAULT 'other'
                    CHECK (kind IN ('photo','video','audio','document','other')),
  title           text,
  r2_key          text NOT NULL,              -- canonical blob location in R2
  r2_jurisdiction text NOT NULL DEFAULT 'eu', -- EU bucket by default
  mime_type       text,
  size_bytes      bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  captured_at     timestamptz,                -- original media date when known
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- NO-DELETE: 'active' or reversible 'trashed'. There is no hard-delete path.
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','trashed')),
  position        integer NOT NULL DEFAULT 0, -- folder ordering
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.folder_items IS
  'Canonical per-account rescued-media store (the normal folder). R2-backed (EU), operator-blind, NO-DELETE (trash is reversible). Stones reference these rows; blobs are never duplicated.';

CREATE INDEX IF NOT EXISTS folder_items_owner_status_idx
  ON public.folder_items (owner_id, status, position);
-- Idempotent landing of a deposited item: a given R2 object maps to one row.
CREATE UNIQUE INDEX IF NOT EXISTS folder_items_owner_r2key_idx
  ON public.folder_items (owner_id, r2_key);

-- ---------------------------------------------------------------------------
-- 2. stone_collections — the Cairn's named stacks ("stones"/cairns). A stone is
--    a curated collection of folder items. Owner-scoped.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stone_collections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id              uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name                  text NOT NULL DEFAULT 'Untitled stone',
  cover_folder_item_id  uuid REFERENCES public.folder_items(id) ON DELETE SET NULL,
  position              integer NOT NULL DEFAULT 0, -- ordering among the owner's stones
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.stone_collections IS
  'Named stone-stacks (cairns) — curated collections of folder items, by the user or Roberta. Owner-scoped, operator-blind.';

CREATE INDEX IF NOT EXISTS stone_collections_owner_idx
  ON public.stone_collections (owner_id, position);

-- ---------------------------------------------------------------------------
-- 3. stone_collection_items — membership join. References folder_items; the
--    blob is NOT duplicated. owner_id is denormalised so RLS is a single-table
--    check. A folder item appears at most once per stone.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stone_collection_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id  uuid NOT NULL REFERENCES public.stone_collections(id) ON DELETE CASCADE,
  folder_item_id uuid NOT NULL REFERENCES public.folder_items(id) ON DELETE CASCADE,
  owner_id       uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  position       integer NOT NULL DEFAULT 0, -- order within the stone
  -- Who added it: the user, or Roberta (the companion curating on their behalf).
  added_by       text NOT NULL DEFAULT 'user' CHECK (added_by IN ('user','roberta')),
  added_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stone_collection_items_unique UNIQUE (collection_id, folder_item_id)
);

COMMENT ON TABLE public.stone_collection_items IS
  'Stone membership. References folder_items (no blob duplication). added_by tracks user vs Roberta curation. UNIQUE(collection_id, folder_item_id).';

CREATE INDEX IF NOT EXISTS stone_collection_items_collection_idx
  ON public.stone_collection_items (collection_id, position);
CREATE INDEX IF NOT EXISTS stone_collection_items_folder_idx
  ON public.stone_collection_items (folder_item_id);

-- ---------------------------------------------------------------------------
-- 4. undo_log — the Undo Spine. A per-account ring of recent reversible
--    operations across folder + stone actions. `before`/`after` carry the
--    snapshot needed to reverse (or replay) the op. Capped to ~20 most-recent
--    ops per owner by the trigger below.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.undo_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq          bigint GENERATED ALWAYS AS IDENTITY,  -- monotonic op ordering
  owner_id     uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  op           text NOT NULL CHECK (op IN (
                 'folder_trash','folder_restore','folder_rename','folder_reorder',
                 'stone_create','stone_rename','stone_reorder',
                 'copy_to_stone','remove_from_stone','stone_item_reorder')),
  target_table text NOT NULL,
  target_id    uuid,
  before       jsonb,   -- state before the op (for reversal)
  after        jsonb,   -- state after the op (for replay / redo)
  undone_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.undo_log IS
  'Undo Spine: per-account ring (~20 ops) of reversible folder + stone operations. before/after snapshots drive reversal. Capped by trim_undo_log trigger.';

CREATE INDEX IF NOT EXISTS undo_log_owner_seq_idx
  ON public.undo_log (owner_id, seq DESC);

-- Ring cap: keep only the newest ~20 ops per owner. Runs after each insert.
CREATE OR REPLACE FUNCTION public.trim_undo_log()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.undo_log u
  WHERE u.owner_id = NEW.owner_id
    AND u.seq <= (
      SELECT seq FROM public.undo_log
      WHERE owner_id = NEW.owner_id
      ORDER BY seq DESC
      OFFSET 20 LIMIT 1
    );
  RETURN NULL; -- AFTER trigger; return value ignored
END;
$$;

DROP TRIGGER IF EXISTS undo_log_trim ON public.undo_log;
CREATE TRIGGER undo_log_trim
  AFTER INSERT ON public.undo_log
  FOR EACH ROW EXECUTE FUNCTION public.trim_undo_log();

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS folder_items_touch_updated_at ON public.folder_items;
CREATE TRIGGER folder_items_touch_updated_at
  BEFORE UPDATE ON public.folder_items
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS stone_collections_touch_updated_at ON public.stone_collections;
CREATE TRIGGER stone_collections_touch_updated_at
  BEFORE UPDATE ON public.stone_collections
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Grants. Backend (web + worker) uses the service-role key (bypasses RLS,
-- scopes in code). authenticated gets own-row reads + the curation writes the
-- frontend performs directly under RLS. Deposits into folder_items are
-- backend-only (service_role) — they come from HippoDelivery, not the client.
-- There is NO admin/all-users path anywhere (operator-blind).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.folder_items, public.stone_collections, public.stone_collection_items, public.undo_log
  TO service_role;

-- folder_items: read own; update own (rename / trash / restore / reorder). No
-- client INSERT (deposits are backend) and no DELETE (NO-DELETE retention).
GRANT SELECT, UPDATE ON public.folder_items TO authenticated;

-- stone_collections: full own-curation surface for the frontend.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stone_collections TO authenticated;

-- stone_collection_items: own-curation incl. DELETE (= remove-from-stone, which
-- is membership only and reversible via undo; the folder blob is untouched).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.stone_collection_items TO authenticated;

-- undo_log: read own undo stack; writes are backend-recorded (service_role).
GRANT SELECT ON public.undo_log TO authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security — operator-blind, own-rows-only across the whole spine.
-- ---------------------------------------------------------------------------
ALTER TABLE public.folder_items           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stone_collections      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stone_collection_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.undo_log               ENABLE ROW LEVEL SECURITY;

-- folder_items: read + update only your own.
DROP POLICY IF EXISTS folder_items_owner_select ON public.folder_items;
CREATE POLICY folder_items_owner_select
  ON public.folder_items FOR SELECT TO authenticated
  USING (owner_id = auth.uid());

DROP POLICY IF EXISTS folder_items_owner_update ON public.folder_items;
CREATE POLICY folder_items_owner_update
  ON public.folder_items FOR UPDATE TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- stone_collections: full own CRUD.
DROP POLICY IF EXISTS stone_collections_owner_all ON public.stone_collections;
CREATE POLICY stone_collections_owner_all
  ON public.stone_collections FOR ALL TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- stone_collection_items: full own CRUD. The WITH CHECK also enforces that the
-- referenced stone + folder item belong to the same owner (no cross-account
-- stitching).
DROP POLICY IF EXISTS stone_collection_items_owner_all ON public.stone_collection_items;
CREATE POLICY stone_collection_items_owner_all
  ON public.stone_collection_items FOR ALL TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (
    owner_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.stone_collections c
                 WHERE c.id = collection_id AND c.owner_id = auth.uid())
    AND EXISTS (SELECT 1 FROM public.folder_items f
                 WHERE f.id = folder_item_id AND f.owner_id = auth.uid())
  );

-- undo_log: read your own stack only. (No authenticated write policy — backend
-- records ops under service_role.)
DROP POLICY IF EXISTS undo_log_owner_select ON public.undo_log;
CREATE POLICY undo_log_owner_select
  ON public.undo_log FOR SELECT TO authenticated
  USING (owner_id = auth.uid());
