/**
 * Zookeeper Letters — a tiny, gentle note from the zoo-keepers about a pet,
 * landing every few days. Pure template logic, no I/O.
 *
 * Doctrine (locked): a letter is ALWAYS about what the PET did or how Zoo life
 * went — NEVER about the user, never guilt, never "your pet misses you". The
 * Cairn voice: warm, quiet, a little charmed by the animal.
 *
 * This is a starter template library: several lines per trait plus a general
 * pool and a few mood flavourings, all parametrised with the pet's reference.
 * LLM-enriched generation (more variety, seasonal lines) is a named follow-up
 * wave; the library is deliberately easy to extend — add strings to the arrays.
 */

/**
 * How a letter refers to a pet. Names live on the accessory layer, so a pet may
 * have no custom name — in that case we lean on the species name, or a warm
 * generic for an unnamed uploaded drawing. Never expose internal ids.
 */
export function petReference(companion = {}) {
  return (
    companion.name?.trim() ||
    companion.speciesDisplayName?.trim() ||
    (companion.isUserUploaded ? 'your wee drawing' : 'your companion')
  );
}

/** Templates keyed by trait. {n} is replaced with the pet reference. */
const TRAIT_LINES = {
  calm: [
    '{n} spent the afternoon watching the others and looking quietly pleased about it.',
    '{n} found the warmest spot by mid-morning and stayed exactly there.',
    'A very settled day for {n}. Nothing to report, in the nicest way.',
    '{n} let a keeper sit nearby for a long while. Companionable silence.',
  ],
  chill: [
    '{n} did a slow lap of the enclosure and then thought better of doing a second.',
    '{n} was unbothered by absolutely everything today. A gift, really.',
    'The keepers say {n} has perfected the art of the long, easy stretch.',
    '{n} drifted between sun and shade all day, in no hurry about any of it.',
  ],
  playful: [
    '{n} invented a game involving a leaf. The rules were unclear but the joy was total.',
    '{n} got the zoomies just before lunch and again just after. Twice the fun.',
    'A keeper threw a soft ball and {n} has not stopped talking about it (in their way).',
    '{n} bounced from one end of the pen to the other for no reason anyone could name.',
  ],
  mischievous: [
    '{n} hid behind the feed bucket and "surprised" a keeper who absolutely saw it coming.',
    '{n} moved a small object six inches to the left and looked terribly proud.',
    'The keepers found {n} somewhere {n} was not supposed to be. Polite about it, as ever.',
    '{n} tried a new trick today. We are pretending not to have noticed the trick.',
  ],
  shy: [
    '{n} watched the day from a comfortable distance and that was just right.',
    '{n} came out to say a quiet hello to one keeper, then returned to the quiet corner.',
    'A gentle day for {n} — near the edge of things, taking it all in.',
    '{n} let us know they were happy by being completely, peacefully unbothered.',
  ],
  'water-lover': [
    '{n} did three slow laps of the pool and then napped like it had been hard work.',
    '{n} would not leave the water today and honestly, fair enough.',
    'The keepers topped up the pool and {n} supervised the entire operation.',
    '{n} found the one puddle in the whole enclosure and claimed it.',
  ],
  'cuddle-lover': [
    '{n} leaned right into a keeper at brushing time and stayed for the whole thing.',
    '{n} sought out a friend and the two of them sat together a good while.',
    'A keeper reports {n} is "extremely huggable" and we are inclined to agree.',
    '{n} nudged in for company three separate times today. Each one welcome.',
  ],
  'escape-attempting': [
    '{n} tried to leave twice today. Very polite about it both times.',
    '{n} found a gap, considered it at length, and decided the Zoo was nicer.',
    'The keepers gently redirected {n} from an "expedition". No hard feelings.',
    '{n} made it almost to the gate before remembering lunch was the other way.',
  ],
  introspective: [
    '{n} stared thoughtfully at a single point for some time. We left them to it.',
    '{n} seemed deep in thought today. Whatever it was about, it looked important.',
    'A quiet, considering sort of day for {n}.',
    '{n} watched the light move across the enclosure and appeared to approve.',
  ],
  still: [
    '{n} was very still all day. As is their way.',
    '{n} held a single elegant pose for so long a keeper checked twice.',
    'Nothing moved {n} today and {n} liked it that way.',
    '{n} practised the ancient art of being perfectly, beautifully still.',
  ],
  sociable: [
    '{n} made the rounds and said hello to nearly everyone in the Zoo.',
    '{n} spent the day in good company and looked all the better for it.',
    'Wherever the others gathered, {n} was somewhere in the middle of it.',
    '{n} organised what can only be described as a small social occasion.',
  ],
};

/** General lines that suit any pet — keeps unnamed-trait pets covered too. */
const GENERAL_LINES = [
  '{n} had a good day. The keepers wanted you to know.',
  '{n} got a brush today and tolerated it with great dignity.',
  '{n} was fed, content, and entirely at ease. All is well in the Zoo.',
  'The keepers checked in on {n} and report nothing but contentment.',
  '{n} watched the other animals for a while and seemed glad of the company.',
  '{n} found a patch of sun and made the most of it.',
];

/** A small extra flavouring when we know today's mood. */
const MOOD_LINES = {
  sleepy: '{n} was sleepy from the off and saw no reason to fight it.',
  playful: '{n} could not sit still for the joy of it today.',
  curious: '{n} investigated every new thing in the enclosure, twice.',
  chill: '{n} took the whole day at the gentlest possible pace.',
  mischievous: '{n} had a glint in the eye all day. We are keeping an eye back.',
  sociable: '{n} wanted company today and went looking for it.',
  introspective: '{n} spent the day somewhere thoughtful and far away.',
  dappy: '{n} did three slightly silly things before lunch and we loved each one.',
};

function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Generate one zoo-keeper letter for a pet.
 *
 * @param {{ name?: string|null, speciesDisplayName?: string|null,
 *           isUserUploaded?: boolean, traits?: string[], mood?: string }} companion
 * @param {{ rng?: () => number }} [opts]
 * @returns {{ letter_text: string, occasion: string }}
 *
 * Picks from the pools that match the pet's traits (falling back to the general
 * pool), parametrises with the pet reference, and occasionally folds in a
 * mood-flavoured line. Never references the user.
 */
export function generateLetter(companion = {}, { rng = Math.random } = {}) {
  const ref = petReference(companion);
  const traits = Array.isArray(companion.traits) ? companion.traits : [];

  const pools = [];
  for (const t of traits) if (TRAIT_LINES[t]) pools.push(...TRAIT_LINES[t]);
  if (pools.length === 0) pools.push(...GENERAL_LINES);
  // Always give the general pool some weight so even trait-heavy pets vary.
  pools.push(...GENERAL_LINES);

  // ~25% of the time, when we know the mood, use the mood-flavoured line instead.
  let template;
  let occasion;
  if (companion.mood && MOOD_LINES[companion.mood] && rng() < 0.25) {
    template = MOOD_LINES[companion.mood];
    occasion = `mood:${companion.mood}`;
  } else {
    template = pick(pools, rng);
    occasion = traits[0] ? `trait:${traits[0]}` : 'everyday';
  }

  return { letter_text: template.replaceAll('{n}', ref), occasion };
}
