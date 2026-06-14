-- Migration 011 — cairn_roberta_memory (ADDITIVE, PREVIEW — NOT YET APPLIED)
-- The notebook Roberta keeps for each user: a durable, per-user, server-side
-- store for the small precious things a person tells her.
-- Dispatch cairn-roberta-user-memory-lock-2026-06-14. Project The Cairn
-- (mzjvcntzcfagasxcnuye). Under Amanda's keep-building authority; APPLY is
-- Amanda's tap (see APPLY NOTE).
--
-- THE LAW THIS TABLE LOCKS — "Infinite Append, Constant Render" (Amanda lock,
-- 14 Jun 2026). The whole point of this table is to make the law structurally
-- true, not merely promised in code:
--   • ALWAYS ROOM — never "full". content is unbounded `text`; there is NO
--     per-user row cap, NO size ceiling, NO retention/TTL, NO archive, NO purge.
--     There is always room for one more thing. Storage headroom is the spec.
--   • NEVER TRUNCATE — nothing the user shared is ever rubbed out or aged off.
--     This is enforced at the PRIVILEGE layer: service_role is granted SELECT +
--     INSERT only — NOT UPDATE, NOT DELETE. The backend literally cannot edit or
--     remove a memory. Append-only by construction, not by convention.
--   • SMALL THINGS COUNT — one row per small thing; the tiny is treated as
--     precious. No "importance" gate, no scoring that could drop the quiet ones.
--   • WHOLE RECORD, NOT THE TOP — the (user_id, created_at) index serves an
--     ordered read of the ENTIRE record. Recall draws on all of it; never trust
--     only the most-recent slice (same lesson as the stale-handover).
--
-- OPERATOR-BLIND (privacy_consent, this dispatch): NO human — including Amanda —
-- browses a user's memories. There is NO admin/operator read path and NO grant
-- to any human-facing role. RLS lets the OWNER read only their own rows
-- (auth.uid() = user_id). service_role bypasses RLS but is ONLY ever Roberta's
-- brain process recalling for THAT user's turn — it never renders to an operator.
-- Surfacing a memory back to the user is ask-before-you-show: Roberta OFFERS,
-- she never auto-reveals (enforced in the persona/brain layer, not the DB).
--
-- The ONE erasure path that exists is the user's OWN right: ON DELETE CASCADE
-- from auth.users. If a user is deleted (their choice / their data right), their
-- notebook goes with them. That is user-initiated erasure, NOT truncation or
-- aging-off — the law forbids US rubbing things out, never the user.
--
-- POSTURE: ADDITIVE + NON-DESTRUCTIVE + IDEMPOTENT. Nothing existing is altered,
-- renamed, or dropped. Uses the going-forward cairn_ namespace (migration 010
-- manifest, board verdict e97d2527). Safe to re-run (IF NOT EXISTS throughout).
--
-- APPLY NOTE: per CLAUDE.md (HippoSwitch Layer 1) the Supabase MCP is NOT used
-- for this project. PREVIEW ONLY in this dispatch — this file is BUILT, not
-- applied. Production is Amanda's tap: apply via the Supabase Management API
-- database/query endpoint with the project access token (sbp_…, reaches
-- mzjvcntzcfagasxcnuye) — NOT the service-role PostgREST key (cannot run DDL).
-- Depends on auth.users already existing (it does).

SET search_path = public, pg_temp;

-- ===========================================================================
-- cairn_roberta_memory — Roberta's per-user notebook. Append-only, unbounded,
-- own-row, operator-blind. One row per small precious thing the user shared.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS public.cairn_roberta_memory (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- kind: a gentle label for the sort of thing this is (e.g. 'note', 'name',
  -- 'trait', 'date', 'wish'). A LABEL only — the content is the user's words.
  -- Plain text, not an enum (Choices Stay Open): the label set widens freely.
  kind        text NOT NULL DEFAULT 'note',
  -- content: the small thing itself, in (or faithful to) the user's own words.
  -- UNBOUNDED on purpose — always room for one more; never truncated.
  content     text NOT NULL CHECK (length(btrim(content)) > 0),
  -- source: who recorded it ('roberta' when the brain noted it; 'user' if the
  -- user asked her to remember it explicitly). Provenance, never a gate.
  source      text NOT NULL DEFAULT 'roberta',
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cairn_roberta_memory IS
  'The Cairn: Roberta''s per-user notebook — the small precious things a person tells her. Locks "Infinite Append, Constant Render" (Amanda, 14 Jun 2026): unbounded content, NO row cap / TTL / archive / purge (always room), append-only by privilege (service_role has SELECT+INSERT only — NO UPDATE/DELETE, nothing ever rubbed out), whole-record recall via (user_id, created_at). Operator-blind: own-row RLS, no admin read path; recall feeds only Roberta''s brain for that user''s turn; surfacing is ask-before-you-show. Sole erasure path is the user''s own ON DELETE CASCADE from auth.users. Added (PREVIEW) by migration 011, dispatch cairn-roberta-user-memory-lock-2026-06-14.';
COMMENT ON COLUMN public.cairn_roberta_memory.content IS
  'The user''s small thing, in their words. Unbounded; never truncated. Treated as untrusted text when recalled into the prompt — screened by robertaGuard like any client-supplied note.';

-- Whole-record, ordered recall (NOT a recent-slice). Also covers per-user reads.
CREATE INDEX IF NOT EXISTS cairn_roberta_memory_user_created_idx
  ON public.cairn_roberta_memory (user_id, created_at);

-- Grants. service_role (Roberta's brain) appends + reads. It is DELIBERATELY
-- NOT granted UPDATE or DELETE — append-only is enforced here, at the privilege
-- layer, so the law cannot be broken by a future code change. The owner reads
-- their own rows; there is NO human/operator/admin read grant (operator-blind).
--
-- IMPORTANT — Supabase grants ALL on every new public table to anon, authenticated
-- and service_role by DEFAULT (via default privileges). That silently hands back
-- UPDATE + DELETE + TRUNCATE and would defeat the append-only-by-privilege law
-- above. So we REVOKE the lot first and then grant back ONLY what each role may
-- have. Idempotent and scoped to THIS new table only (nothing existing is touched).
-- After this, the privilege set is exactly:
--   service_role  → SELECT, INSERT  (append + whole-record recall; CANNOT update/delete/truncate)
--   authenticated → SELECT          (own-row read via RLS; nothing else)
--   anon          → (nothing)
REVOKE ALL ON public.cairn_roberta_memory FROM anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.cairn_roberta_memory TO service_role;
GRANT SELECT ON public.cairn_roberta_memory TO authenticated;

ALTER TABLE public.cairn_roberta_memory ENABLE ROW LEVEL SECURITY;

-- Owner reads own memories. No client write policy (backend-written via
-- service_role). No UPDATE policy and no DELETE policy anywhere — nothing the
-- user shared is ever rubbed out (the only removal is the auth.users cascade).
DROP POLICY IF EXISTS cairn_roberta_memory_owner_select ON public.cairn_roberta_memory;
CREATE POLICY cairn_roberta_memory_owner_select
  ON public.cairn_roberta_memory
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- Record the table in the family namespace manifest (collision-proofing, mig 010).
INSERT INTO public._product_namespace (prefix, product_name, owner_role, notes)
VALUES (
  'cairn_roberta_memory',
  'The Cairn — Roberta per-user memory',
  'service_role',
  'Append-only per-user memory notebook (mig 011). cairn_ namespace. Append-only by privilege (no UPDATE/DELETE grant); unbounded; operator-blind own-row RLS. Locks Infinite Append, Constant Render (Amanda, 14 Jun 2026).'
)
ON CONFLICT (prefix) DO NOTHING;
