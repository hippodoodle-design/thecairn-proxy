/**
 * tts.js — Roberta's voice-out via ElevenLabs, server-side.
 *
 * The ElevenLabs key never reaches the client (VITE_* env vars are public).
 * We synthesize here and return base64 mp3 so the frontend can play Roberta's
 * voice with no client voice key — the STRONGLY PREFERRED shape in the item-7
 * contract.
 *
 * Spend discipline (elevenlabs-spend-approval-2026-06-12): use the EXISTING
 * balance only, never top up, never switch to a paid alternative. WATCH the
 * balance and raise to needs-amanda at ~20% remaining; until topped up, hold
 * further calls. This module:
 *   - caches the subscription/character balance briefly (so we don't query it
 *     every turn),
 *   - exposes getCharacterBalance() for metering + the low-balance gate,
 *   - caches synthesized audio for the tiny set of canned lines so repeated
 *     greetings/thanks cost ZERO characters.
 */

import { createLogger } from '../logger.js';
import { getElevenLabsApiKey } from '../buddy.js';

const log = createLogger('cairn-brain-tts');

// Roberta's locked voice id (bible d6a80e2b). Overridable only via env for
// safety testing; never hardcode a different voice into a reply.
export const ROBERTA_VOICE_ID = process.env.CAIRN_ROBERTA_VOICE_ID || 'h8eW5xfRUGVJrZhAFxqK';

const MODEL_ID = process.env.CAIRN_ELEVENLABS_MODEL || 'eleven_turbo_v2_5';
const API_BASE = 'https://api.elevenlabs.io/v1';
const TTS_TIMEOUT_MS = 12_000;
const BALANCE_TIMEOUT_MS = 4_000;

// Alert threshold per the spend approval — raise to needs-amanda at ~20% left.
export const LOW_BALANCE_FRACTION = 0.20;

// Brief in-process cache of the character balance so we don't hit the
// subscription endpoint on every turn. The balance only moves when WE spend,
// so a short TTL is plenty and keeps latency down.
const BALANCE_TTL_MS = 60_000;
let balanceCache = null; // { remaining, used, limit, fraction, at }

// Audio cache for canned lines (greetings/thanks). Keyed by the exact text.
// Bounded so it can never grow unbounded.
const audioCache = new Map();
const AUDIO_CACHE_MAX = 50;

/**
 * Fetch the ElevenLabs character balance (used vs limit). Cached for
 * BALANCE_TTL_MS. Returns null on any failure — voice is best-effort and must
 * never fail a turn.
 * @returns {Promise<{ remaining:number, used:number, limit:number, fraction:number } | null>}
 */
export async function getCharacterBalance() {
  if (balanceCache && Date.now() - balanceCache.at < BALANCE_TTL_MS) {
    const { remaining, used, limit, fraction } = balanceCache;
    return { remaining, used, limit, fraction };
  }
  let apiKey;
  try {
    apiKey = await getElevenLabsApiKey();
  } catch {
    return null;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), BALANCE_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/user/subscription`, {
      headers: { 'xi-api-key': apiKey, Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    const used = Number(body.character_count ?? 0);
    const limit = Number(body.character_limit ?? 0);
    const remaining = Math.max(0, limit - used);
    const fraction = limit > 0 ? remaining / limit : 0;
    balanceCache = { remaining, used, limit, fraction, at: Date.now() };
    return { remaining, used, limit, fraction };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Synthesize Roberta's words to base64 mp3. Best-effort: returns null (and the
 * caller returns text-only) on any failure or when the balance is too low.
 *
 * @param {string} text
 * @param {{ canned?: boolean }} [opts]  canned lines are cached so they cost 0 chars after the first time
 * @returns {Promise<{ audioBase64: string, chars: number, cached: boolean, lowBalance?: boolean } | null>}
 */
export async function synthesizeVoice(text, opts = {}) {
  const words = typeof text === 'string' ? text.trim() : '';
  if (!words) return null;

  // Serve cached canned-line audio for free (no characters spent).
  if (opts.canned && audioCache.has(words)) {
    return { audioBase64: audioCache.get(words), chars: 0, cached: true };
  }

  // Low-balance gate — hold further calls below the threshold (spend approval).
  const balance = await getCharacterBalance();
  if (balance && balance.limit > 0 && balance.fraction < LOW_BALANCE_FRACTION) {
    log.warn({ msg: 'tts:held-low-balance', remaining: balance.remaining, fraction: balance.fraction });
    return { audioBase64: null, chars: 0, cached: false, lowBalance: true };
  }

  let apiKey;
  try {
    apiKey = await getElevenLabsApiKey();
  } catch (err) {
    log.warn({ msg: 'tts:no-key', err: err instanceof Error ? err.message : String(err) });
    return null;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TTS_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/text-to-speech/${ROBERTA_VOICE_ID}?output_format=mp3_44100_128`, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: words,
        model_id: MODEL_ID,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log.warn({ msg: 'tts:non-ok', status: res.status, body: errText.slice(0, 200) });
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const audioBase64 = buf.toString('base64');

    // Spending characters moves the balance — invalidate the cache so the next
    // metering read is honest.
    balanceCache = null;

    if (opts.canned) {
      if (audioCache.size >= AUDIO_CACHE_MAX) {
        audioCache.delete(audioCache.keys().next().value);
      }
      audioCache.set(words, audioBase64);
    }

    log.info({ msg: 'tts:done', chars: words.length, bytes: buf.length, model: MODEL_ID });
    return { audioBase64, chars: words.length, cached: false };
  } catch (err) {
    log.warn({ msg: 'tts:threw', err: err instanceof Error ? err.message : String(err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
