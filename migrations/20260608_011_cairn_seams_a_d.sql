-- Migration 011 — The Cairn SEAMS A–D (ADDITIVE)
-- Project The Cairn (mzjvcntzcfagasxcnuye). Dispatch cairn-seams-A-D-2026-06-08-a1.
-- Governing specs (relayed verbatim on cairn-specs:bonnie-bothy-cloud, 8 Jun 2026):
--   5a50c3ac (build-ready reconciliation + canvas decision),
--   f4b74a9b (retention & legacy, LOCKED),
--   d36881a1 (UX/safety: Safe-Landing + Remove≠Delete language law).
--
-- WHY NOW: the foundation (008 cairn_ billing, 009 content model, 010 usage/namespace)
-- is ALREADY LIVE + verified on mzjvcntzcfagasxcnuye (PRs #7/#8). The four seams below
-- are the pieces that are painful to retrofit, so they are cut as a single additive
-- migration on top of the as-built foundation (spec 5a50c3ac: "BUILD THESE AS ADDITIVE
-- MIGRATION 011").
--
-- POSTURE (held on EVERY new table/column — dispatch hard gates):
--   • ADDITIVE + NON-DESTRUCTIVE + IDEMPOTENT — nothing existing is altered/renamed/dropped.
--   • OWN-ROW RLS — every table carries user_id → auth.users(id); owners see only their own.
--   • OPERATOR-BLIND — these tables hold placements/coords, sealed guardian context,
--     retention labels, contact metadata, accounting pennies, and USER/Roberta-authored
--     tags. NO archive content. No machine ever reads media here.
--   • NO-DELETE — no DELETE is granted to anyone on any new table. "Removing" something
--     from a lens (a room, a tag) is a SOFT set-aside (set_aside_at), never a row delete.
--     This is the schema-level enforcement of the Remove≠Delete language law (d36881a1):
--     lens actions are consequence-free for the vault; the ONLY place a real delete ever
--     happens is the vault itself, by the user's own hand — and when that happens, the
--     ON DELETE CASCADE below cleans up the dangling LENS rows (never the reverse).
--   • FK → auth.users(id) for ownership; FK → public.folder_items(id) for the vault object
--     ("a memory" = the one true copy: folder_items carries r2_key/r2_jurisdiction).
--
-- APPLY NOTE: per CLAUDE.md (HippoSwitch Layer 1) the Supabase MCP is NOT used for this
-- project, and the service-role PostgREST key cannot run DDL. Applied via the Supabase
-- Management API database/query endpoint with the project access token (sbp_…, reaches
-- mzjvcntzcfagasxcnuye) — see scripts/cairn-db-query.js. Safe to re-run.
--
-- EXPERIMENTAL DATA ONLY (Gate C): the IWF safety spine must be LIVE before ANY real data.
-- This migration is schema/structure only.

SET search_path = public, pg_temp;

-- ===========================================================================
-- SEAM A — PLACEMENT LAYER  (spec 5a50c3ac §A)
--   "One vault copy, many lenses." A memory (folder_item) has 0..n placements.
--   A placement pins a memory onto a SURFACE (a room/place/themed canvas surface =
--   DATA not code) at {x, y, scale, rotation, z}. Removing a placement = "remove from
--   the room" — consequence-free for the vault (Remove≠Delete).
-- ===========================================================================

-- A.1 cairn_surfaces — a room / place / themed canvas surface. DATA, not code.
--     The canvas the Cairn builds FRESH in mzjvcntzcfagasxcnuye (spec 5a50c3ac canvas
--     decision): placements over the vault, own-row RLS, operator-blind.
CREATE TABLE IF NOT EXISTS public.cairn_surfaces (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'room',   -- room | place | wall | path | market (lens surface types)
  name         text,
  theme        text,                            -- the room/theme label (spec: placement belongs to a room/theme)
  config       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- scene/canvas configuration — DATA not code, never media content
  position     integer,
  set_aside_at timestamptz,                      -- soft "tuck away / set aside" a room — vault untouched (Remove≠Delete)
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cairn_surfaces_kind_chk CHECK (kind IN ('room','place','wall','path','market'))
);

COMMENT ON TABLE public.cairn_surfaces IS
  'The Cairn SEAM A: a room/place/themed canvas surface (DATA not code) that memories are placed onto. One Vault, Many Lenses — a surface is a LENS over the vault, never a copy of it. Own-row RLS, operator-blind (no media content), NO-DELETE (rooms are set aside via set_aside_at, never row-deleted). Migration 011 (dispatch cairn-seams-A-D-2026-06-08-a1).';
COMMENT ON COLUMN public.cairn_surfaces.config IS
  'Canvas/scene configuration for this surface (layout, theme accents) — DATA only. NEVER archive media or content.';
COMMENT ON COLUMN public.cairn_surfaces.set_aside_at IS
  'Soft-removal timestamp. Setting a room aside is a LENS action with ZERO effect on the vault (Remove≠Delete law, d36881a1). There is no row delete.';

CREATE INDEX IF NOT EXISTS cairn_surfaces_user_idx ON public.cairn_surfaces (user_id);

-- A.2 cairn_placements — a memory pinned onto a surface at a transform.
--     A memory has 0..n placements (one vault copy, many lenses).
CREATE TABLE IF NOT EXISTS public.cairn_placements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  memory_id    uuid NOT NULL REFERENCES public.folder_items(id) ON DELETE CASCADE,  -- the vault object ("a memory")
  surface_id   uuid NOT NULL REFERENCES public.cairn_surfaces(id) ON DELETE CASCADE,
  x            double precision NOT NULL DEFAULT 0,
  y            double precision NOT NULL DEFAULT 0,
  scale        double precision NOT NULL DEFAULT 1,
  rotation     double precision NOT NULL DEFAULT 0,
  z            integer NOT NULL DEFAULT 0,
  theme        text,                              -- optional per-placement room/theme override (room/theme primarily lives on the surface)
  set_aside_at timestamptz,                        -- soft "remove from this room" — vault untouched (Remove≠Delete)
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cairn_placements IS
  'The Cairn SEAM A: pins a memory (folder_items = the one true vault copy) onto a cairn_surface at {x,y,scale,rotation,z}. A memory has 0..n placements — one vault copy, many lenses. memory_id/surface_id CASCADE so a real VAULT delete (user''s own hand) cleans up lens rows; the reverse never happens — removing a placement is a SOFT set_aside (NO-DELETE). Own-row RLS, operator-blind. Migration 011 (cairn-seams-A-D-2026-06-08-a1).';
COMMENT ON COLUMN public.cairn_placements.memory_id IS
  'FK to folder_items(id) — the vault object ("a memory"). ON DELETE CASCADE encodes Remove≠Delete: only a real vault delete removes the memory, which then sweeps its placements; removing a placement never touches this.';
COMMENT ON COLUMN public.cairn_placements.set_aside_at IS
  'Soft-removal timestamp. Removing a memory from a room is a LENS action, ZERO effect on the vault (d36881a1). No row delete.';

CREATE INDEX IF NOT EXISTS cairn_placements_user_idx    ON public.cairn_placements (user_id);
CREATE INDEX IF NOT EXISTS cairn_placements_surface_idx ON public.cairn_placements (surface_id);
CREATE INDEX IF NOT EXISTS cairn_placements_memory_idx  ON public.cairn_placements (memory_id);

-- ===========================================================================
-- SEAM B — SEALED PER-USER ROBERTA SPACE  (spec 5a50c3ac §B)
--   Locked EVEN FROM THE OWNER. Holds Roberta's safety context / guardian memory.
--   "Only we can open it" = Roberta's OWN SYSTEMS (the backend / service_role) use it,
--   NOT human staff browsing. Stays operator-blind.
--   Enforcement: RLS ENABLED + ZERO policies + NO grants to authenticated/anon =>
--   the owner (and everyone but service_role, which bypasses RLS) is sealed out.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.cairn_roberta_space (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,  -- one sealed space per user
  sealed_context jsonb NOT NULL DEFAULT '{}'::jsonb,  -- guardian/safety context — NEVER human-browsable, never media content
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cairn_roberta_space IS
  'The Cairn SEAM B: a per-user SEALED space for Roberta''s own systems — locked EVEN FROM THE OWNER (protects the guardian from corruption; holds safety context). Reachable ONLY by Roberta''s backend systems (service_role bypasses RLS); RLS is enabled with NO policy and there are NO grants to authenticated/anon, so no human (owner OR staff) can browse it. Operator-blind, NO-DELETE. Migration 011 (cairn-seams-A-D-2026-06-08-a1).';
COMMENT ON COLUMN public.cairn_roberta_space.sealed_context IS
  'Roberta''s sealed guardian/safety context. NEVER human-browsable, NEVER archive media. Written/read only by Roberta''s own systems (service_role).';

-- ===========================================================================
-- SEAM C — RETENTION-STATE + NEXT-OF-KIN lifecycle  (spec f4b74a9b, LOCKED)
--   Every stored object has a STATE + a CLOCK (rule-based timers, no AI judgement,
--   fully audited — legitimate retention crons, Tail-Doctrine exception):
--     live → in_the_bin (30d, COUNTS ON THE USER'S OWN QUOTA) → truly gone
--     legacy_hold (12 months, funded by the legacy reserve, after CONFIRMED death)
--       → heir's own paid Cairn  OR  cold_free_file_floor (raw files, FREE, link ~12mo)
--   next_of_kin = NOTIFIER, NOT HEIR (a human hand confirms a death before anything
--   triggers; no missed login ever wakes a memorial). Legacy reserve = a few pennies/mo
--   baked into every subscription, pre-funding each member's own dignified wind-down.
-- ===========================================================================

-- C.1 cairn_retention_states — the live STATE + CLOCK for each vault object.
CREATE TABLE IF NOT EXISTS public.cairn_retention_states (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  memory_id         uuid NOT NULL UNIQUE REFERENCES public.folder_items(id) ON DELETE CASCADE,  -- one state row per vault object
  state             text NOT NULL DEFAULT 'live',
  state_entered_at  timestamptz NOT NULL DEFAULT now(),
  clock_expires_at  timestamptz,                  -- when the current state's rule-based clock runs out (bin +30d, legacy_hold +12mo, cold link ~12mo)
  quota_charged_to  text NOT NULL DEFAULT 'user', -- who the clock counts against: user (own quota) | legacy_reserve | free_floor
  bin_grace_days    integer NOT NULL DEFAULT 30,  -- in_the_bin clock, on the user's OWN quota (rule-based, audited)
  legacy_hold_months integer NOT NULL DEFAULT 12, -- legacy-hold window (LOCKED at 12 months, f4b74a9b)
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cairn_retention_state_chk
    CHECK (state IN ('live','in_the_bin','legacy_hold','cold_free_file_floor')),
  CONSTRAINT cairn_retention_quota_chk
    CHECK (quota_charged_to IN ('user','legacy_reserve','free_floor'))
);

COMMENT ON TABLE public.cairn_retention_states IS
  'The Cairn SEAM C: per-vault-object retention STATE + CLOCK (f4b74a9b, LOCKED). States: live / in_the_bin (30d on the USER''S OWN quota, undo spine = not a cliff) / legacy_hold (12mo, after CONFIRMED death, funded by legacy reserve) / cold_free_file_floor (raw files, FREE, link ~12mo). Rule-based clocks only — no AI judgement; transitions audited in cairn_retention_events (legitimate retention crons, Tail-Doctrine exception). Operator-blind (labels/timestamps, no content), own-row RLS, NO-DELETE. Migration 011 (cairn-seams-A-D-2026-06-08-a1).';
COMMENT ON COLUMN public.cairn_retention_states.quota_charged_to IS
  'WHO PAYS for the current state''s storage clock: ''user'' (a living user''s own removals sit on their own quota), ''legacy_reserve'' (death/limbo, pre-funded), ''free_floor'' (cold free-file floor, free moral floor).';

CREATE INDEX IF NOT EXISTS cairn_retention_states_user_idx  ON public.cairn_retention_states (user_id);
CREATE INDEX IF NOT EXISTS cairn_retention_states_state_idx ON public.cairn_retention_states (state, clock_expires_at);

-- C.2 cairn_retention_events — append-only audit of every state transition (audited clocks).
CREATE TABLE IF NOT EXISTS public.cairn_retention_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  retention_state_id  uuid NOT NULL REFERENCES public.cairn_retention_states(id) ON DELETE CASCADE,
  memory_id           uuid REFERENCES public.folder_items(id) ON DELETE CASCADE,
  from_state          text,
  to_state            text NOT NULL,
  reason              text,                         -- the rule that fired (e.g. 'bin_clock_expired', 'death_confirmed')
  occurred_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cairn_retention_events IS
  'The Cairn SEAM C: append-only audit log of retention state transitions — the "fully audited" requirement of the rule-based clocks (f4b74a9b). Records WHICH rule fired and WHEN. Operator-blind, own-row RLS, append-only / NO-DELETE. Migration 011 (cairn-seams-A-D-2026-06-08-a1).';

CREATE INDEX IF NOT EXISTS cairn_retention_events_state_idx ON public.cairn_retention_events (retention_state_id, occurred_at);

-- C.3 cairn_next_of_kin — NOTIFIER, not heir (LOCK enforced by CHECK).
CREATE TABLE IF NOT EXISTS public.cairn_next_of_kin (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,  -- the subscriber who named them
  role               text NOT NULL DEFAULT 'notifier',  -- LOCK: notifier ONLY, never heir
  contact_name       text,
  contact_email      text,
  contact_phone      text,
  relationship       text,
  a_word             text,                          -- inheritance can carry a 'word' attached (f4b74a9b)
  notified_at        timestamptz,                   -- when the next-of-kin notified the Cairn (a human hand)
  death_confirmed_at timestamptz,                   -- only a confirmed human hand wakes a memorial — never a missed login
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cairn_next_of_kin_role_chk CHECK (role = 'notifier')
);

COMMENT ON TABLE public.cairn_next_of_kin IS
  'The Cairn SEAM C: next-of-kin = NOTIFIER, NOT HEIR (f4b74a9b LOCK, enforced by cairn_next_of_kin_role_chk). Their ONLY role is to NOTIFY the Cairn so a human hand confirms a death before anything triggers — no missed login ever wakes a memorial. The will + annual-review wishes decide WHAT happens; an inheritance may carry a ''word'' (a_word). Own-row RLS, operator-blind (the subscriber''s own contact metadata), NO-DELETE. Migration 011 (cairn-seams-A-D-2026-06-08-a1).';
COMMENT ON COLUMN public.cairn_next_of_kin.role IS
  'LOCKED to ''notifier''. A next-of-kin NOTIFIES of a death; they are NOT an heir and gain no access to the vault. Heirship is a separate paid-Cairn transfer.';

CREATE INDEX IF NOT EXISTS cairn_next_of_kin_user_idx ON public.cairn_next_of_kin (user_id);

-- C.4 cairn_legacy_reserve — legacy-reserve accounting (pre-funds dignified wind-down).
CREATE TABLE IF NOT EXISTS public.cairn_legacy_reserve (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  reserve_pennies         bigint NOT NULL DEFAULT 0,    -- accrued legacy reserve for this member
  monthly_accrual_pennies integer NOT NULL DEFAULT 0,   -- the few pennies/month baked into the subscription (exact figure set at pricing finalise — OPEN, defaults 0)
  currency                text NOT NULL DEFAULT 'GBP',
  last_accrued_at         timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cairn_legacy_reserve IS
  'The Cairn SEAM C: per-member legacy-reserve accounting (f4b74a9b). A few pennies/month baked invisibly into every subscription FOR the subscriber, pre-paying their own dignified wind-down so the platform never chases a grieving person. The exact pennies figure is OPEN until pricing finalise (monthly_accrual_pennies defaults 0). Own-row RLS, operator-blind, NO-DELETE. Migration 011 (cairn-seams-A-D-2026-06-08-a1).';

-- ===========================================================================
-- SEAM D — RECALL-METADATA  (spec 5a50c3ac §D)
--   User/Roberta-authored tags & captions ONLY. NO machine classifier ever reads the
--   content — that is how search is solved WITHOUT breaking operator-blind. The
--   authored_by CHECK is the schema-level guarantee: only 'user' or 'roberta' may
--   author recall metadata; there is no value a content-reading classifier could use.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.cairn_recall_metadata (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  memory_id    uuid NOT NULL REFERENCES public.folder_items(id) ON DELETE CASCADE,  -- the vault object the tag/caption recalls
  kind         text NOT NULL DEFAULT 'tag',     -- tag | caption
  value        text NOT NULL,                   -- the tag or caption text (authored, never machine-extracted from content)
  authored_by  text NOT NULL DEFAULT 'user',    -- user | roberta — NEVER a machine classifier on content
  set_aside_at timestamptz,                       -- soft-remove a tag/caption — vault untouched (Remove≠Delete)
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cairn_recall_kind_chk        CHECK (kind IN ('tag','caption')),
  CONSTRAINT cairn_recall_authored_by_chk CHECK (authored_by IN ('user','roberta'))
);

COMMENT ON TABLE public.cairn_recall_metadata IS
  'The Cairn SEAM D: USER- or Roberta-authored tags/captions for recall (search). The cairn_recall_authored_by_chk CHECK enforces authored_by IN (user, roberta) — there is NO machine classifier reading media content, which is exactly how recall/search is solved WITHOUT breaking operator-blind (spec 5a50c3ac §D). Own-row RLS, operator-blind, NO-DELETE (tags are set aside via set_aside_at, never row-deleted). Migration 011 (cairn-seams-A-D-2026-06-08-a1).';
COMMENT ON COLUMN public.cairn_recall_metadata.authored_by IS
  'Who authored this tag/caption: ''user'' or ''roberta''. NEVER a machine classifier that read the media — that would break operator-blind. Enforced by cairn_recall_authored_by_chk.';

CREATE INDEX IF NOT EXISTS cairn_recall_metadata_memory_idx ON public.cairn_recall_metadata (memory_id);
CREATE INDEX IF NOT EXISTS cairn_recall_metadata_user_value_idx ON public.cairn_recall_metadata (user_id, value);

-- ===========================================================================
-- GRANTS + RLS  (own-row, operator-blind, NO-DELETE on every new table)
--   No DELETE is granted anywhere. "Removing" from a lens is a soft set_aside (UPDATE).
--   Vault deletes happen elsewhere (folder_items) and CASCADE into these lens rows.
-- ===========================================================================

-- SEAM A: cairn_surfaces — owner manages own; no delete.
GRANT SELECT, INSERT, UPDATE ON public.cairn_surfaces TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.cairn_surfaces TO service_role;
ALTER TABLE public.cairn_surfaces ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cairn_surfaces_owner_select ON public.cairn_surfaces;
CREATE POLICY cairn_surfaces_owner_select ON public.cairn_surfaces
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS cairn_surfaces_owner_insert ON public.cairn_surfaces;
CREATE POLICY cairn_surfaces_owner_insert ON public.cairn_surfaces
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS cairn_surfaces_owner_update ON public.cairn_surfaces;
CREATE POLICY cairn_surfaces_owner_update ON public.cairn_surfaces
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- SEAM A: cairn_placements — owner manages own; INSERT/UPDATE also enforce that the
-- referenced memory AND surface are the user's OWN (operator-blind cross-ownership guard).
GRANT SELECT, INSERT, UPDATE ON public.cairn_placements TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.cairn_placements TO service_role;
ALTER TABLE public.cairn_placements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cairn_placements_owner_select ON public.cairn_placements;
CREATE POLICY cairn_placements_owner_select ON public.cairn_placements
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS cairn_placements_owner_insert ON public.cairn_placements;
CREATE POLICY cairn_placements_owner_insert ON public.cairn_placements
  FOR INSERT TO authenticated WITH CHECK (
    user_id = auth.uid()
    AND memory_id  IN (SELECT id FROM public.folder_items   WHERE owner_id = auth.uid())
    AND surface_id IN (SELECT id FROM public.cairn_surfaces  WHERE user_id  = auth.uid())
  );
DROP POLICY IF EXISTS cairn_placements_owner_update ON public.cairn_placements;
CREATE POLICY cairn_placements_owner_update ON public.cairn_placements
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (
    user_id = auth.uid()
    AND memory_id  IN (SELECT id FROM public.folder_items   WHERE owner_id = auth.uid())
    AND surface_id IN (SELECT id FROM public.cairn_surfaces  WHERE user_id  = auth.uid())
  );

-- SEAM B: cairn_roberta_space — SEALED. No grants to authenticated at all; RLS on with
-- NO policy. Only service_role (Roberta's own systems) reaches it. Locked even from owner.
GRANT SELECT, INSERT, UPDATE ON public.cairn_roberta_space TO service_role;
ALTER TABLE public.cairn_roberta_space ENABLE ROW LEVEL SECURITY;
-- (intentionally NO policy and NO authenticated grant — the owner is sealed out.)

-- SEAM C: cairn_retention_states — owner may read own object's state; writes are backend
-- (rule-based crons via service_role). No client write policy, no delete.
GRANT SELECT ON public.cairn_retention_states TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.cairn_retention_states TO service_role;
ALTER TABLE public.cairn_retention_states ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cairn_retention_states_owner_select ON public.cairn_retention_states;
CREATE POLICY cairn_retention_states_owner_select ON public.cairn_retention_states
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- SEAM C: cairn_retention_events — owner may read own audit; backend appends. Append-only.
GRANT SELECT ON public.cairn_retention_events TO authenticated;
GRANT SELECT, INSERT ON public.cairn_retention_events TO service_role;
ALTER TABLE public.cairn_retention_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cairn_retention_events_owner_select ON public.cairn_retention_events;
CREATE POLICY cairn_retention_events_owner_select ON public.cairn_retention_events
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- SEAM C: cairn_next_of_kin — owner manages own; no delete.
GRANT SELECT, INSERT, UPDATE ON public.cairn_next_of_kin TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.cairn_next_of_kin TO service_role;
ALTER TABLE public.cairn_next_of_kin ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cairn_next_of_kin_owner_select ON public.cairn_next_of_kin;
CREATE POLICY cairn_next_of_kin_owner_select ON public.cairn_next_of_kin
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS cairn_next_of_kin_owner_insert ON public.cairn_next_of_kin;
CREATE POLICY cairn_next_of_kin_owner_insert ON public.cairn_next_of_kin
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS cairn_next_of_kin_owner_update ON public.cairn_next_of_kin;
CREATE POLICY cairn_next_of_kin_owner_update ON public.cairn_next_of_kin
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- SEAM C: cairn_legacy_reserve — owner may read own accounting; backend accrues. No delete.
GRANT SELECT ON public.cairn_legacy_reserve TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.cairn_legacy_reserve TO service_role;
ALTER TABLE public.cairn_legacy_reserve ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cairn_legacy_reserve_owner_select ON public.cairn_legacy_reserve;
CREATE POLICY cairn_legacy_reserve_owner_select ON public.cairn_legacy_reserve
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- SEAM D: cairn_recall_metadata — owner manages own; INSERT/UPDATE enforce the memory is
-- the user's OWN. No delete (tags are set aside, never row-deleted).
GRANT SELECT, INSERT, UPDATE ON public.cairn_recall_metadata TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.cairn_recall_metadata TO service_role;
ALTER TABLE public.cairn_recall_metadata ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cairn_recall_metadata_owner_select ON public.cairn_recall_metadata;
CREATE POLICY cairn_recall_metadata_owner_select ON public.cairn_recall_metadata
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS cairn_recall_metadata_owner_insert ON public.cairn_recall_metadata;
CREATE POLICY cairn_recall_metadata_owner_insert ON public.cairn_recall_metadata
  FOR INSERT TO authenticated WITH CHECK (
    user_id = auth.uid()
    AND memory_id IN (SELECT id FROM public.folder_items WHERE owner_id = auth.uid())
  );
DROP POLICY IF EXISTS cairn_recall_metadata_owner_update ON public.cairn_recall_metadata;
CREATE POLICY cairn_recall_metadata_owner_update ON public.cairn_recall_metadata
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (
    user_id = auth.uid()
    AND memory_id IN (SELECT id FROM public.folder_items WHERE owner_id = auth.uid())
  );

-- ===========================================================================
-- NAMESPACE MANIFEST — record the new cairn_ tables in the collision-proofing manifest
-- (additive note; idempotent). Keeps _product_namespace honest about the Cairn footprint.
-- ===========================================================================
UPDATE public._product_namespace
   SET notes = notes || ' | Migration 011 seams A–D added: cairn_surfaces, cairn_placements, cairn_roberta_space, cairn_retention_states, cairn_retention_events, cairn_next_of_kin, cairn_legacy_reserve, cairn_recall_metadata.'
 WHERE prefix = 'cairn_'
   AND position('Migration 011' in notes) = 0;
