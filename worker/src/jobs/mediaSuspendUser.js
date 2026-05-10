import { getServiceClient } from '@cairn/shared/supabase';

/**
 * Pure-ish suspension core. Sets profiles.suspended_at + suspended_reason.
 * Idempotent — re-running with the same reason is a no-op against the
 * existing values; we don't overwrite an earlier suspension timestamp.
 *
 * @param {{ user_id: string, reason: string, incident_id?: string }} input
 * @param {{ supabase?: any, log?: any }} [options]
 */
export async function processMediaSuspendUser(input, options = {}) {
  const { user_id, reason, incident_id } = input || {};
  const log = options.log;
  const supabase = options.supabase ?? getServiceClient();

  if (!user_id) throw new Error('user_id missing from suspension payload');
  if (!reason) throw new Error('reason missing from suspension payload');

  log?.info?.({ msg: 'suspend-user:start', userIdTail: user_id.slice(-4), incident_id });

  // Only update suspended_at if not already set — preserve the earliest
  // timestamp so audit trails stay honest.
  const { data: profile, error: readErr } = await supabase
    .from('profiles')
    .select('id, suspended_at')
    .eq('id', user_id)
    .single();

  if (readErr) {
    throw new Error(`suspend-user: profile read failed: ${readErr.message}`);
  }

  const updateRow = { suspended_reason: reason };
  if (!profile?.suspended_at) updateRow.suspended_at = new Date().toISOString();

  const { error: updateErr } = await supabase
    .from('profiles')
    .update(updateRow)
    .eq('id', user_id);

  if (updateErr) {
    throw new Error(`suspend-user: profile update failed: ${updateErr.message}`);
  }

  log?.info?.({
    msg: 'suspend-user:done',
    userIdTail: user_id.slice(-4),
    incident_id,
    suspendedAtPreserved: !!profile?.suspended_at,
  });

  return { user_id, suspended_at: profile?.suspended_at ?? updateRow.suspended_at };
}

/**
 * BullMQ wrapper for 'media-suspend-user' jobs.
 */
export async function mediaSuspendUser(job, log) {
  const jobLog = log.child({ jobId: job.id });
  return processMediaSuspendUser(job.data, { log: jobLog });
}
