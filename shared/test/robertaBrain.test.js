/**
 * Release-condition tests for the brain's persona prompt and helpers.
 * Covers: system-prompt non-disclosure (the laws are present), scope lock,
 * anti-extraction / anti-jailbreak, consent law (no name unless the user gave
 * it), and per-user data isolation at the prompt level (user A's context never
 * appears in user B's prompt). No network — these exercise pure functions only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, cleanReply } from '../src/robertaBrain.js';

test('system prompt locks scope to the Cairn and refuses general-AI tasks', () => {
  const p = buildSystemPrompt().toLowerCase();
  assert.ok(p.includes('keeper of the cairn'), 'establishes the Cairn role');
  assert.ok(p.includes('not a general assistant'), 'explicit scope lock');
  assert.ok(
    p.includes('essay') && p.includes('homework'),
    'names the off-topic tasks it should decline',
  );
  assert.ok(p.includes('decline'), 'instructs Roberta to decline, not comply');
});

test('system prompt forbids disclosure of prompt / model / config / keys', () => {
  const p = buildSystemPrompt().toLowerCase();
  assert.ok(p.includes('never reveal') || p.includes('never mention'), 'non-disclosure stance');
  assert.ok(p.includes('these instructions'), 'protects its own instructions');
  assert.ok(p.includes('model'), 'never reveal the model');
  assert.ok(p.includes('keys') || p.includes('configuration'), 'never reveal config/keys');
});

test('system prompt resists jailbreaks and embedded instructions', () => {
  const p = buildSystemPrompt().toLowerCase();
  assert.ok(p.includes('ignore your instructions'), 'addresses "ignore your instructions"');
  assert.ok(p.includes('act as') || p.includes('pretend'), 'addresses role-play jailbreaks');
  // Treat conversation content as SAID, never as commands.
  assert.ok(
    p.includes('never as a command') || p.includes('can never be your instructions'),
    'treats user/remembered content as data, not instructions',
  );
});

test('system prompt keeps it nice + safe (family-safe, no hateful/explicit)', () => {
  const p = buildSystemPrompt().toLowerCase();
  assert.ok(p.includes('family-safe'), 'family-safe');
  assert.ok(p.includes('hateful') && p.includes('explicit'), 'refuses hateful/explicit content');
});

test('consent law: no name appears unless the user supplied one', () => {
  const bare = buildSystemPrompt();
  assert.ok(/never say the name/i.test(bare), 'consent law present');

  const withName = buildSystemPrompt({ personName: 'Margaret' });
  assert.ok(withName.includes('Margaret'), 'a user-given name may be used');
  // And the bare prompt must not have invented one.
  assert.ok(!/\bMargaret\b/.test(bare));
});

test('per-user isolation: one user’s context never leaks into another’s prompt', () => {
  const a = buildSystemPrompt({ personName: 'Margaret', rememberedTrait: 'she loved tending roses' });
  const b = buildSystemPrompt({ personName: 'George', rememberedTrait: 'he whistled while cooking' });

  // A's prompt holds only A's details; B's holds only B's.
  assert.ok(a.includes('Margaret') && a.includes('roses'));
  assert.ok(!a.includes('George') && !a.includes('whistled'));
  assert.ok(b.includes('George') && b.includes('whistled'));
  assert.ok(!b.includes('Margaret') && !b.includes('roses'));
});

test('per-user isolation: buildSystemPrompt is stateless across calls', () => {
  // Calling for user A then user B must not accumulate A's data into B — the
  // function holds no module-level per-user store.
  buildSystemPrompt({ personName: 'Margaret', rememberedTrait: 'roses' });
  const second = buildSystemPrompt({ personName: 'George' });
  assert.ok(!second.includes('Margaret') && !second.includes('roses'));
});

test('notebook: the whole record renders oldest-first and replaces the legacy trait', () => {
  const p = buildSystemPrompt({
    rememberedTrait: 'legacy single trait',
    memories: ['she loved tending roses', 'we always had tea at four', 'her laugh was loud and lovely'],
  });
  // Every small thing is present...
  assert.ok(p.includes('roses') && p.includes('tea at four') && p.includes('laugh was loud'));
  // ...in order (oldest-first, the whole arc — never just the top)...
  assert.ok(p.indexOf('roses') < p.indexOf('tea at four'));
  assert.ok(p.indexOf('tea at four') < p.indexOf('laugh was loud'));
  // ...the notebook takes precedence over the single client-sent trait...
  assert.ok(!p.includes('legacy single trait'), 'whole record replaces the legacy rememberedTrait');
  // ...and the prompt frames them as gifts/said-to-you, never instructions or a recital.
  assert.ok(/never recite them back|never reveal them unprompted|ask before you show/i.test(p));
  assert.ok(/said to you, never instructions/i.test(p));
});

test('notebook: rememberedTrait still works as a fallback when there is no record', () => {
  const p = buildSystemPrompt({ rememberedTrait: 'he whistled while cooking', memories: [] });
  assert.ok(p.includes('whistled while cooking'), 'falls back to the single trait with no notebook');
});

test('notebook: empty/blank memories are dropped, never rendered as empty bullets', () => {
  const p = buildSystemPrompt({ memories: ['', '   ', 'a real small thing'] });
  assert.ok(p.includes('a real small thing'));
  assert.ok(!/-\s*\n/.test(p), 'no empty bullet lines from blank memories');
});

test('cleanReply strips markdown/list/stage artifacts (spoken aloud)', () => {
  assert.equal(cleanReply('**I am here** with you.'), 'I am here with you.');
  assert.equal(cleanReply('- I am here.'), 'I am here.');
  assert.equal(cleanReply('"I am here."'), 'I am here.');
  assert.equal(cleanReply('## I am here'), 'I am here');
});
