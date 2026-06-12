/**
 * cairn-brain — the server half of speak-to-Roberta (board-program item 7).
 *
 * One entry point, generateRobertaTurn(), that:
 *   1) screens the input (empty/unsafe → gentle safe redirect),
 *   2) serves a free canned line for the commonest openers (greeting/thanks),
 *      else asks the cheap-but-warm LLM brain,
 *   3) runs the model's words through the server safety belt (the "braces"),
 *   4) optionally synthesizes Roberta's voice (ElevenLabs, base64 mp3),
 *   5) meters the turn (LLM + TTS estimate) and reports credits left.
 *
 * Keys + persona + guardrails + metering all live here, in the proxy — the
 * frontend holds nothing. The FE silently falls back to its warm local stub on
 * any non-200, so this module favours returning a gentle reply over throwing.
 */

import { createLogger } from '../logger.js';
import { buildSystemPrompt, cannedReply, screenReply, SAFE_REDIRECT } from './persona.js';
import { generateReply, DEFAULT_MODEL } from './llm.js';
import { synthesizeVoice, getCharacterBalance, LOW_BALANCE_FRACTION } from './tts.js';

// Re-export the persona helpers so callers + tests can reach them through the
// single package entry point (@cairn/shared/cairn-brain) without a deep import.
export { buildSystemPrompt, cannedReply, screenReply, SAFE_REDIRECT } from './persona.js';

const log = createLogger('cairn-brain');

// Voice is on by default (audio is strongly preferred) but can be turned off
// globally for cost control, or per-request via opts.voice === false.
const VOICE_DEFAULT_ON = process.env.CAIRN_TTS_ENABLED !== 'false';

// Very rough ElevenLabs character cost, only to give `turnCost` a sensible
// non-zero figure in the preview phase. Existing-balance plan, so real spend is
// the character count; we surface USD as an estimate for the FE to show.
const ELEVENLABS_USD_PER_1K_CHARS = 0.30;

// In-process metering counters. Preview-phase only — a simple counter + the
// `metered` field is the agreed bar; full per-user credit integration is a
// follow-up. Resets on redeploy, which is fine for a preview.
const meter = { turns: 0, llmCostUsd: 0, ttsChars: 0, ttsCostUsd: 0, lowBalanceAlerts: 0 };

/** Snapshot of the running meter (for /metrics-style reads or the test script). */
export function getMeterSnapshot() {
  return { ...meter };
}

/**
 * @param {Object} input
 * @param {{ place?: string }} [input.context]
 * @param {Array<{role:string, content:string}>} [input.history]
 * @param {string} input.userText
 * @param {{ voice?: boolean }} [opts]
 * @returns {Promise<{ reply: string, audio?: string, metered: object, meta: object }>}
 */
export async function generateRobertaTurn(input, opts = {}) {
  const context = input?.context && typeof input.context === 'object' ? input.context : {};
  const history = Array.isArray(input?.history) ? input.history : [];
  const userText = typeof input?.userText === 'string' ? input.userText.trim() : '';
  const wantVoice = opts.voice === undefined ? VOICE_DEFAULT_ON : opts.voice !== false;

  meter.turns += 1;

  let reply;
  let source; // 'canned' | 'llm' | 'redirect'
  let model = null;
  let llmCostUsd = 0;
  let canned = false;

  if (!userText) {
    // Empty turn → gentle safe redirect, never a refusal. No spend.
    reply = SAFE_REDIRECT;
    source = 'redirect';
  } else {
    const fixed = cannedReply(userText);
    if (fixed) {
      reply = fixed;
      source = 'canned';
      canned = true;
    } else {
      try {
        const out = await generateReply({
          systemPrompt: buildSystemPrompt(context),
          history,
          userText,
        });
        model = out.model;
        llmCostUsd = out.costUsd;
        meter.llmCostUsd += out.costUsd;
        const screened = screenReply(out.reply, userText);
        if (screened.redirected) {
          log.info({ msg: 'turn:reply-screened' });
        }
        reply = screened.reply;
        source = 'llm';
      } catch (err) {
        // Brain unavailable → warm redirect rather than an error. The FE would
        // fall back to its stub on a non-200 anyway; a gentle 200 is kinder.
        log.warn({ msg: 'turn:brain-failed', code: err?.code, err: err?.message });
        reply = SAFE_REDIRECT;
        source = 'redirect';
      }
    }
  }

  // Voice-out (best-effort). Canned lines reuse cached audio (0 chars).
  let audio;
  let ttsChars = 0;
  let lowBalance = false;
  if (wantVoice && reply) {
    const tts = await synthesizeVoice(reply, { canned });
    if (tts?.audioBase64) {
      audio = tts.audioBase64;
      ttsChars = tts.chars;
      meter.ttsChars += tts.chars;
    } else if (tts?.lowBalance) {
      lowBalance = true;
    }
  }

  const ttsCostUsd = (ttsChars / 1000) * ELEVENLABS_USD_PER_1K_CHARS;
  meter.ttsCostUsd += ttsCostUsd;

  // Credits-left = ElevenLabs characters remaining (the real preview-phase
  // constraint). Cheap cached read.
  const balance = await getCharacterBalance();
  if (balance && balance.limit > 0 && balance.fraction < LOW_BALANCE_FRACTION) {
    lowBalance = true;
    meter.lowBalanceAlerts += 1;
    log.warn({
      msg: 'roberta_tts_low_balance',
      remaining: balance.remaining,
      limit: balance.limit,
      fraction: Number(balance.fraction.toFixed(3)),
      action: 'raise needs-amanda + hold further ElevenLabs calls',
    });
  }

  const turnCostUsd = Number((llmCostUsd + ttsCostUsd).toFixed(6));
  const metered = {
    turnCost: turnCostUsd,
    currency: 'USD',
    creditsLeft: balance ? balance.remaining : null,
  };

  return {
    reply,
    ...(audio ? { audio } : {}),
    metered,
    meta: {
      source,
      model: model || (source === 'llm' ? DEFAULT_MODEL : null),
      voice: Boolean(audio),
      ttsChars,
      lowBalance,
      turn: meter.turns,
    },
  };
}
