/**
 * Phase 9c — Delta 2: setStoneStatus helper.
 *
 * Atomic write of stones.metadata.media_pipeline.status via the
 * set_media_pipeline_status Postgres RPC (see
 * migrations/20260510_001_set_media_pipeline_status_rpc.sql). Workers
 * and routes call through here rather than building an UPDATE on
 * metadata themselves — the RPC uses jsonb_set so a concurrent
 * harvest + reunderstand can't race with each other or with a
 * safety_status update on the same row.
 *
 * The four-state contract is enforced server-side inside the RPC; we
 * also validate locally so a typo throws before the round-trip.
 *
 * Status values:
 *   'pending'    — follow-on job enqueued, worker hasn't picked it up
 *   'harvesting' — follow-on job (harvest OR reunderstand) actively running
 *   'complete'   — last meaningful pipeline step finished cleanly
 *   'failed'     — last meaningful pipeline step failed terminally
 *
 * Note the deliberate name re-use: 'harvesting' is also the state set
 * during reunderstand (Delta 2 decision §1). The frontend treats both
 * as "worker busy on this stone".
 *
 * Note also the naming-collision risk against media_pipeline.understanding_status
 * which already uses 'complete' for an unrelated concept (understanding
 * quality, complete vs weak). Callers reading either field should
 * scope their reads to the right key.
 */

export const ALLOWED_STATUSES = Object.freeze([
  'pending',
  'harvesting',
  'complete',
  'failed',
]);

/**
 * Atomically set stones[stoneId].metadata.media_pipeline.status.
 *
 * Throws on invalid input or RPC error. Callers should let the throw
 * propagate so a failed status write becomes loud rather than a quiet
 * row left in the wrong state.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} stoneId
 * @param {'pending'|'harvesting'|'complete'|'failed'} status
 * @returns {Promise<void>}
 */
export async function setStoneStatus(supabase, stoneId, status) {
  if (!stoneId) {
    throw new Error('setStoneStatus: stoneId is required');
  }
  if (!ALLOWED_STATUSES.includes(status)) {
    throw new Error(
      `setStoneStatus: invalid status "${status}" (allowed: ${ALLOWED_STATUSES.join(' | ')})`,
    );
  }

  const { error } = await supabase.rpc('set_media_pipeline_status', {
    p_stone_id: stoneId,
    p_status: status,
  });

  if (error) {
    throw new Error(`setStoneStatus(${stoneId}, ${status}) RPC failed: ${error.message}`);
  }
}
