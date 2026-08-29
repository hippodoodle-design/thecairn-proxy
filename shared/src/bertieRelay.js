/**
 * bertieRelay.js — BERTIE's one job: carry Amanda's note to Claude.
 *
 * BERTIE is Amanda's (and admin staff's) in-world capture companion. While she's
 * playing / wandering the experience, if she spots an update, a fix, or an idea,
 * she tells Bertie ("Bertie, note: …") and he tucks it away and passes it to
 * Claude — no context-switch, no leaving the zone. This is the spoken/in-world
 * twin of Amanda's z-prefix email notes: same purpose, zero friction.
 *
 * What this seam does: push ONE note onto HippoBridge (channel
 * `amanda-notes:bonnie-bothy-cloud`, sender `bertie`) so claude_app reads it.
 * It reuses the EXISTING bridge-push path already proven in shared/src/buddy.js
 * (Magic 4): fetch `bridge-push-token-thecairn` from HippoBuddy (env fallback),
 * POST to BRIDGE_PUSH_URL. No new infra, no new token, ~£0.
 *
 * OPERATOR-BLIND (hard law): Bertie keeps AMANDA'S notes only. He NEVER reads or
 * touches customer content or customer memories. The ONLY thing that crosses this
 * seam is the note Amanda herself typed or spoke. Nothing is read back, nothing
 * about any customer is attached.
 *
 * ADMIN-ONLY: this seam is only ever reached from the admin-gated Bertie route
 * (web/src/routes/bertie.js). It is never wired to any customer-facing surface.
 */

import { getCredential } from './buddy.js';

/* ─── Swappable defaults — AMANDA'S CALL (sensible defaults set here) ──────────
 * These three are explicitly Amanda's to change. Defaults are chosen to "just
 * work"; override per-deploy with the env vars noted.
 */
// The relay channel claude_app reads. Override: BERTIE_RELAY_CHANNEL
export const BERTIE_CHANNEL = process.env.BERTIE_RELAY_CHANNEL || 'amanda-notes:bonnie-bothy-cloud';
// Who the note is from, on the bridge. Override: BERTIE_SENDER
export const BERTIE_SENDER = process.env.BERTIE_SENDER || 'bertie';
// Bertie's wee acknowledgement so Amanda KNOWS it landed (Banana-Test plain).
// Override: BERTIE_ACK_LINE
export const BERTIE_ACK_LINE = process.env.BERTIE_ACK_LINE || "Got it — tucked away and passed to Claude.";

// Wake phrasings Bertie strips off the front of a note before relaying, so the
// note Claude reads is clean ("the kettle's squint" not "Bertie, note: the
// kettle's squint"). Swappable; defaults cover the natural ways Amanda speaks.
// Override (comma-separated): BERTIE_WAKE_PHRASES
const DEFAULT_WAKE_PHRASES = [
  'bertie, keep a record of this and pass it to claude',
  'bertie keep a record of this and pass it to claude',
  'bertie, keep a record of this',
  'bertie, pass it to claude',
  'bertie, note:',
  'bertie, note',
  'bertie note:',
  'bertie note',
  'bertie,',
  'bertie',
];
const WAKE_PHRASES = (process.env.BERTIE_WAKE_PHRASES
  ? process.env.BERTIE_WAKE_PHRASES.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_WAKE_PHRASES
).map((s) => s.toLowerCase());

// Bridge-push reuse (same names buddy.js already uses for Magic 4).
const BRIDGE_PUSH_TOKEN_CRED_NAME = 'bridge-push-token-thecairn';
const BRIDGE_PUSH_TIMEOUT_MS = 3000;
const TOKEN_FETCH_TIMEOUT_MS = 2000;

// A note is a sentence or three, not an essay. Cap keeps a stray paste bounded.
const NOTE_CAP = 4000;

/** Strip a leading wake phrase ("Bertie, note: …") so Claude reads the note clean. */
export function stripWakePhrase(text) {
  let s = String(text || '').trim();
  const lower = s.toLowerCase();
  for (const phrase of WAKE_PHRASES) {
    if (lower.startsWith(phrase)) {
      s = s.slice(phrase.length).replace(/^[\s:,–—-]+/, '').trim();
      break; // longest-first ordering above means the first hit is the best hit
    }
  }
  return s;
}

/** @returns {string} the resolved bridge push URL (Buddy proxy → bridge). */
function bridgePushUrl() {
  return (
    process.env.BRIDGE_PUSH_URL ||
    `${(process.env.BUDDY_URL || '').replace(/\/+$/, '')}/bridge/push`
  );
}

/**
 * Push one of Amanda's notes to Claude via HippoBridge.
 *
 * @param {object} args
 * @param {string}  args.note        Raw note text (wake phrase tolerated; stripped here).
 * @param {string} [args.context]    Where she was — room / zone / context label.
 * @param {'type'|'voice'} [args.mode='type']  How she captured it.
 * @param {string} [args.capturedAt] ISO timestamp; defaults to now.
 * @param {boolean}[args.dryRun=false] Build + return the payload, send NOTHING
 *                                     (used for ~£0 verification and previews).
 * @returns {Promise<{ ok: boolean, ack: string, channel: string, sender: string,
 *                      payload: object, dryRun: boolean, messageId?: string,
 *                      error?: string }>}
 */
export async function pushBertieNote({ note, context, mode = 'type', capturedAt, dryRun = false } = {}) {
  const cleaned = stripWakePhrase(note).slice(0, NOTE_CAP);
  if (!cleaned) {
    return { ok: false, error: 'empty_note', ack: "I didn't catch a note there — try again?", channel: BERTIE_CHANNEL, sender: BERTIE_SENDER, payload: null, dryRun };
  }

  const ctx = context ? String(context).slice(0, 120) : null;
  const captured = capturedAt || new Date().toISOString();
  const safeMode = mode === 'voice' ? 'voice' : 'type';

  // The bridge payload. content is exactly the spec shape, plus a couple of
  // harmless provenance crumbs so Claude knows it came from Bertie in-world.
  const payload = {
    channel: BERTIE_CHANNEL,
    sender: BERTIE_SENDER,
    content: {
      kind: 'amanda.note',
      note: cleaned,
      captured_at: captured,
      context: ctx,        // room / zone / where she was (null if not supplied)
      mode: safeMode,      // 'type' now; 'voice' once Roberta's voice is live
      source: 'bertie',    // the in-world capture companion
      via: 'thecairn-proxy',
    },
    metadata: { operator_blind: true, admin_only: true },
  };

  if (dryRun) {
    return { ok: true, ack: BERTIE_ACK_LINE, channel: BERTIE_CHANNEL, sender: BERTIE_SENDER, payload, dryRun: true };
  }

  // Fetch the bridge token (Buddy primary, env BRIDGE_PUSH_TOKEN fallback).
  let bridgeToken;
  try {
    bridgeToken = await Promise.race([
      getCredential(BRIDGE_PUSH_TOKEN_CRED_NAME, { envFallbackName: 'BRIDGE_PUSH_TOKEN' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('bridge token fetch timeout')), TOKEN_FETCH_TIMEOUT_MS)),
    ]);
  } catch (err) {
    return { ok: false, error: `token_unavailable: ${err instanceof Error ? err.message : String(err)}`, ack: "I couldn't reach the line to Claude just now — your note's not lost, try once more?", channel: BERTIE_CHANNEL, sender: BERTIE_SENDER, payload, dryRun: false };
  }

  const url = bridgePushUrl();
  if (!url || url === '/bridge/push') {
    return { ok: false, error: 'no_bridge_url (set BRIDGE_PUSH_URL or BUDDY_URL)', ack: "I couldn't reach the line to Claude just now — your note's not lost, try once more?", channel: BERTIE_CHANNEL, sender: BERTIE_SENDER, payload, dryRun: false };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), BRIDGE_PUSH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${bridgeToken}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `bridge_push ${res.status}: ${body.slice(0, 200)}`, ack: "I couldn't reach the line to Claude just now — your note's not lost, try once more?", channel: BERTIE_CHANNEL, sender: BERTIE_SENDER, payload, dryRun: false };
    }
    const out = await res.json().catch(() => ({}));
    const messageId = out?.id || out?.result?.id || undefined;
    return { ok: true, ack: BERTIE_ACK_LINE, channel: BERTIE_CHANNEL, sender: BERTIE_SENDER, payload, dryRun: false, messageId };
  } catch (err) {
    return { ok: false, error: `bridge_push threw: ${err instanceof Error ? err.message : String(err)}`, ack: "I couldn't reach the line to Claude just now — your note's not lost, try once more?", channel: BERTIE_CHANNEL, sender: BERTIE_SENDER, payload, dryRun: false };
  } finally {
    clearTimeout(timer);
  }
}
