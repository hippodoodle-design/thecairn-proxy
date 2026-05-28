/**
 * Companion personality + mood — pure logic, no I/O.
 *
 * The locked insight (Wave Cairn Companions: Zoo Life + Personality): "You don't
 * choose your pet's personality — you meet it." The user picks a species; the
 * personality is drawn ONCE at pick time from the species' distribution and then
 * fixed. The pet is who it is. Mood, by contrast, is a gentle daily thing.
 *
 * Everything here takes an injectable `rng` (defaulting to Math.random) so the
 * draws are deterministic under test.
 */

/**
 * The canonical trait vocabulary. Species distributions draw from this; the
 * frontend follow-behavior state machine keys off the same names. Keep these in
 * sync with docs/companion-principle.md and the follow-behavior table.
 */
export const TRAITS = [
  'calm',
  'mischievous',
  'playful',
  'shy',
  'water-lover',
  'cuddle-lover',
  'escape-attempting',
  'chill',
  'introspective',
  'still',
  'sociable',
];

/** Daily moods. Drawn fresh each day; never a judgement of the user. */
export const MOODS = [
  'sleepy',
  'playful',
  'curious',
  'chill',
  'mischievous',
  'sociable',
  'introspective',
  'dappy',
];

/**
 * Uploaded 1D pets have no species default to weight from, so they get a
 * charming generic spread. The drawing has its own character; this just gives
 * the behavior layer something to key off.
 */
export const GENERIC_UPLOAD_DISTRIBUTION = Object.freeze({
  playful: 1,
  mischievous: 1,
  shy: 1,
});

/** ~40% of pets carry a second, distinct trait alongside their primary one. */
const SECOND_TRAIT_CHANCE = 0.4;

/** Traits that nudge certain daily moods to be a little more likely. */
const TRAIT_MOOD_AFFINITY = {
  calm: ['chill', 'introspective'],
  chill: ['chill', 'sleepy'],
  mischievous: ['mischievous', 'playful'],
  playful: ['playful', 'curious'],
  shy: ['introspective', 'sleepy'],
  'water-lover': ['playful', 'curious'],
  'cuddle-lover': ['sociable', 'chill'],
  'escape-attempting': ['mischievous', 'curious'],
  introspective: ['introspective', 'chill'],
  still: ['sleepy', 'introspective'],
  sociable: ['sociable', 'playful'],
};

/**
 * Weighted pick from [[key, weight], ...]. Weights must be positive; the list
 * non-empty. Uses one rng() draw.
 */
function weightedPick(entries, rng) {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let r = rng() * total;
  for (const [key, w] of entries) {
    r -= w;
    if (r < 0) return key;
  }
  return entries[entries.length - 1][0];
}

function positiveEntries(distribution) {
  return Object.entries(distribution || {}).filter(
    ([, w]) => typeof w === 'number' && w > 0,
  );
}

/**
 * Draw a pet's personality from a species distribution.
 *
 * @param {Record<string, number>} distribution - species personality_distribution
 * @param {{ rng?: () => number }} [opts]
 * @returns {{ traits: string[], primary: string }} 1-2 traits, primary first.
 *
 * An empty / missing distribution falls back to the generic upload spread, so a
 * registry species that hasn't been given a distribution yet still gets a
 * sensible personality rather than nothing.
 */
export function drawPersonality(distribution, { rng = Math.random } = {}) {
  let entries = positiveEntries(distribution);
  if (entries.length === 0) entries = positiveEntries(GENERIC_UPLOAD_DISTRIBUTION);

  const primary = weightedPick(entries, rng);
  const traits = [primary];

  const rest = entries.filter(([t]) => t !== primary);
  if (rest.length > 0 && rng() < SECOND_TRAIT_CHANCE) {
    traits.push(weightedPick(rest, rng));
  }

  return { traits, primary };
}

/** Personality for a user-uploaded 1D pet (no species to draw from). */
export function drawUploadedPersonality({ rng = Math.random } = {}) {
  return drawPersonality(GENERIC_UPLOAD_DISTRIBUTION, { rng });
}

/**
 * Draw today's mood. Base spread is uniform over MOODS; a pet's traits gently
 * tilt the odds toward affine moods (a chill whale is more often sleepy/chill,
 * never guaranteed). Mood is the pet's own — never about the user.
 *
 * @param {{ rng?: () => number, traits?: string[] }} [opts]
 * @returns {string} a mood from MOODS
 */
export function drawMood({ rng = Math.random, traits = [] } = {}) {
  const weights = new Map(MOODS.map((m) => [m, 1]));
  for (const t of traits || []) {
    for (const m of TRAIT_MOOD_AFFINITY[t] || []) {
      weights.set(m, (weights.get(m) ?? 1) + 1.5);
    }
  }
  return weightedPick([...weights.entries()], rng);
}

/** Normalise a stored personality_traits jsonb into a plain trait array. */
export function traitsOf(personality) {
  if (!personality) return [];
  if (Array.isArray(personality)) return personality;
  if (Array.isArray(personality.traits)) return personality.traits;
  return [];
}
