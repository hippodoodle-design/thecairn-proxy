import { getServiceClient, isMissingTable } from '@cairn/shared/supabase';
import { generateLetter, traitsOf } from '@cairn/shared/companions';

/** Daily chance that any one active/in-zoo pet gets a letter. Never spammy. */
const LETTER_CHANCE = 0.1;

/**
 * Zookeeper Letters — zookeeper-letters job (Magic 1).
 *
 * Each day, ~10% of active/in-zoo pets get a tiny, warm note from the keepers
 * about their pet's day. Always about the PET or Zoo life — never about the
 * user, never guilt. Max one letter per pet per day.
 *
 * Idempotent per day: pets that already have a letter today are excluded before
 * the chance roll, so a retry can't double-letter. Runs at a gentle ~08:00.
 */
export async function zookeeperLetters(job, log) {
  const jobLog = (log ?? console).child?.({ job: 'zookeeper-letters' }) ?? log ?? console;
  const supabase = await getServiceClient();

  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const sinceIso = startOfToday.toISOString();

  const { data: candidates, error: cErr } = await supabase
    .from('user_companions')
    .select('id, custom_name, is_user_uploaded, personality_traits, companion:companions (display_name)')
    .in('status', ['active', 'in_zoo']);
  if (isMissingTable(cErr)) {
    jobLog.info?.({ msg: 'zookeeper-letters: schema not applied yet, skipping', generated: 0 });
    return { generated: 0, considered: 0, reason: 'schema-not-applied' };
  }
  if (cErr) throw new Error(`zookeeper-letters: could not load candidates: ${cErr.message}`);

  if (!candidates || candidates.length === 0) {
    jobLog.info?.({ msg: 'zookeeper-letters: no candidates', generated: 0 });
    return { generated: 0, considered: 0 };
  }

  // Already lettered today → exclude (one query).
  const { data: sentToday, error: sErr } = await supabase
    .from('zoo_keeper_letters')
    .select('user_companion_id')
    .gte('generated_at', sinceIso);
  if (sErr) throw new Error(`zookeeper-letters: could not load today's letters: ${sErr.message}`);
  const lettered = new Set((sentToday ?? []).map((r) => r.user_companion_id));

  // Today's moods → optional flavour (one query).
  const { data: moodEvents, error: mErr } = await supabase
    .from('companion_events')
    .select('user_companion_id, payload')
    .eq('event', 'mood_set')
    .gte('occurred_at', sinceIso);
  if (mErr) throw new Error(`zookeeper-letters: could not load moods: ${mErr.message}`);
  const moodByCompanion = new Map((moodEvents ?? []).map((e) => [e.user_companion_id, e.payload?.mood]));

  const rows = [];
  let considered = 0;
  for (const c of candidates) {
    if (lettered.has(c.id)) continue;
    considered++;
    if (Math.random() >= LETTER_CHANCE) continue;

    const { letter_text, occasion } = generateLetter({
      name: c.custom_name,
      speciesDisplayName: c.companion?.display_name ?? null,
      isUserUploaded: c.is_user_uploaded,
      traits: traitsOf(c.personality_traits),
      mood: moodByCompanion.get(c.id),
    });
    rows.push({ user_companion_id: c.id, letter_text, occasion });
  }

  if (rows.length > 0) {
    const { error: insErr } = await supabase.from('zoo_keeper_letters').insert(rows);
    if (insErr) throw new Error(`zookeeper-letters: insert failed: ${insErr.message}`);
  }

  jobLog.info?.({ msg: 'zookeeper-letters: done', generated: rows.length, considered });
  return { generated: rows.length, considered };
}
