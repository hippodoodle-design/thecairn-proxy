-- Migration 007 — companions_zoo_life_personality
-- Wave Cairn Companions: Zoo Life + Personality (29 May 2026), project The Cairn
-- (mzjvcntzcfagasxcnuye). EXTENDS migration 006 (companions_zoo_schema) — 006
-- must be applied first.
--
-- The central new insight: "You don't choose your pet's personality — you meet
-- it." The user picks the species; the personality is discovered, drawn once at
-- pick time from the species' distribution and then fixed (the pet is who it
-- is). Plus the Zoo becomes a living place — Zookeeper Letters land gently every
-- few days, a daily Visit Log shows what the animals got up to, and each pet has
-- a quiet Mood of the Day. NONE of this is Tamagotchi: letters + activities are
-- always about what the PET did, never about what the user failed to do.
--
-- Canonical principle doc: Notion page 35bdfeff-1b02-8116-ba1a-dceca4e74def.
-- Implementation reference: docs/companion-principle.md in this repo.
--
-- APPLY NOTE (29 May 2026): per CLAUDE.md (HippoSwitch Layer 1), the Supabase
-- MCP is NOT used for this project. Apply via the Supabase CLI with --db-url
-- against project mzjvcntzcfagasxcnuye, or via the Supabase SQL editor. The
-- web/worker service-role key (PostgREST) cannot run DDL. This migration and
--006 share the same apply gate (CAIRN_SUPABASE_DB_URL); apply 006 then 007.

SET search_path = public, pg_temp;

-- ---------------------------------------------------------------------------
-- 1. Personality, at two layers.
--    companions.personality_distribution — the species-level shape of who this
--      animal tends to be (e.g. panda {playful:0.5, calm:0.3, sociable:0.2}).
--    user_companions.personality_traits — the specific traits THIS user's THIS
--      pet was born with, drawn once at pick time. Fixed thereafter.
-- ---------------------------------------------------------------------------
ALTER TABLE public.companions
  ADD COLUMN IF NOT EXISTS personality_distribution jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.user_companions
  ADD COLUMN IF NOT EXISTS personality_traits jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.companions.personality_distribution IS
  'Species-level distribution of possible personalities; weights sum ~1. Drawn from at pick time.';
COMMENT ON COLUMN public.user_companions.personality_traits IS
  'This pet''s specific traits, drawn once at pick time from the species distribution. Does not change — the pet is who it is.';

-- ---------------------------------------------------------------------------
-- 2. companion_events gains three new event types: mood_set (daily mood draw),
--    hello_sniff (two companions greet — stubbed until cross-Cairn visiting),
--    ambient_activity (a moment of Zoo life recorded against a pet). Rebuild the
--    CHECK to include them. Idempotent: drop-if-exists then add.
-- ---------------------------------------------------------------------------
ALTER TABLE public.companion_events
  DROP CONSTRAINT IF EXISTS companion_events_event_check;
ALTER TABLE public.companion_events
  ADD CONSTRAINT companion_events_event_check CHECK (event IN (
    'picked','named','accessory_changed','dimension_changed',
    'returned_to_zoo','left_zoo','retired','uploaded_1d',
    'mood_set','hello_sniff','ambient_activity'));

-- ---------------------------------------------------------------------------
-- 3. zoo_keeper_letters — a tiny, gentle note from the zoo-keepers about a
--    pet, every few days. ALWAYS about the pet / Zoo life, NEVER about the
--    user. Owner-readable; written by the backend (service_role).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.zoo_keeper_letters (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_companion_id  uuid NOT NULL REFERENCES public.user_companions(id) ON DELETE CASCADE,
  letter_text        text NOT NULL,
  occasion           text,
  generated_at       timestamptz NOT NULL DEFAULT now(),
  read_at            timestamptz
);

COMMENT ON TABLE public.zoo_keeper_letters IS
  'Gentle zoo-keeper notes about a pet (never about the user). ~10% of active pets per day, max 1/pet/day.';

-- ---------------------------------------------------------------------------
-- 4. zoo_daily_activities — the communal Visit Log. What happened in the Zoo
--    today, weighted by who's in it + their personalities. Readable by any
--    authed user (the Zoo's shared life), written by the backend.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.zoo_daily_activities (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date                     date NOT NULL DEFAULT current_date,
  activity_type            text NOT NULL,
  species_or_companion_ref text,
  description              text NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.zoo_daily_activities IS
  'Communal daily Visit Log of Zoo life. Public-to-authed read; the Zoo''s shared, gentle present.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS zoo_keeper_letters_uc_read_idx
  ON public.zoo_keeper_letters (user_companion_id, read_at);
CREATE INDEX IF NOT EXISTS zoo_daily_activities_date_idx
  ON public.zoo_daily_activities (date DESC);

-- ---------------------------------------------------------------------------
-- Grants. Backend (web + worker) uses service_role and bypasses RLS.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.zoo_keeper_letters, public.zoo_daily_activities
  TO service_role;

-- zoo_keeper_letters: owner reads + updates (mark-as-read) own pet's letters.
GRANT SELECT, UPDATE ON public.zoo_keeper_letters TO authenticated;
-- zoo_daily_activities: any authed user reads the communal log.
GRANT SELECT ON public.zoo_daily_activities TO authenticated, anon;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE public.zoo_keeper_letters  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zoo_daily_activities ENABLE ROW LEVEL SECURITY;

-- zoo_keeper_letters: a user sees/updates letters only for pets they own.
DROP POLICY IF EXISTS zoo_keeper_letters_owner_select ON public.zoo_keeper_letters;
CREATE POLICY zoo_keeper_letters_owner_select
  ON public.zoo_keeper_letters
  FOR SELECT TO authenticated
  USING (
    user_companion_id IN (
      SELECT id FROM public.user_companions WHERE user_id = auth.uid()
    )
  );

-- mark-as-read: owner may update their own pets' letters (read_at).
DROP POLICY IF EXISTS zoo_keeper_letters_owner_update ON public.zoo_keeper_letters;
CREATE POLICY zoo_keeper_letters_owner_update
  ON public.zoo_keeper_letters
  FOR UPDATE TO authenticated
  USING (
    user_companion_id IN (
      SELECT id FROM public.user_companions WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    user_companion_id IN (
      SELECT id FROM public.user_companions WHERE user_id = auth.uid()
    )
  );

-- zoo_daily_activities: the Zoo's communal life — readable by anyone authed.
DROP POLICY IF EXISTS zoo_daily_activities_read_all ON public.zoo_daily_activities;
CREATE POLICY zoo_daily_activities_read_all
  ON public.zoo_daily_activities
  FOR SELECT TO authenticated, anon
  USING (true);

-- ---------------------------------------------------------------------------
-- Seed: backfill personality_distribution on the 8 starter species. Weights are
-- a sensible starting shape per the dispatch; ON CONFLICT-free (UPDATE by slug),
-- safe to re-run. Distributions are advisory — the draw normalises whatever is
-- present, so they need not sum to exactly 1.
-- ---------------------------------------------------------------------------
UPDATE public.companions SET personality_distribution = '{"chill":0.6,"introspective":0.4}'::jsonb            WHERE slug = 'bluey-blue-whale';
UPDATE public.companions SET personality_distribution = '{"playful":0.5,"mischievous":0.3,"escape-attempting":0.2}'::jsonb WHERE slug = 'brontle-dinosaur';
UPDATE public.companions SET personality_distribution = '{"playful":0.5,"calm":0.3,"sociable":0.2}'::jsonb     WHERE slug = 'rolo-panda';
UPDATE public.companions SET personality_distribution = '{"still":0.7,"shy":0.3}'::jsonb                       WHERE slug = 'stick-insect';
UPDATE public.companions SET personality_distribution = '{"still":0.6,"introspective":0.4}'::jsonb             WHERE slug = 'snail';
UPDATE public.companions SET personality_distribution = '{"still":0.5,"water-lover":0.5}'::jsonb               WHERE slug = 'axolotl';
UPDATE public.companions SET personality_distribution = '{"playful":0.4,"sociable":0.4,"cuddle-lover":0.2}'::jsonb WHERE slug = 'red-panda';
UPDATE public.companions SET personality_distribution = '{"water-lover":0.5,"calm":0.3,"shy":0.2}'::jsonb      WHERE slug = 'garden-frog';
