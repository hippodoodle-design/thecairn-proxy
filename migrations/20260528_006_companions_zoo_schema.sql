-- Migration 006 — companions_zoo_schema
-- Wave Cairn Companions Foundation (28 May 2026), project The Cairn (mzjvcntzcfagasxcnuye).
--
-- The Companion Principle, implemented at the schema level. Companions live in
-- a Zoo when the device is closed (no Tamagotchi anxiety — no feeding, no
-- stress). A user picks + keeps pet(s); the pet travels with them and returns
-- to the Zoo on close. Names live on the accessory layer. Cosmetic-only, free
-- forever. Same pet across sessions/devices/time. The 1D/2D/3D dimension axis
-- lets the same companion render flat-as-a-child's-drawing, polished, or
-- immersive — identity (name + accessory) persists across the switch. And the
-- magic move: a user can upload a child's drawing and it becomes a unique-to-
-- them 1D companion (is_user_uploaded=true), held in the Zoo alongside curated
-- illustration without ranking.
--
-- Canonical principle doc: Notion page 35bdfeff-1b02-8116-ba1a-dceca4e74def.
-- Implementation reference: docs/companion-principle.md in this repo.
--
-- APPLY NOTE (28 May 2026): per CLAUDE.md (HippoSwitch Layer 1), the Supabase
-- MCP is NOT used for this project. Apply via the Supabase CLI with --db-url
-- against project mzjvcntzcfagasxcnuye, or via the Supabase SQL editor. The
-- web/worker service-role key (PostgREST) cannot run DDL.

SET search_path = public, pg_temp;

-- ---------------------------------------------------------------------------
-- 1. companions — registry of available species (curated illustration set).
--    Public read; this is the shelf of pets a user can choose from.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.companions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                   text UNIQUE NOT NULL,
  display_name           text NOT NULL,
  dimensions_available   text[] NOT NULL DEFAULT ARRAY['1d','2d','3d']::text[],
  default_accessory_slots text[] NOT NULL DEFAULT ARRAY['collar','jersey','shorts']::text[],
  asset_paths            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                 text NOT NULL DEFAULT 'live'
                           CHECK (status IN ('live','requested','in-illustration')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.companions IS
  'Registry of available companion species. Cosmetic-only, free. status=live rows are pickable.';

-- ---------------------------------------------------------------------------
-- 2. user_companions — a user''s chosen pet(s). companion_id is NULL for a
--    user-uploaded 1D pet (the drawing IS the companion). The pet lives here
--    forever once chosen; status flips active <-> in_zoo <-> retired but the
--    row (and the name + accessory) is never destroyed — it''s the user''s
--    memory.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_companions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  companion_id             uuid REFERENCES public.companions(id) ON DELETE SET NULL,
  is_user_uploaded         boolean NOT NULL DEFAULT false,
  user_uploaded_asset_path text,
  custom_name              text,
  accessory                jsonb,
  preferred_dimension      text NOT NULL DEFAULT '2d'
                             CHECK (preferred_dimension IN ('1d','2d','3d')),
  chosen_at                timestamptz NOT NULL DEFAULT now(),
  last_active_at           timestamptz,
  in_zoo_at                timestamptz,
  status                   text NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','in_zoo','retired')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  -- A user-uploaded pet must carry its asset path; a registry pet must
  -- reference a companion. Exactly one origin.
  CONSTRAINT user_companions_origin_chk CHECK (
    (is_user_uploaded = true  AND user_uploaded_asset_path IS NOT NULL)
    OR
    (is_user_uploaded = false AND companion_id IS NOT NULL)
  )
);

COMMENT ON TABLE public.user_companions IS
  'A user''s companions (current + retired). Never hard-deleted; retired pets stay in the Zoo as the user''s memory.';

-- ---------------------------------------------------------------------------
-- 3. companion_events — audit log of every meaningful moment in a pet''s life.
--    Written by the backend (service_role). Readable by the owning user so
--    the UI can show "welcome back" beats etc.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.companion_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_companion_id  uuid NOT NULL REFERENCES public.user_companions(id) ON DELETE CASCADE,
  event              text NOT NULL
                       CHECK (event IN (
                         'picked','named','accessory_changed','dimension_changed',
                         'returned_to_zoo','left_zoo','retired','uploaded_1d')),
  payload            jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.companion_events IS
  'Append-only audit log for companion lifecycle events. Rolling retention TBD (Data Earns Its Keep).';

-- ---------------------------------------------------------------------------
-- 4. species_requests — user-submitted requests for new species. Cultural
--    representation explicitly welcomed. Insertable by any authed user;
--    readable only by the team (service_role).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.species_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  species_requested     text NOT NULL,
  reason                text,
  cultural_significance text,
  submitted_at          timestamptz NOT NULL DEFAULT now(),
  status                text NOT NULL DEFAULT 'new'
                          CHECK (status IN ('new','reviewing','accepted','declined','illustrating','added'))
);

COMMENT ON TABLE public.species_requests IS
  'User-requested species. Team reviews + adds quarterly. Cultural significance prioritised.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS user_companions_user_status_idx
  ON public.user_companions (user_id, status);
CREATE INDEX IF NOT EXISTS companion_events_uc_occurred_idx
  ON public.companion_events (user_companion_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS species_requests_status_idx
  ON public.species_requests (status);

-- ---------------------------------------------------------------------------
-- updated_at touch trigger (shared helper; create if this project doesn't
-- already have one, otherwise reuse). Idempotent via CREATE OR REPLACE.
-- ---------------------------------------------------------------------------
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

DROP TRIGGER IF EXISTS companions_touch_updated_at ON public.companions;
CREATE TRIGGER companions_touch_updated_at
  BEFORE UPDATE ON public.companions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS user_companions_touch_updated_at ON public.user_companions;
CREATE TRIGGER user_companions_touch_updated_at
  BEFORE UPDATE ON public.user_companions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Grants. The backend (web + worker) uses the service-role key and bypasses
-- RLS; it scopes every query to the authenticated user_id in code. The
-- authenticated role gets exactly the surface RLS then filters.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.companions, public.user_companions, public.companion_events, public.species_requests
  TO service_role;

-- companions: public, read-only registry.
GRANT SELECT ON public.companions TO authenticated, anon;

-- user_companions: owner reads + writes own rows (RLS enforces ownership).
GRANT SELECT, INSERT, UPDATE ON public.user_companions TO authenticated;

-- companion_events: owner reads own pet's events; writes are service_role only.
GRANT SELECT ON public.companion_events TO authenticated;

-- species_requests: any authed user may submit; reads are team-only (no
-- authenticated SELECT grant — only service_role reads).
GRANT INSERT ON public.species_requests TO authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE public.companions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_companions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companion_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.species_requests ENABLE ROW LEVEL SECURITY;

-- companions: anyone authenticated/anon may read live + in-illustration rows.
DROP POLICY IF EXISTS companions_read_all ON public.companions;
CREATE POLICY companions_read_all
  ON public.companions
  FOR SELECT
  TO authenticated, anon
  USING (true);

-- user_companions: a user may only see/touch their own pets.
DROP POLICY IF EXISTS user_companions_owner_select ON public.user_companions;
CREATE POLICY user_companions_owner_select
  ON public.user_companions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS user_companions_owner_insert ON public.user_companions;
CREATE POLICY user_companions_owner_insert
  ON public.user_companions
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS user_companions_owner_update ON public.user_companions;
CREATE POLICY user_companions_owner_update
  ON public.user_companions
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- companion_events: a user may read events for pets they own. Inserts are
-- performed by the backend under the service-role key (no authenticated
-- INSERT policy by design).
DROP POLICY IF EXISTS companion_events_owner_select ON public.companion_events;
CREATE POLICY companion_events_owner_select
  ON public.companion_events
  FOR SELECT TO authenticated
  USING (
    user_companion_id IN (
      SELECT id FROM public.user_companions WHERE user_id = auth.uid()
    )
  );

-- species_requests: any authed user may submit a request tied to their own
-- user_id. No SELECT policy for authenticated — requests are team-only reads
-- (service_role bypasses RLS).
DROP POLICY IF EXISTS species_requests_owner_insert ON public.species_requests;
CREATE POLICY species_requests_owner_insert
  ON public.species_requests
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Seed: locked starter species + a handful more (8 total). Placeholder
-- asset_paths — Amanda's illustration work fills these in later. ON CONFLICT
-- DO NOTHING keeps this migration safe to re-run.
-- ---------------------------------------------------------------------------
INSERT INTO public.companions (slug, display_name, asset_paths, status) VALUES
  ('bluey-blue-whale',  'Bluey the Blue Whale', '{"1d":"placeholder/bluey-1d.svg","2d":"placeholder/bluey-2d.svg","3d":"placeholder/bluey-3d.glb"}'::jsonb, 'live'),
  ('brontle-dinosaur',  'Brontle',              '{"1d":"placeholder/brontle-1d.svg","2d":"placeholder/brontle-2d.svg","3d":"placeholder/brontle-3d.glb"}'::jsonb, 'live'),
  ('rolo-panda',        'Rolo the Panda',       '{"1d":"placeholder/rolo-1d.svg","2d":"placeholder/rolo-2d.svg","3d":"placeholder/rolo-3d.glb"}'::jsonb, 'live'),
  ('stick-insect',      'Stick Insect',         '{"1d":"placeholder/stick-1d.svg","2d":"placeholder/stick-2d.svg"}'::jsonb, 'live'),
  ('snail',             'Snail',                '{"1d":"placeholder/snail-1d.svg","2d":"placeholder/snail-2d.svg"}'::jsonb, 'live'),
  ('axolotl',           'Axolotl',              '{"1d":"placeholder/axolotl-1d.svg","2d":"placeholder/axolotl-2d.svg","3d":"placeholder/axolotl-3d.glb"}'::jsonb, 'live'),
  ('red-panda',         'Red Panda',            '{"1d":"placeholder/redpanda-1d.svg","2d":"placeholder/redpanda-2d.svg"}'::jsonb, 'live'),
  ('garden-frog',       'Garden Frog',          '{"1d":"placeholder/frog-1d.svg","2d":"placeholder/frog-2d.svg"}'::jsonb, 'live')
ON CONFLICT (slug) DO NOTHING;
