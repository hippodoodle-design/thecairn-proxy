import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { createLogger } from '@cairn/shared/logger';
import { getCredential } from '@cairn/shared/buddy';
import { pushBertieNote, BERTIE_CHANNEL, BERTIE_SENDER, BERTIE_ACK_LINE } from '@cairn/shared/bertieRelay';
import { renderBertiePage } from './bertie-page.js';

/**
 * BERTIE — Amanda's ADMIN-ONLY in-world capture companion.
 *
 * Routes:
 *   GET  /api/bertie        → the preview page (Bertie in Roberta's belly-cubby)
 *   POST /api/bertie/note   → relay one of Amanda's notes to Claude via HippoBridge
 *   GET  /api/bertie/info   → diagnostics (channel, config, gate status)
 *
 * HARD ADMIN GATE: every route requires the shared admin secret. The secret is
 * fetched at runtime from HippoBuddy (credential `bertie-admin-secret-thecairn`,
 * Magic-4 path, same as the bridge-push token) with env var BERTIE_ADMIN_SECRET
 * as a belt-and-braces fallback — so Amanda never has to set a proxy env var.
 * thecairn-proxy/web had NO existing admin gate (requireAuth validates CUSTOMER
 * Supabase tokens, which is the wrong audience), so this is an admin-only secret.
 * Until the secret resolves (Buddy or env), EVERY Bertie route returns 503 and
 * Bertie is invisible/unusable — so he is never customer-facing by construction.
 *
 * OPERATOR-BLIND: Bertie only ever carries the note Amanda types/speaks. He never
 * reads or touches customer content or memories.
 */

const router = Router();
const log = createLogger('bertie-route');

const ADMIN_SECRET_CRED_NAME = 'bertie-admin-secret-thecairn';
const SECRET_CACHE_TTL_MS = 5 * 60 * 1000; // short; Buddy client also caches
const NOTE_BODY_CAP = 8000; // generous; the relay caps the note itself again

/** @type {{ value: string, at: number } | null} */
let _secretCache = null;

/**
 * Resolve the admin secret: HippoBuddy primary, env BERTIE_ADMIN_SECRET fallback.
 * Returns '' when neither is available (→ Bertie stays 503, never open).
 * Cached briefly so the gate doesn't re-fetch on every request.
 * @returns {Promise<string>}
 */
async function resolveAdminSecret() {
  if (_secretCache && Date.now() - _secretCache.at < SECRET_CACHE_TTL_MS) {
    return _secretCache.value;
  }
  let value = '';
  try {
    value = (await getCredential(ADMIN_SECRET_CRED_NAME, { envFallbackName: 'BERTIE_ADMIN_SECRET' })) || '';
  } catch {
    // No Buddy configured AND no env fallback — leave Bertie disabled.
    value = (process.env.BERTIE_ADMIN_SECRET || '').trim();
  }
  _secretCache = { value, at: Date.now() };
  return value;
}

/** Constant-time secret check against the resolved admin secret. */
function secretMatches(provided, secret) {
  if (!secret || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Pull the admin secret from header, bearer, query (page link) or body. */
function presentedSecret(req) {
  const header = req.get('x-bertie-admin');
  if (header) return header.trim();
  const auth = req.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  if (typeof req.query?.key === 'string') return req.query.key.trim();
  if (typeof req.body?.adminSecret === 'string') return req.body.adminSecret.trim();
  return null;
}

/**
 * Admin gate middleware. 503 if Bertie isn't configured at all (so he's never
 * accidentally open), 401 if a wrong/absent secret is presented.
 */
async function adminGate(req, res, next) {
  const secret = await resolveAdminSecret();
  if (!secret) {
    return res.status(503).json({
      ok: false,
      error: 'bertie_not_configured',
      hint: 'Provision HippoBuddy credential `bertie-admin-secret-thecairn` (or set BERTIE_ADMIN_SECRET) to enable Bertie (admin-only).',
    });
  }
  if (!secretMatches(presentedSecret(req), secret)) {
    return res.status(401).json({ ok: false, error: 'admin_only' });
  }
  return next();
}

/**
 * GET /api/bertie — the preview page.
 * If no ?key is supplied it serves a tiny unlock screen (so the link itself is
 * shareable without leaking the secret); the page then calls the API with the
 * key the admin pastes. If a correct ?key IS supplied we hand it to the page so
 * Amanda lands straight in. Page never embeds the secret unless she provides it.
 */
router.get('/', async (req, res) => {
  const secret = await resolveAdminSecret();
  if (!secret) {
    return res
      .status(503)
      .type('html')
      .send(renderBertiePage({ configured: false, ack: BERTIE_ACK_LINE, channel: BERTIE_CHANNEL }));
  }
  const key = typeof req.query?.key === 'string' && secretMatches(req.query.key.trim(), secret)
    ? req.query.key.trim()
    : '';
  return res
    .type('html')
    .send(renderBertiePage({ configured: true, presetKey: key, ack: BERTIE_ACK_LINE, channel: BERTIE_CHANNEL }));
});

/**
 * POST /api/bertie/note — relay one note to Claude.
 * Body: { note: string, context?: string, mode?: 'type'|'voice', adminSecret?: string }
 * Query: ?dry=1 builds + returns the payload WITHOUT pushing (verification / ~£0).
 */
router.post('/note', adminGate, async (req, res) => {
  const reqLog = log.child({ route: 'POST /api/bertie/note' });

  const note = String(req.body?.note ?? '').slice(0, NOTE_BODY_CAP);
  const context = req.body?.context ? String(req.body.context).slice(0, 120) : undefined;
  const mode = req.body?.mode === 'voice' ? 'voice' : 'type';
  const dryRun = req.query?.dry === '1' || req.body?.dryRun === true;

  if (!note.trim()) {
    return res.status(400).json({ ok: false, error: 'empty_note', ack: "I didn't catch a note there — try again?" });
  }

  const result = await pushBertieNote({ note, context, mode, dryRun });

  reqLog.info({
    event: dryRun ? 'bertie_note_dryrun' : 'bertie_note_relayed',
    ok: result.ok,
    mode,
    hasContext: Boolean(context),
    channel: result.channel,
    // note text itself is intentionally NOT logged
  });

  const status = result.ok ? 200 : 502;
  return res.status(status).json({
    ok: result.ok,
    ack: result.ack,
    channel: result.channel,
    sender: result.sender,
    dryRun: result.dryRun,
    ...(result.messageId ? { messageId: result.messageId } : {}),
    ...(dryRun ? { payload: result.payload } : {}),
    ...(result.ok ? {} : { error: result.error }),
  });
});

/** GET /api/bertie/info — config + gate diagnostics. No spend. */
router.get('/info', adminGate, (req, res) => {
  return res.json({
    ok: true,
    channel: BERTIE_CHANNEL,
    sender: BERTIE_SENDER,
    ackLine: BERTIE_ACK_LINE,
    adminGate: 'bertie-admin-secret-thecairn via HippoBuddy (env fallback BERTIE_ADMIN_SECRET)',
    operatorBlind: true,
    voice: 'seam ready; reuses Roberta push-to-talk once her voice is live',
    note: 'Bertie keeps Amanda\'s notes only — never reads customer content.',
  });
});

export default router;
