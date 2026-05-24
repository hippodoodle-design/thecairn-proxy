/**
 * buddy.js — thecairn-proxy's Buddy integration layer.
 *
 * Wave 5c (24 May 2026): Buddy is primary for service-role credential
 * fetching; SUPABASE_SERVICE_ROLE_KEY env var stays as belt-and-braces
 * fallback. Cairn must never break because Buddy is unreachable.
 *
 * Magic: when we fall back to env, fire-and-forget a Postmark email so
 * silent failures become loud failures. Rate limited to 1/hour per
 * service+error-type. The alert path itself fetches its Postmark token
 * from Buddy too — if THAT fails we log to console only (don't compound
 * the original problem).
 */

import { BuddyClient, BuddyError } from './buddy-client.js';

const SUPABASE_SERVICE_ROLE_CRED_NAME = 'supabase-thecairn-service-role';
const POSTMARK_TOKEN_CRED_NAME = 'postmark-server-token-thecairn';
const ALERT_RECIPIENT = 'amandamason.am85@gmail.com';
const ALERT_FROM = 'alerts@thecairn.app';
const ALERT_RATE_LIMIT_MS = 60 * 60 * 1000; // 1 hour
const POSTMARK_TOKEN_FETCH_TIMEOUT_MS = 2000;
const BUDDY_KEY_FETCH_TIMEOUT_MS = 3000;

/** @type {BuddyClient | null} */
let buddyInstance = null;

/** @type {Map<string, number>} */
const alertLastSentAt = new Map();

/**
 * Lazily build (and cache) the BuddyClient instance.
 * @returns {BuddyClient | null} null if Buddy isn't configured
 */
function getBuddy() {
  if (!process.env.BUDDY_URL || !process.env.BUDDY_BOOTSTRAP_TOKEN) return null;
  if (!buddyInstance) {
    buddyInstance = new BuddyClient({
      url: process.env.BUDDY_URL,
      bootstrapToken: process.env.BUDDY_BOOTSTRAP_TOKEN,
      cacheTtlMs: 5 * 60 * 1000,
      staleWhileRevalidateMs: 30 * 60 * 1000,
    });
  }
  return buddyInstance;
}

/**
 * Classify a Buddy fetch failure for the alert email.
 * @param {unknown} err
 * @returns {'UNREACHABLE'|'401'|'403'|'TIMEOUT'|'OTHER'}
 */
function classifyError(err) {
  if (err instanceof Error && /timeout/i.test(err.message)) return 'TIMEOUT';
  if (err instanceof BuddyError) {
    if (err.code === 'unauthorized') return '401';
    if (err.code === 'denied_scope') return '403';
    if (err.code === 'network') return 'UNREACHABLE';
  }
  return 'OTHER';
}

/**
 * Fetch the Supabase service-role key. Buddy is primary; env var is
 * fallback. On fallback, fires off a rate-limited Postmark alert email
 * (never blocks the return).
 * @returns {Promise<string>}
 */
export async function getSupabaseServiceRoleKey() {
  const envKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const buddy = getBuddy();

  if (!buddy) {
    if (!envKey) {
      throw new Error('Neither Buddy (BUDDY_URL+BUDDY_BOOTSTRAP_TOKEN) nor SUPABASE_SERVICE_ROLE_KEY is configured');
    }
    return envKey;
  }

  try {
    const key = await Promise.race([
      buddy.get(SUPABASE_SERVICE_ROLE_CRED_NAME),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Buddy timeout')), BUDDY_KEY_FETCH_TIMEOUT_MS)),
    ]);
    console.log('[buddy] supabase service_role key fetched from Buddy');
    return /** @type {string} */ (key);
  } catch (err) {
    const errorType = classifyError(err);
    const code = err instanceof BuddyError ? err.code : 'unknown';
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[buddy] fetch failed (${code}), falling back to env: ${message}`);

    if (!envKey) {
      throw new Error('Buddy failed AND no SUPABASE_SERVICE_ROLE_KEY env fallback');
    }

    // Fire-and-forget alert — never block the key return on it.
    void maybeSendFallbackAlert({
      service: SUPABASE_SERVICE_ROLE_CRED_NAME,
      errorType,
      envVarName: 'SUPABASE_SERVICE_ROLE_KEY',
    }).catch((alertErr) => {
      console.error('[buddy] fallback-alert path threw:', alertErr instanceof Error ? alertErr.message : alertErr);
    });

    return envKey;
  }
}

/**
 * Rate-limited alert dispatcher. Skips if we've sent one for this
 * (service, errorType) pair within the last hour.
 * @param {{ service: string, errorType: 'UNREACHABLE'|'401'|'403'|'TIMEOUT'|'OTHER', envVarName: string }} args
 */
async function maybeSendFallbackAlert({ service, errorType, envVarName }) {
  const rateKey = `${service}:${errorType}`;
  const lastSent = alertLastSentAt.get(rateKey) ?? 0;
  const now = Date.now();
  if (now - lastSent < ALERT_RATE_LIMIT_MS) {
    return; // rate-limited
  }
  alertLastSentAt.set(rateKey, now);

  // Try to fetch Postmark token from Buddy (with short timeout). If that
  // also fails — Buddy is the primary failure mode here — log and skip.
  const buddy = getBuddy();
  if (!buddy) {
    console.warn('[buddy] alert skipped: no Buddy client');
    return;
  }

  /** @type {string} */
  let postmarkToken;
  try {
    postmarkToken = await Promise.race([
      buddy.get(POSTMARK_TOKEN_CRED_NAME),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Postmark token fetch timeout')), POSTMARK_TOKEN_FETCH_TIMEOUT_MS)),
    ]);
  } catch (err) {
    console.warn(`[buddy] alert skipped: postmark token fetch failed: ${err instanceof Error ? err.message : err}`);
    return;
  }

  const timestamp = new Date().toISOString();
  const subject = `⚠️ [Cairn] Buddy fallback active — ${service}`;
  const textBody = [
    `Timestamp: ${timestamp}`,
    `Service: ${service}`,
    `Error type: ${errorType}`,
    `Fallback env var: ${envVarName}`,
    '',
    'If this persists, Buddy may be down or the bootstrap token may be expired.',
    'Manual investigation recommended.',
  ].join('\n');

  try {
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Postmark-Server-Token': postmarkToken,
      },
      body: JSON.stringify({
        From: ALERT_FROM,
        To: ALERT_RECIPIENT,
        Subject: subject,
        TextBody: textBody,
        MessageStream: 'outbound',
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[buddy] alert send failed: postmark returned ${res.status} ${body.slice(0, 200)}`);
      return;
    }
    console.log(`[buddy] fallback alert sent (service=${service} errorType=${errorType})`);
  } catch (err) {
    console.warn(`[buddy] alert send threw: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Test-only: clear caches and reset client. Lets smoke tests cleanly
 * re-exercise the helper without restarting the process.
 */
export function _resetForTests() {
  buddyInstance = null;
  alertLastSentAt.clear();
}
