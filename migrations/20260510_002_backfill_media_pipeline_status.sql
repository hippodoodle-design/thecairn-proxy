-- Phase 9c — Delta 2: backfill media_pipeline.status
--
-- One-shot migration. Existing video stones have no
-- metadata.media_pipeline.status field. The frontend's four-state map
-- (pending | harvesting | complete | failed) lists no 'undefined' branch,
-- so we populate every legacy row up-front rather than asking the
-- frontend to tolerate the missing key.
--
-- Mapping:
--   safety_status = 'blocked'  →  status = 'failed'
--   anything else              →  status = 'complete'
--
-- 'blocked' covers CSAM and the rare "we couldn't proceed" case; in
-- both, the user-facing pipeline did not finish usefully — 'failed'
-- matches what the frontend would show. Everything else (kind='video'
-- with a media_pipeline object) is by definition a finished ingest.
--
-- Re-running this migration is a no-op because the WHERE clause skips
-- rows that already carry a status key.

UPDATE public.stones
SET metadata = jsonb_set(
  metadata,
  '{media_pipeline,status}',
  CASE
    WHEN safety_status = 'blocked' THEN '"failed"'::jsonb
    ELSE '"complete"'::jsonb
  END
)
WHERE kind = 'video'
  AND metadata ? 'media_pipeline'
  AND NOT (metadata->'media_pipeline' ? 'status');
