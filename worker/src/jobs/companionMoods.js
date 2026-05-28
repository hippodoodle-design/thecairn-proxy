import { getServiceClient, isMissingTable } from '@cairn/shared/supabase';
import { drawMood, traitsOf } from '@cairn/shared/companions';

/**
 * Mood of the Day — companion-moods job (Magic 3).
 *
 * For every ACTIVE companion, draw a quiet mood for today and record it as a
 * companion_events 'mood_set' row. The frontend reads the latest mood_set to
 * tweak the pet's micro-behaviour. Moods are the PET's own — never a judgement
 * of the user.
 *
 * Idempotent per day: companions that already have a mood_set today are skipped,
 * so a retry or a double-fire never doubles up. Runs at ~06:00 local (before the
 * Visit Log + letters) so those can reflect the day's moods.
 */
export async function companionMoods(job, log) {
  const jobLog = (log ?? console).child?.({ job: 'companion-moods' }) ?? log ?? console;
  const supabase = await getServiceClient();

  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const sinceIso = startOfToday.toISOString();

  const { data: active, error: aErr } = await supabase
    .from('user_companions')
    .select('id, personality_traits')
    .eq('status', 'active');
  if (isMissingTable(aErr)) {
    jobLog.info?.({ msg: 'companion-moods: schema not applied yet, skipping', set: 0 });
    return { set: 0, skipped: 0, reason: 'schema-not-applied' };
  }
  if (aErr) throw new Error(`companion-moods: could not load active companions: ${aErr.message}`);

  if (!active || active.length === 0) {
    jobLog.info?.({ msg: 'companion-moods: no active companions', set: 0 });
    return { set: 0, skipped: 0 };
  }

  // One query for everyone already mooded today — avoids N round-trips.
  const { data: existing, error: eErr } = await supabase
    .from('companion_events')
    .select('user_companion_id')
    .eq('event', 'mood_set')
    .gte('occurred_at', sinceIso);
  if (eErr) throw new Error(`companion-moods: could not load today's moods: ${eErr.message}`);
  const alreadyMooded = new Set((existing ?? []).map((r) => r.user_companion_id));

  const today = sinceIso.slice(0, 10);
  const rows = [];
  for (const c of active) {
    if (alreadyMooded.has(c.id)) continue;
    const mood = drawMood({ traits: traitsOf(c.personality_traits) });
    rows.push({ user_companion_id: c.id, event: 'mood_set', payload: { date: today, mood } });
  }

  if (rows.length > 0) {
    const { error: insErr } = await supabase.from('companion_events').insert(rows);
    if (insErr) throw new Error(`companion-moods: insert failed: ${insErr.message}`);
  }

  jobLog.info?.({ msg: 'companion-moods: done', set: rows.length, skipped: alreadyMooded.size });
  return { set: rows.length, skipped: alreadyMooded.size };
}
