/**
 * Unit checks for Wave Cairn Companions: Zoo Life + Personality.
 * Run from C:\thecairn-proxy with:
 *   node scripts/test-companions-life.js
 *
 * These exercise the PURE generation logic (personality draw, mood draw, keeper
 * letters, the Visit Log) with a seeded RNG — no DB, no Redis, no env needed, so
 * they run green immediately. The DB-dependent worker jobs (which query the
 * companion tables) are inert until migration 007 is applied; their behaviour is
 * verified by the same generators tested here plus a future E2E once the schema
 * is live.
 *
 * Exits 0 if all assertions pass, 1 on first failure.
 */

import {
  drawPersonality,
  drawUploadedPersonality,
  drawMood,
  traitsOf,
  MOODS,
  TRAITS,
  generateLetter,
  petReference,
  generateDailyActivities,
} from '@cairn/shared/companions';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

let passed = 0;
function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`${GREEN}✓${RESET} ${name}`);
  } else {
    console.log(`${RED}✗${RESET} ${name}`);
    process.exitCode = 1;
    throw new Error(`assertion failed: ${name}`);
  }
}

/** Deterministic RNG (mulberry32) so draws are reproducible under test. */
function seeded(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

try {
  // --- drawPersonality -----------------------------------------------------
  const dist = { playful: 0.5, mischievous: 0.3, calm: 0.2 };
  const p = drawPersonality(dist, { rng: seeded(1) });
  check('drawPersonality returns {traits, primary}', Array.isArray(p.traits) && typeof p.primary === 'string');
  check('drawPersonality primary is traits[0]', p.primary === p.traits[0]);
  check('drawPersonality yields 1-2 traits', p.traits.length >= 1 && p.traits.length <= 2);
  check('drawPersonality only draws traits from the distribution',
    p.traits.every((t) => Object.keys(dist).includes(t)));
  check('drawPersonality traits are distinct', new Set(p.traits).size === p.traits.length);

  // Empty distribution falls back to the generic upload spread (never empty).
  const fallback = drawPersonality({}, { rng: seeded(2) });
  check('drawPersonality falls back when distribution empty', fallback.traits.length >= 1);
  check('drawPersonality fallback uses generic traits',
    fallback.traits.every((t) => ['playful', 'mischievous', 'shy'].includes(t)));

  // Distribution sampling correctness: a heavily-weighted trait dominates.
  let playfulPrimary = 0;
  const N = 2000;
  const rng = seeded(42);
  for (let i = 0; i < N; i++) {
    if (drawPersonality({ playful: 0.9, shy: 0.1 }, { rng }).primary === 'playful') playfulPrimary++;
  }
  check('drawPersonality respects weights (playful ~0.9 dominates)', playfulPrimary / N > 0.8);

  // Uploaded pets get the generic spread.
  const up = drawUploadedPersonality({ rng: seeded(3) });
  check('drawUploadedPersonality uses generic traits',
    up.traits.every((t) => ['playful', 'mischievous', 'shy'].includes(t)));

  // traitsOf normalises both stored shapes.
  check('traitsOf reads {traits:[...]}', JSON.stringify(traitsOf({ traits: ['calm'] })) === '["calm"]');
  check('traitsOf reads a bare array', JSON.stringify(traitsOf(['shy'])) === '["shy"]');
  check('traitsOf handles null', traitsOf(null).length === 0);

  // --- drawMood ------------------------------------------------------------
  const mood = drawMood({ rng: seeded(5), traits: ['chill'] });
  check('drawMood returns a known mood', MOODS.includes(mood));
  // Trait affinity tilts the odds: a chill+still pet trends sleepy/chill.
  let chillOrSleepy = 0;
  const mrng = seeded(7);
  for (let i = 0; i < N; i++) {
    const m = drawMood({ rng: mrng, traits: ['chill', 'still'] });
    if (m === 'chill' || m === 'sleepy') chillOrSleepy++;
  }
  // Uniform baseline would be 2/8 = 0.25; affinity should push it well above.
  check('drawMood affinity tilts toward affine moods', chillOrSleepy / N > 0.35);

  // --- generateLetter ------------------------------------------------------
  check('petReference prefers a custom name', petReference({ name: 'Bluey' }) === 'Bluey');
  check('petReference falls back to species', petReference({ speciesDisplayName: 'Rolo the Panda' }) === 'Rolo the Panda');
  check('petReference handles unnamed upload', petReference({ isUserUploaded: true }) === 'your wee drawing');

  const letter = generateLetter({ name: 'Brontle', traits: ['escape-attempting'] }, { rng: seeded(9) });
  check('generateLetter returns text + occasion', typeof letter.letter_text === 'string' && letter.letter_text.length > 0);
  check('generateLetter parametrises the name', letter.letter_text.includes('Brontle'));
  check('generateLetter leaves no {n} placeholder', !letter.letter_text.includes('{n}'));

  // Unnamed pet still gets a coherent, non-empty letter.
  const anon = generateLetter({ traits: [], isUserUploaded: false }, { rng: seeded(11) });
  check('generateLetter handles a trait-less, nameless pet', anon.letter_text.includes('your companion'));

  // A letter should never reference the user (no "you"/"your" guilt framing
  // beyond the benign "your companion" reference). Spot-check no "miss"/"hungry".
  let cleanLetters = true;
  const lrng = seeded(13);
  for (let i = 0; i < 200; i++) {
    const l = generateLetter({ name: 'Rolo', traits: ['playful', 'mischievous'], mood: 'mischievous' }, { rng: lrng });
    if (/hungry|misses you|needs you|you forgot|you should/i.test(l.letter_text)) cleanLetters = false;
  }
  check('generateLetter never guilts the user (no Tamagotchi framing)', cleanLetters);

  // --- generateDailyActivities --------------------------------------------
  const empty = generateDailyActivities([], { rng: seeded(15) });
  check('generateDailyActivities: empty zoo yields a quiet-day entry', empty.length === 1 && empty[0].activity_type === 'stillness');

  const residents = [
    { speciesSlug: 'rolo-panda', speciesDisplayName: 'Rolo the Panda', traits: ['playful'] },
    { speciesSlug: 'red-panda', speciesDisplayName: 'Red Panda', traits: ['sociable'] },
    { speciesSlug: 'axolotl', speciesDisplayName: 'Axolotl', traits: ['water-lover'] },
  ];
  const log = generateDailyActivities(residents, { count: 8, rng: seeded(17) });
  check('generateDailyActivities respects count', log.length === 8);
  check('generateDailyActivities fills descriptions', log.every((a) => a.description && !a.description.includes('{n}')));
  check('generateDailyActivities includes the panda playgroup (≥2 pandas)',
    log.some((a) => a.species_or_companion_ref === 'pandas'));

  // No pandas → no playgroup.
  const noPandas = generateDailyActivities([{ speciesSlug: 'snail', speciesDisplayName: 'Snail', traits: ['still'] }], { count: 4, rng: seeded(19) });
  check('generateDailyActivities: no playgroup without ≥2 pandas',
    !noPandas.some((a) => a.species_or_companion_ref === 'pandas'));

  // TRAITS vocabulary is non-empty and used by the affinity tables.
  check('TRAITS vocabulary present', TRAITS.length >= 8);

  console.log('');
  console.log(`${GREEN}✓ all ${passed} Zoo-life unit checks passed${RESET}`);
  process.exit(0);
} catch (err) {
  console.log('');
  console.log(`${RED}✗ Zoo-life unit checks failed after ${passed} passing: ${err.message}${RESET}`);
  process.exit(1);
}
