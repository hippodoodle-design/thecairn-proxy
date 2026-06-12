/**
 * roberta-brain.js — POST /api/roberta/brain
 *
 * The key-holding server half of speak-to-Roberta (board-program item 7). The
 * frontend (thecairn-app) pushes the user's spoken/typed turn here via
 * VITE_CAIRN_BRAIN_URL; we hold the LLM + ElevenLabs keys, the persona, the
 * Cairn-law guardrails, and the per-turn metering. The FE holds NO keys.
 *
 * No Supabase auth: the public first-taste preview runs SSO-off, so this
 * endpoint is guarded by CORS (the Cairn origins + Vercel previews) and a
 * per-IP rate limit, NOT a user token. The FE silently falls back to its warm
 * local stub on any non-200, so we favour a gentle 200 over an error.
 *
 * Contract (item-7 spec):
 *   POST { context: { place }, history: [{role,content}] (≤8), userText }
 *   200  { reply, audio?, metered? }
 */

import { Router } from 'express';
import { createLogger } from '@cairn/shared/logger';
import { generateRobertaTurn } from '@cairn/shared/cairn-brain';
import { rateLimitPerUser } from '../middleware/rateLimit.js';

const log = createLogger('roberta-brain-route');

const MAX_USERTEXT_CHARS = 2000;
const MAX_HISTORY = 8;

const router = Router();

/**
 * GET /api/roberta/brain — a tiny liveness probe so the endpoint URL can be
 * sanity-checked in a browser before it's wired into the FE. Never reveals keys.
 */
router.get('/', (_req, res) => {
  res.json({ ok: true, service: 'roberta-brain', method: 'POST', ts: new Date().toISOString() });
});

router.post('/', rateLimitPerUser, async (req, res) => {
  const reqLog = log.child({ route: 'POST /api/roberta/brain' });
  const body = req.body ?? {};

  // userText is the only hard requirement. Be forgiving: an empty turn still
  // gets a warm redirect (handled in the brain), but we cap length to keep the
  // turn cheap and bounded.
  const userText = typeof body.userText === 'string' ? body.userText.slice(0, MAX_USERTEXT_CHARS) : '';
  if (typeof body.userText !== 'undefined' && typeof body.userText !== 'string') {
    return res.status(400).json({ ok: false, error: 'userText must be a string' });
  }

  // Normalise history to the last ≤8 well-formed {role, content} turns.
  const history = Array.isArray(body.history)
    ? body.history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-MAX_HISTORY)
    : [];

  const context = body.context && typeof body.context === 'object' && !Array.isArray(body.context)
    ? { place: typeof body.context.place === 'string' ? body.context.place : undefined }
    : {};

  // Per-request voice override (FE may ask for text-only). Defaults to on.
  const voice = body.voice === false ? false : undefined;

  try {
    const result = await generateRobertaTurn({ context, history, userText }, { voice });
    reqLog.info({
      msg: 'turn:done',
      source: result.meta.source,
      model: result.meta.model,
      voice: result.meta.voice,
      ttsChars: result.meta.ttsChars,
      lowBalance: result.meta.lowBalance,
      turnCost: result.metered.turnCost,
    });
    return res.json({
      reply: result.reply,
      ...(result.audio ? { audio: result.audio } : {}),
      metered: result.metered,
    });
  } catch (err) {
    // Defence-in-depth: the brain itself already degrades to a warm redirect on
    // internal failure, so reaching here is unexpected. Still answer kindly with
    // a reply field so a hiccup never dead-ends a turn (FE also has its stub).
    reqLog.error({ msg: 'turn:threw', err });
    return res.status(200).json({
      reply: 'I’m here with you. Shall we just take a quiet moment together?',
    });
  }
});

export default router;
