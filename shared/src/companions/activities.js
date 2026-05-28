/**
 * The Visit Log — what happened in the Zoo today, weighted by who's in it and
 * their personalities. Pure logic, no I/O.
 *
 * Doctrine (locked): the log records what the ANIMALS did, never what the user
 * failed to do. It's the Zoo's gentle, communal present tense. Activity types:
 * pool-lap, roll-around, brush, feed, cuddle, escape-attempt, nap, play,
 * stillness, plus the panda playgroup when ≥2 pandas share the Zoo.
 */

/** Which activities each trait makes a little more likely. */
const TRAIT_ACTIVITY_WEIGHTS = {
  'water-lover': { 'pool-lap': 3 },
  playful: { play: 3, 'roll-around': 2 },
  mischievous: { 'escape-attempt': 2, 'roll-around': 2 },
  sociable: { cuddle: 2, 'roll-around': 1 },
  'cuddle-lover': { cuddle: 3, brush: 2 },
  'escape-attempting': { 'escape-attempt': 3 },
  calm: { nap: 2 },
  chill: { nap: 3 },
  introspective: { stillness: 3, nap: 1 },
  still: { stillness: 3 },
  shy: { stillness: 2 },
};

/** Every resident can do these regardless of personality. */
const BASE_WEIGHTS = { feed: 1, brush: 1, nap: 1 };

/** Description templates per activity. {n} = pet reference. */
const ACTIVITY_TEMPLATES = {
  'pool-lap': ['{n} did three laps of the pool', '{n} floated in the pool for most of the afternoon'],
  'roll-around': ['{n} had a good roll-around', '{n} rolled off something soft and was unbothered'],
  brush: ['{n} got a brush (loved it)', '{n} got a brush (did not love it)'],
  feed: ['{n} had a hearty lunch', '{n} was first in line at feeding time'],
  cuddle: ['{n} had a cuddle with a keeper', '{n} sought out a friend for company'],
  'escape-attempt': ['{n} attempted a polite escape', '{n} eyed the gate, then chose lunch'],
  nap: ['{n} napped in the sun', '{n} found the comfiest spot and stayed there'],
  play: ['{n} played all morning', '{n} could not sit still for the joy of it'],
  stillness: ['{n} was ✨ very still ✨ all day', '{n} held one elegant pose for hours'],
};

function residentRef(r = {}) {
  return r.name?.trim() || r.speciesDisplayName?.trim() || 'one of the animals';
}

function isPanda(r = {}) {
  return /panda/i.test(r.speciesSlug || '') || /panda/i.test(r.speciesDisplayName || '');
}

function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

function weightedPick(entries, rng) {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let r = rng() * total;
  for (const [key, w] of entries) {
    r -= w;
    if (r < 0) return key;
  }
  return entries[entries.length - 1][0];
}

/**
 * Generate today's Visit Log.
 *
 * @param {Array<{ speciesSlug?: string, speciesDisplayName?: string, name?: string,
 *                 isUserUploaded?: boolean, traits?: string[] }>} residents - who's in the Zoo
 * @param {{ count?: number, rng?: () => number }} [opts]
 * @returns {Array<{ activity_type: string, species_or_companion_ref: string|null, description: string }>}
 *
 * Builds a per-resident weighted activity choice, samples `count` of them, and
 * adds a panda-playgroup entry when ≥2 pandas are present. An empty Zoo yields a
 * single gentle "quiet day" entry rather than nothing.
 */
export function generateDailyActivities(residents = [], { count = 6, rng = Math.random } = {}) {
  const out = [];

  if (!residents || residents.length === 0) {
    return [{
      activity_type: 'stillness',
      species_or_companion_ref: null,
      description: 'A quiet day in the Zoo. The animals rested, fed, and were content.',
    }];
  }

  // The panda playgroup: a social set-piece when ≥2 pandas share the Zoo.
  const pandas = residents.filter(isPanda);
  if (pandas.length >= 2) {
    out.push({
      activity_type: 'play',
      species_or_companion_ref: 'pandas',
      description: 'The pandas had a roll-around together in the play zone',
    });
  }

  const remaining = Math.max(0, count - out.length);
  for (let i = 0; i < remaining; i++) {
    const r = pick(residents, rng);
    const traits = Array.isArray(r.traits) ? r.traits : [];

    // Per-resident activity weights: base + trait boosts.
    const weights = { ...BASE_WEIGHTS };
    for (const t of traits) {
      for (const [activity, w] of Object.entries(TRAIT_ACTIVITY_WEIGHTS[t] || {})) {
        weights[activity] = (weights[activity] ?? 0) + w;
      }
    }

    const activity = weightedPick(Object.entries(weights), rng);
    const description = pick(ACTIVITY_TEMPLATES[activity], rng).replaceAll('{n}', residentRef(r));
    out.push({ activity_type: activity, species_or_companion_ref: residentRef(r), description });
  }

  return out;
}
