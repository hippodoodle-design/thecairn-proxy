/**
 * Bertie persona + deferral tests.
 *
 * Two load-bearing claims, both stated in the report:
 *   1. Bertie defers correctly to Roberta — anything of weight (feeling, memory,
 *      grief, a real question, the wish for company) routes to her, with a canned,
 *      zero-spend fetch-Roberta line. His lane is a small allowlist; default = defer.
 *   2. His persona is locked, audience-tuned: BUTLER for users (service, not
 *      substance, never the brain), thinking-partner for admin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyForBertie,
  bertieDeferralLine,
  buildBertieSystemPrompt,
  BERTIE_DEFERRAL_LINES,
  BERTIE_LANE,
} from '../src/bertiePersona.js';

const defers = (t) => classifyForBertie({ userText: t }).action === 'defer';
const handles = (t) => classifyForBertie({ userText: t }).action === 'handle';

test('emotional / companionship turns defer to Roberta', () => {
  const toRoberta = [
    'I miss her so much today.',
    'I feel so alone since he died.',
    "I'm so sad and I just want to cry.",
    'Will you stay with me for a while?',
    'Can you keep me company tonight?',
    'I keep thinking about them.',
    "It's the anniversary tomorrow.",
  ];
  for (const t of toRoberta) assert.ok(defers(t), `should defer: ${t}`);
});

test('substantive / knowledge / advice turns defer to Roberta', () => {
  const toRoberta = [
    'Tell me about my mum.',
    'What do you think happens after we die?',
    'Why does it still hurt this much?',
    'Should I go to the funeral?',
    'Do you remember what I told you about her?',
  ];
  for (const t of toRoberta) assert.ok(defers(t), `should defer: ${t}`);
});

test('a deferral carries a canned fetch-Roberta line (zero-spend)', () => {
  const r = classifyForBertie({ userText: 'I miss her.' });
  assert.equal(r.action, 'defer');
  assert.ok(BERTIE_DEFERRAL_LINES.includes(r.line));
  assert.match(r.line, /Roberta/);
});

test("Bertie's lane: courtesies, comforts, journal, little services — he handles these", () => {
  const his = [
    'Hello Bertie!',
    'Thank you so much.',
    'Good morning.',
    'Could you bring me a blanket?',
    "I'd like a cup of tea please.",
    'Please put on some music.',
    'Write this down in my journal.',
    'Add this to my diary.',
    'Show me the garden.',
    'Open the cubby.',
  ];
  for (const t of his) assert.ok(handles(t), `should handle: ${t}`);
});

test('weight wins over courtesy — "thanks, but I miss her" still goes to Roberta', () => {
  assert.ok(defers('Thanks Bertie, but I really miss her.'));
});

test('the unknown / out-of-lane defaults to deferral (protect the one Roberta)', () => {
  assert.ok(defers('What is the capital of France?'));
  assert.ok(defers('Can you write my essay?'));
  assert.ok(defers('Translate this paragraph for me.'));
});

test('empty turn does not force a deferral (Bertie just stays courteous)', () => {
  const r = classifyForBertie({ userText: '   ' });
  assert.equal(r.action, 'handle');
  assert.equal(r.line, null);
});

test('bertieDeferralLine is deterministic for a given seed', () => {
  assert.equal(bertieDeferralLine('I miss her'), bertieDeferralLine('I miss her'));
  assert.ok(BERTIE_DEFERRAL_LINES.includes(bertieDeferralLine('anything')));
});

test('user (butler) prompt: service-not-substance, defers, never the brain', () => {
  const p = buildBertieSystemPrompt({ audience: 'user' });
  assert.match(p, /butler/i);
  assert.match(p, /Allow me to fetch Roberta/i);
  assert.match(p, /only ever ONE Roberta/i);
  assert.match(p, /never a second companion and never a second brain/i);
  // butler canon details present
  assert.match(p, /yellow cap/i);
  assert.match(p, /belly-screen/i);
  // never reveals he is an AI / no key leakage in the persona text
  assert.match(p, /never mention being an AI/i);
  assert.doesNotMatch(p, /aMdQCEO9kwP77QH1DiFy/);
});

test('admin prompt is the thinking-partner face — deferral rule does not bind it', () => {
  const p = buildBertieSystemPrompt({ audience: 'admin' });
  assert.match(p, /sounding-board|thinking-partner/i);
  assert.match(p, /does NOT bind you here/i);
  assert.match(p, /operator-blind/i);
  // the admin face is NOT the butler-deferral face
  assert.doesNotMatch(p, /Allow me to fetch Roberta/i);
});

test('BERTIE_LANE names his four areas of service', () => {
  assert.equal(BERTIE_LANE.length, 4);
  assert.ok(BERTIE_LANE.some((l) => /journal/i.test(l)));
  assert.ok(BERTIE_LANE.some((l) => /comfort/i.test(l)));
});
