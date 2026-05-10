-- Phase 6+ media pipeline inserts kind='video' for video stones.
-- The original stones_kind_check constraint pre-dated video
-- support. This migration adds 'video' to the allowed set.
-- Already applied to production via Supabase MCP on 10 May 2026.

ALTER TABLE public.stones DROP CONSTRAINT stones_kind_check;

ALTER TABLE public.stones ADD CONSTRAINT stones_kind_check
  CHECK (kind = ANY (ARRAY[
    'url'::text,
    'note'::text,
    'photo'::text,
    'voice'::text,
    'document'::text,
    'fragment'::text,
    'generated'::text,
    'video'::text
  ]));
