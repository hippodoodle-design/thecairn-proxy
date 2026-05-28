import { getServiceClient } from '@cairn/shared/supabase';
import { generateDailyActivities } from '@cairn/shared/companions';

/**
 * The Visit Log — zoo-daily-activities job (Magic 2).
 *
 * Once a day, generate ~8 gentle activity entries for the communal Visit Log,
 * weighted by who's in the Zoo and their personalities (including the panda
 * playgroup when ≥2 pandas are present). Records what the ANIMALS did; never
 * what the user did or didn't do.
 *
 * Idempotent per day: if today's log already has entries, the job no-ops. Runs
 * ~06:15 local so the day's log is ready when users wake.
 */
export async function zooDailyActivities(job, log) {
  const jobLog = (log ?? console).child?.({ job: 'zoo-daily-activities' }) ?? log ?? console;
  const supabase = await getServiceClient();

  const today = new Date().toISOString().slice(0, 10);

  // Guard: don't double-fill today's log.
  const { data: existing, error: exErr } = await supabase
    .from('zoo_daily_activities')
    .select('id')
    .eq('date', today)
    .limit(1);
  if (exErr) throw new Error(`zoo-daily-activities: guard query failed: ${exErr.message}`);
  if (existing && existing.length > 0) {
    jobLog.info?.({ msg: 'zoo-daily-activities: already generated today', generated: 0 });
    return { generated: 0, skipped: true };
  }

  // Who's in the Zoo today — active pets are out with users but still residents;
  // in_zoo pets are home. Both count toward Zoo life.
  const { data: residents, error: rErr } = await supabase
    .from('user_companions')
    .select('custom_name, is_user_uploaded, personality_traits, companion:companions (slug, display_name)')
    .in('status', ['active', 'in_zoo']);
  if (rErr) throw new Error(`zoo-daily-activities: could not load residents: ${rErr.message}`);

  const shaped = (residents ?? []).map((r) => ({
    name: r.custom_name ?? null,
    speciesSlug: r.companion?.slug ?? null,
    speciesDisplayName: r.companion?.display_name ?? null,
    isUserUploaded: r.is_user_uploaded,
    traits: Array.isArray(r.personality_traits?.traits) ? r.personality_traits.traits : [],
  }));

  const activities = generateDailyActivities(shaped, { count: 8 });
  const rows = activities.map((a) => ({ date: today, ...a }));

  const { error: insErr } = await supabase.from('zoo_daily_activities').insert(rows);
  if (insErr) throw new Error(`zoo-daily-activities: insert failed: ${insErr.message}`);

  jobLog.info?.({ msg: 'zoo-daily-activities: done', generated: rows.length });
  return { generated: rows.length, skipped: false };
}
