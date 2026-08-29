/**
 * Voice-selection tests for the shared TTS seam.
 *
 * The load-bearing claim: ONE seam, TWO distinct voices, selected per CHARACTER —
 * Bertie's lines render in HIS voice, Roberta's in hers, and a caller can never
 * coax the seam onto an off-cast voice (spend stays locked to the known cast).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROBERTA_VOICE_ID,
  BERTIE_VOICE_ID,
  CAIRN_VOICES,
  DEFAULT_CHARACTER,
  voiceIdForCharacter,
} from '../src/elevenlabs.js';

test('the two voices are distinct and locked to their canon ids', () => {
  assert.equal(ROBERTA_VOICE_ID, 'h8eW5xfRUGVJrZhAFxqK');
  assert.equal(BERTIE_VOICE_ID, 'aMdQCEO9kwP77QH1DiFy');
  assert.notEqual(ROBERTA_VOICE_ID, BERTIE_VOICE_ID);
});

test('CAIRN_VOICES maps each character to its own voice', () => {
  assert.equal(CAIRN_VOICES.roberta, ROBERTA_VOICE_ID);
  assert.equal(CAIRN_VOICES.bertie, BERTIE_VOICE_ID);
});

test('voiceIdForCharacter selects Bertie\'s voice for Bertie, Roberta\'s for Roberta', () => {
  assert.equal(voiceIdForCharacter('bertie'), BERTIE_VOICE_ID);
  assert.equal(voiceIdForCharacter('roberta'), ROBERTA_VOICE_ID);
  // Case/whitespace tolerant.
  assert.equal(voiceIdForCharacter('  BERTIE '), BERTIE_VOICE_ID);
  assert.equal(voiceIdForCharacter('Roberta'), ROBERTA_VOICE_ID);
});

test('unknown or empty character falls back to Roberta — never an off-cast voice', () => {
  const fallback = CAIRN_VOICES[DEFAULT_CHARACTER];
  assert.equal(voiceIdForCharacter(''), fallback);
  assert.equal(voiceIdForCharacter(null), fallback);
  assert.equal(voiceIdForCharacter(undefined), fallback);
  assert.equal(voiceIdForCharacter('mallory'), fallback);
  // A caller cannot smuggle a raw voice id through the name selector.
  assert.equal(voiceIdForCharacter('some-other-voice-id'), fallback);
});
