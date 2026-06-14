/**
 * ElevenLabs client — the Cairn's voices (TTS / voice-out).
 *
 * Why this lives server-side: the Cairn's ElevenLabs account is a *balance-limited*
 * pot. A key shipped to the browser is a key anyone can read from the bundle and
 * drain. So the key never leaves the proxy; the frontend POSTs text and gets audio
 * back. Spend is protected three ways at the edge (see routes/roberta-voice.js):
 * origin allowlist, per-caller rate limit, and a cache so each scripted line is
 * synthesised once.
 *
 * TWO DISTINCT VOICES through ONE seam (canon: Cairn world doc a45870e9):
 *   • Roberta — the single companion voice/brain. Locked id (bible d6a80e2b).
 *   • Bertie  — the small pink robot butler in Roberta's cubby. Locked id below.
 * A character's voice id is its IDENTITY, not a secret, so it is safe to bake in.
 * Callers select by CHARACTER NAME (see `voiceIdForCharacter`) — never by raw
 * voice id — so spend stays locked to the known cast. Both voices ride the SAME
 * `ELEVENLABS_API_KEY`; Bertie lights up alongside Roberta with no new key.
 *
 * The key is fetched via Buddy (credential `elevenlabs-api-key-thecairn`) with an
 * ELEVENLABS_API_KEY env-var fallback, mirroring the OpenAI seam (Wave 5c).
 */

import { createLogger } from './logger.js';
import { getElevenLabsApiKey } from './buddy.js';

const log = createLogger('elevenlabs');

/** Roberta's locked voice (bible d6a80e2b). */
export const ROBERTA_VOICE_ID = 'h8eW5xfRUGVJrZhAFxqK';

/** Bertie's locked voice — small pink robot butler (canon: Cairn world doc a45870e9). */
export const BERTIE_VOICE_ID = 'aMdQCEO9kwP77QH1DiFy';

/**
 * The Cairn's cast → its locked voice id. This is the SINGLE place a character
 * maps to a voice; the voice route and any brain read it so a line always renders
 * in the right character's voice. Keys are lowercase character names.
 */
export const CAIRN_VOICES = Object.freeze({
  roberta: ROBERTA_VOICE_ID,
  bertie: BERTIE_VOICE_ID,
});

/** The voice a line gets when no (or an unknown) character is named. */
export const DEFAULT_CHARACTER = 'roberta';

/**
 * Resolve a CHARACTER NAME ('roberta' | 'bertie') to its locked voice id. We map
 * by name, never by a caller-supplied voice id, so a caller can only ever spend on
 * a known member of the cast — an empty or unknown character falls back to Roberta
 * rather than honouring an arbitrary voice.
 *
 * @param {string|null|undefined} character
 * @returns {string} a locked ElevenLabs voice id
 */
export function voiceIdForCharacter(character) {
  const key = String(character || '').trim().toLowerCase();
  return CAIRN_VOICES[key] || CAIRN_VOICES[DEFAULT_CHARACTER];
}

const API_BASE = 'https://api.elevenlabs.io/v1';
const DEFAULT_MODEL = 'eleven_turbo_v2'; // low-latency, low-cost — right for short narration
const DEFAULT_VOICE_SETTINGS = { stability: 0.5, similarity_boost: 0.75 };

const SYNTH_TIMEOUT_MS = 20_000;
const SUBSCRIPTION_TIMEOUT_MS = 8_000;

/** Errors from the ElevenLabs seam carry the upstream HTTP status when there is one. */
export class ElevenLabsError extends Error {
  constructor(message, { status = null, cause } = {}) {
    super(message);
    this.name = 'ElevenLabsError';
    this.status = status;
    if (cause) this.cause = cause;
  }
}

/** fetch with an AbortController timeout. Never leaves a timer dangling. */
async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new ElevenLabsError('ElevenLabs request timed out', { cause: err });
    }
    throw new ElevenLabsError(err?.message || String(err), { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve the API key, surfacing a clean ElevenLabsError if it is not provisioned. */
async function resolveKey() {
  try {
    return await getElevenLabsApiKey();
  } catch (err) {
    throw new ElevenLabsError(
      `ElevenLabs key not provisioned (Buddy elevenlabs-api-key-thecairn / env ELEVENLABS_API_KEY): ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * Synthesise a line in a Cairn voice. Defaults to Roberta; pass a voice id from
 * `voiceIdForCharacter(character)` to render Bertie's lines in his voice.
 *
 * @param {{ text: string, voiceId?: string, modelId?: string, voiceSettings?: object }} opts
 * @returns {Promise<{ audio: Buffer, contentType: string, voiceId: string, modelId: string }>}
 */
export async function synthesizeSpeech({
  text,
  voiceId = ROBERTA_VOICE_ID,
  modelId = DEFAULT_MODEL,
  voiceSettings = DEFAULT_VOICE_SETTINGS,
} = {}) {
  const line = String(text || '').trim();
  if (!line) throw new ElevenLabsError('No text to synthesise');

  const apiKey = await resolveKey();

  const res = await fetchWithTimeout(
    `${API_BASE}/text-to-speech/${encodeURIComponent(voiceId)}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text: line, model_id: modelId, voice_settings: voiceSettings }),
    },
    SYNTH_TIMEOUT_MS,
  );

  if (!res.ok) {
    // 401 bad key, 402 out of credits, 429 rate-limited — keep the taxonomy
    // useful to the caller without leaking the response body.
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    throw new ElevenLabsError(
      `ElevenLabs TTS failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`,
      { status: res.status },
    );
  }

  const audio = Buffer.from(await res.arrayBuffer());
  log.info({ msg: 'tts:done', voiceId, modelId, chars: line.length, bytes: audio.length });
  return { audio, contentType: res.headers.get('content-type') || 'audio/mpeg', voiceId, modelId };
}

/**
 * Read the account's character balance — the "is there spend left?" signal that
 * the watch/alert loop needs. ElevenLabs counts spend in characters synthesised.
 *
 * @returns {Promise<{ tier: string|null, characterCount: number, characterLimit: number, charactersRemaining: number, fractionRemaining: number }>}
 */
export async function getSubscription() {
  const apiKey = await resolveKey();

  const res = await fetchWithTimeout(
    `${API_BASE}/user/subscription`,
    { method: 'GET', headers: { 'xi-api-key': apiKey, Accept: 'application/json' } },
    SUBSCRIPTION_TIMEOUT_MS,
  );

  if (!res.ok) {
    throw new ElevenLabsError(`ElevenLabs subscription read failed: HTTP ${res.status}`, { status: res.status });
  }

  const body = await res.json();
  const characterCount = Number(body.character_count ?? 0);
  const characterLimit = Number(body.character_limit ?? 0);
  const charactersRemaining = Math.max(0, characterLimit - characterCount);
  const fractionRemaining = characterLimit > 0 ? charactersRemaining / characterLimit : 0;

  return {
    tier: body.tier ?? null,
    characterCount,
    characterLimit,
    charactersRemaining,
    fractionRemaining,
  };
}
