import { Router } from 'express';
import { createHash } from 'node:crypto';
import { createLogger } from '@cairn/shared/logger';
import { rateLimitPerUser } from '../middleware/rateLimit.js';
import { converse, BrainError, BRAIN_MODEL, BRAIN_PROVIDER } from '@cairn/shared/robertaBrain';
import { guardTurn } from '@cairn/shared/robertaGuard';
import { recallMemories, appendMemory } from '@cairn/shared/robertaMemory';
import { synthesizeSpeech, ROBERTA_VOICE_ID, ElevenLabsError } from '@cairn/shared/elevenlabs';

const router = Router();
const log = createLogger('roberta-brain-route');

/**
 * Roberta's BRAIN, server-side — the whole speak-to-Roberta turn in one call.
 *
 * The user speaks (FREE browser STT on the client), their words arrive here, and
 * Roberta thinks a gentle, in-character reply. We then ALSO synthesise her voice
 * server-side (ElevenLabs) and hand the audio back inline, so the frontend holds
 * NO keys: it gets her words AND her voice from a single POST. This is the seam
 * the thecairn-app First-Taste mic UI calls via VITE_CAIRN_BRAIN_URL.
 *
 * Why both keys live here (never in the client bundle): Vite VITE_* vars are
 * PUBLIC. An LLM key or an ElevenLabs key shipped to the browser is a key anyone
 * can read and drain — and the First-Taste preview runs with SSO off. So the LLM,
 * the voice key, the persona, the guardrails, and the metering all live in the
 * proxy. The frontend holds nothing but the URL.
 *
 * Spend discipline at the edge (each turn is metered, so we keep turns bounded):
 *   1. CORS origin allowlist (server.js) — only thecairn.app + an opt-in preview
 *      origin may call.
 *   2. rateLimitPerUser — falls back to per-IP when unauthenticated. First Taste
 *      runs pre-signup, so we do NOT require a JWT here.
 *   3. TEXT_CAP — a user turn is a spoken sentence; a cap stops a long body
 *      inflating prompt tokens.
 *   4. The model is cheap-but-warm (Haiku-class; gpt-4o-mini by default) and the
 *      reply is output-capped in the brain seam, so a turn can't run away.
 *   5. Voice cache — greetings and acknowledgements repeat constantly, so each
 *      unique reply line is synthesised ONCE per process and replayed free.
 *
 * The Cairn's laws (persona prompt is the source of truth; this route is the
 * braces): user-initiated only, consent law (Roberta NEVER names the dead — only
 * the user does), tender / safe / no-medical-advice / always in character. On any
 * trouble the reply text is still returned where we can; the client also keeps a
 * warm local stub so a proxy hiccup never dead-ends a turn.
 */

const TEXT_CAP = 1000; // chars per spoken user turn
const MAX_HISTORY = 8; // turns; the brain clamps again defensively

// Inline voice-out. Default ON for the preview so the FE needs no voice key; a
// single env flips it off (then the FE falls back to free browser speech).
const TTS_ENABLED = String(process.env.ROBERTA_BRAIN_TTS ?? 'on').toLowerCase() !== 'off';
const TTS_TEXT_CAP = 600; // ElevenLabs is balance-limited; never synthesise a long line.

// ─── Voice cache (reply line → base64 mp3) ──────────────────────────────────
// Common lines (greetings, "I'm here", acknowledgements) repeat, so we pay
// ElevenLabs once per unique line per process. Same LRU shape as roberta-voice.js.
const CACHE_MAX = 256;
/** @type {Map<string, { audio: string, chars: number }>} */
const audioCache = new Map();
function voiceKey(text) {
  return createHash('sha256').update(`${ROBERTA_VOICE_ID} ${text}`).digest('hex');
}
function voiceCacheGet(key) {
  const hit = audioCache.get(key);
  if (!hit) return null;
  audioCache.delete(key);
  audioCache.set(key, hit); // bump to most-recently-used
  return hit;
}
function voiceCacheSet(key, value) {
  audioCache.set(key, value);
  if (audioCache.size > CACHE_MAX) audioCache.delete(audioCache.keys().next().value);
}

// ─── Per-turn metering (preview = a simple counter; full credit wiring later) ─
// turnCost = STT (free, browser) + LLM (real token cost) + TTS (char-based est.).
// creditsLeft draws down a notional preview pot so the FE can surface a number.
const PREVIEW_CREDIT_USD = Number(process.env.ROBERTA_PREVIEW_CREDIT_USD || 5);
// ElevenLabs bills per character; a rough USD/char so turnCost reflects voice too.
const TTS_USD_PER_CHAR = Number(process.env.ELEVENLABS_USD_PER_CHAR || 0.00018);
const meter = { turns: 0, spentUsd: 0, ttsChars: 0 };

/**
 * POST /api/roberta-brain/chat   (set as VITE_CAIRN_BRAIN_URL on the FE preview)
 *
 * Request  (the FE contract):
 *   { context?: { place?: string }, history?: [{ role, content }], userText: string }
 *   — `text` is also accepted as an alias for `userText` (back-compat).
 * Response (the FE contract):
 *   { reply: string,                         // REQUIRED — Roberta's words (on screen)
 *     audio?: string,                        // base64 mp3 of her voice (omitted on TTS trouble)
 *     metered?: { turnCost, currency, creditsLeft },
 *     // diagnostics (safe to ignore on the FE):
 *     ok, model, provider, usage, costUsd, priceKnown, voiced }
 */
router.post('/chat', rateLimitPerUser, async (req, res) => {
  const reqLog = log.child({ route: 'POST /api/roberta-brain/chat' });

  // Accept the FE field name (`userText`) and the older alias (`text`).
  const userText = String(req.body?.userText ?? req.body?.text ?? '').trim();
  const place = req.body?.context?.place ? String(req.body.context.place).slice(0, 40) : null;
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-MAX_HISTORY) : [];
  // The consent-law "warm name" path: the client may pass a name ONLY if the user
  // themselves supplied it. The persona prompt never volunteers one regardless.
  const personName = req.body?.personName ? String(req.body.personName).slice(0, 80) : null;
  const rememberedTrait = req.body?.rememberedTrait ? String(req.body.rememberedTrait).slice(0, 200) : null;

  // ─── Roberta's notebook — the WHOLE record, recalled oldest-first ──────────
  // requireAuth sets req.auth.userId for a signed-in user. First-Taste preview is
  // pre-signup, so userId is null there and this whole path lies dormant: recall
  // returns [] and append no-ops, exactly as before. It comes alive the moment
  // real accounts land — no further wiring. The single client-sent rememberedTrait
  // is now only a back-compat fallback; the notebook is the source of truth.
  //
  // Fail-soft is the law: memory must NEVER break a turn. A missing table
  // (pre-migration) or any DB hiccup degrades to an empty recall, never an error.
  // We recall BEFORE the guard so each remembered line is screened as an untrusted
  // note too (defence-in-depth — though by construction the notebook only ever
  // holds turns the guard already ALLOWED, so this never spuriously blocks).
  const userId = req.auth?.userId || null;
  let memories = [];
  if (userId) {
    try {
      const rows = await recallMemories({ userId });
      memories = rows.map((r) => r.content);
    } catch (err) {
      reqLog.warn({ event: 'memory_recall_failed', err: err instanceof Error ? err.message : String(err) });
    }
  }

  // ─── Rule-based guard, BEFORE any AI spend (Comm Triangle, no model) ───────
  // Scope lock + injection/jailbreak filter + input caps. Abuse is turned away
  // for free; only an allowed turn ever reaches the brain. (Per-user rate limit
  // and CORS already ran ahead of this.) personName/rememberedTrait AND every
  // recalled memory are screened too because injection can be smuggled into
  // "remembered" notes.
  const guard = guardTurn({ userText, history, notes: [personName, rememberedTrait, ...memories] });
  if (guard.action === 'reject') {
    return res.status(guard.status).json({ ok: false, error: guard.error });
  }

  let reply;
  let model;
  let provider;
  let usage;
  let cost;

  if (guard.action === 'block') {
    // Turned aside in-character with NO LLM call. We still voice + meter below so
    // the turn lands warmly and the (tiny, fixed) set of decline lines stays in
    // the voice cache — so even abuse costs ~nothing.
    reply = guard.reply;
    model = 'guard';
    provider = 'rule-based';
    usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    cost = { usd: 0, priceKnown: true };
    reqLog.info({ event: 'brain_guard_block', reason: guard.reason });
  } else {
    try {
      ({ reply, model, provider, usage, cost } = await converse({
        userText,
        history,
        place,
        personName,
        rememberedTrait,
        memories,
      }));
    } catch (err) {
      const status = err instanceof BrainError ? err.status : null;
      if (status === 401 || status === 403) {
        reqLog.error({ event: 'brain_bad_key', model: BRAIN_MODEL, err: err.message });
      } else if (status === 429) {
        reqLog.warn({ event: 'brain_provider_rate_limited', err: err.message });
      } else {
        reqLog.warn({ msg: 'brain turn failed', err: err instanceof Error ? err.message : String(err) });
      }
      // Fail-soft: never a refusal wall. Hand back a gentle, in-character line so the
      // turn still lands warmly; the client also has its own stub behind a non-200,
      // but a 200 here keeps Roberta present even when the FE stub is off.
      return res.status(200).json({
        ok: false,
        reply: "I'm here with you. Take your time — I'm not going anywhere.",
        degraded: true,
      });
    }
  }

  // ─── Append this turn to the notebook (Infinite Append; never truncated) ──
  // Only for a genuine brain turn (not a guard-block decline) and only when there
  // is a user to keep it for. Append-only by construction — robertaMemory exports
  // no update/delete and the DB grant withholds both. Fail-soft: a storage hiccup
  // must never cost the user their reply, and pre-migration this no-ops cleanly.
  if (userId && model !== 'guard') {
    try {
      await appendMemory({ userId, content: userText, kind: 'note', source: 'roberta' });
    } catch (err) {
      reqLog.warn({ event: 'memory_append_failed', err: err instanceof Error ? err.message : String(err) });
    }
  }

  // ─── Voice-out (inline, cached, fail-soft) ────────────────────────────────
  let audio = null;
  let ttsChars = 0;
  if (TTS_ENABLED && reply.length <= TTS_TEXT_CAP) {
    const key = voiceKey(reply);
    const cached = voiceCacheGet(key);
    if (cached) {
      audio = cached.audio;
      ttsChars = 0; // a cache hit spends no ElevenLabs balance
    } else {
      try {
        const { audio: buf } = await synthesizeSpeech({ text: reply });
        audio = buf.toString('base64');
        ttsChars = reply.length;
        voiceCacheSet(key, { audio, chars: reply.length });
      } catch (err) {
        const status = err instanceof ElevenLabsError ? err.status : null;
        // 402 = out of voice credit — loud, so the watch loop can escalate.
        if (status === 402) {
          reqLog.error({ event: 'elevenlabs_out_of_credits', err: err.message });
        } else if (status === 401) {
          reqLog.error({ event: 'elevenlabs_bad_key', err: err.message });
        } else {
          reqLog.warn({ msg: 'voice-out failed (fail-soft, text-only)', err: err instanceof Error ? err.message : String(err) });
        }
        // Leave audio null: the reply text is the source of truth and the FE can
        // speak it with free browser TTS, so the turn never dead-ends.
      }
    }
  }

  // ─── Meter this turn ──────────────────────────────────────────────────────
  const llmUsd = cost?.usd ?? 0;
  const ttsUsd = ttsChars * TTS_USD_PER_CHAR;
  const turnCost = Number((llmUsd + ttsUsd).toFixed(6));
  meter.turns += 1;
  meter.spentUsd += turnCost;
  meter.ttsChars += ttsChars;
  const creditsLeft = Number(Math.max(0, PREVIEW_CREDIT_USD - meter.spentUsd).toFixed(6));

  reqLog.info({
    event: 'brain_turn',
    model,
    voiced: Boolean(audio),
    ttsChars,
    turnCostUsd: turnCost,
    turns: meter.turns,
  });

  return res.json({
    reply,
    ...(audio ? { audio } : {}),
    metered: { turnCost, currency: 'USD', creditsLeft },
    // diagnostics
    ok: true,
    ...(guard.action === 'block' ? { guarded: true, guardReason: guard.reason } : {}),
    model,
    provider,
    usage,
    costUsd: llmUsd,
    priceKnown: cost?.priceKnown ?? false,
    voiced: Boolean(audio),
  });
});

/**
 * GET /api/roberta-brain/info
 * → which model/provider is live, whether inline voice is on, and the running
 *   preview meter. No spend; safe to poll for the watch loop + an honest
 *   "running on …" line.
 */
router.get('/info', (req, res) => {
  return res.json({
    ok: true,
    provider: BRAIN_PROVIDER,
    model: BRAIN_MODEL,
    voice: TTS_ENABLED ? { enabled: true, voiceId: ROBERTA_VOICE_ID } : { enabled: false },
    meter: {
      turns: meter.turns,
      spentUsd: Number(meter.spentUsd.toFixed(6)),
      ttsChars: meter.ttsChars,
      creditsLeft: Number(Math.max(0, PREVIEW_CREDIT_USD - meter.spentUsd).toFixed(6)),
      currency: 'USD',
    },
    note: 'cheap-but-warm brain; output-capped; voice-in is free browser STT; voice-out inline + cached',
  });
});

export default router;
