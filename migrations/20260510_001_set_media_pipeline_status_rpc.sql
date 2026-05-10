-- Phase 9c — Delta 2: media_pipeline.status RPC
--
-- Atomic write helper for stones.metadata.media_pipeline.status. Workers and
-- web routes call this rather than read-modify-writing the JSONB column from
-- Node — jsonb_set runs server-side so concurrent harvest + reunderstand
-- writers can't race with each other or with safety_status updates on the
-- same row.
--
-- Allowed values: 'pending' | 'harvesting' | 'complete' | 'failed'.
-- Validation lives inside the function (LANGUAGE plpgsql + RAISE) rather
-- than as a CHECK constraint, because a CHECK on a JSONB sub-path is
-- awkward to express and the function is the only legitimate writer of
-- this field. Bad input fails loudly with a hint listing the four values.
--
-- SECURITY DEFINER: callers run as the function owner so we don't have to
-- grant table-level UPDATE on stones to additional roles. EXECUTE is
-- granted to service_role only — both the worker and web service use the
-- service-role key (see shared/src/supabase.js).

CREATE OR REPLACE FUNCTION public.set_media_pipeline_status(
  p_stone_id uuid,
  p_status text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('pending', 'harvesting', 'complete', 'failed') THEN
    RAISE EXCEPTION 'set_media_pipeline_status: invalid status %', p_status
      USING HINT = 'allowed values: pending | harvesting | complete | failed';
  END IF;

  UPDATE public.stones
  SET metadata = jsonb_set(
    coalesce(metadata, '{}'::jsonb),
    '{media_pipeline,status}',
    to_jsonb(p_status)
  )
  WHERE id = p_stone_id;
END;
$$;

REVOKE ALL ON FUNCTION public.set_media_pipeline_status(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_media_pipeline_status(uuid, text) TO service_role;
