import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { createLogger } from '@cairn/shared/logger';
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
 * HARD ADMIN GATE: every route requires the shared admin secret BERTIE_ADMIN_SECRET.
 * thecairn-proxy/web had NO existing admin gate (requireAuth validates CUSTOMER
 * Supabase tokens, which is the wrong audience), so we introduce an admin-only
 * secret here. ⚠️ FLAGGED TO AMANDA: this is a NEW admin flag — set
 * BERTIE_ADMIN_SECRET on the proxy to turn Bertie on; until it is set, EVERY
 * Bertie route returns 503 and Bertie is invisible/unusable. He is therefore
 * never customer-facing by construction.
 *
 * OPERATOR-BLIND: Bertie only ever carries the note Amanda types/speaks. He never
 * reads or touches customer content or memories.
 */

const router = Router();
const log = createLogger('bertie-route');

const ADMIN_SECRET = process.env.BERTIE_ADMIN_SECRET || '';
const NOTE_BODY_CAP = 8000; // generous; the relay caps the note itself again

/** Constant-time secret check. Returns true only on an exact match. */
function secretMatches(provided) {
  if (!ADMIN_SECRET || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(ADMIN_SECRET);
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
function adminGate(req, res, next) {
  if (!ADMIN_SECRET) {
    return res.status(503).json({
      ok: false,
      error: 'bertie_not_configured',
      hint: 'Set BERTIE_ADMIN_SECRET on the proxy to enable Bertie (admin-only).',
    });
  }
  if (!secretMatches(presentedSecret(req))) {
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
router.get('/', (req, res) => {
  if (!ADMIN_SECRET) {
    return res
      .status(503)
      .type('html')
      .send(renderBertiePage({ configured: false, ack: BERTIE_ACK_LINE, channel: BERTIE_CHANNEL }));
  }
  const key = typeof req.query?.key === 'string' && secretMatches(req.query.key.trim())
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
    adminGate: 'BERTIE_ADMIN_SECRET (set)',
    operatorBlind: true,
    voice: 'seam ready; reuses Roberta push-to-talk once her voice is live',
    note: 'Bertie keeps Amanda\'s notes only — never reads customer content.',
  });
});

export default router;
