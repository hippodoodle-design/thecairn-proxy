/**
 * buddy.js — thecairn-proxy's HippoBuddy integration layer.
 *
 * Wave 5c (24 May 2026): Buddy is primary for service credentials; env vars
 * stay as belt-and-braces fallback indefinitely. Cairn must never break
 * because Buddy is unreachable. Credential VALUES never appear in logs,
 * emails, or /healthz responses — only metadata.
 *
 * Magic baked in (standing additions, not deferred):
 *   1) Fallback alert email when Cairn falls back to env (rate-limited 1/h
 *      per credential).
 *   2) First-fetch-success email on the first successful Buddy fetch per
 *      credential per environment (gated by Redis flag, prod only).
 *   3) /healthz credential-sources map (consumed by web/src/routes/health.js).
 *   4) Bearing Method milestone event pushed to session-events:bonnie-bothy-cloud
 *      on the FIRST successful Buddy fetch overall (gated by Redis flag, prod
 *      only, one-time).
 *
 * Trust spine: the credential VALUE returned by Buddy is never logged,
 * emailed, or returned in /healthz. Only its name, source, timing, and
 * (on failure) the error code.
 */

import { BuddyClient, BuddyError } from './buddy-client.js';

// Magic email plumbing
const POSTMARK_TOKEN_CRED_NAME = 'postmark-server-token-thecairn';
const ALERT_RECIPIENT = 'amanda@thecairn.app';
const ALERT_FROM = 'support@thecairn.app';
const ALERT_RATE_LIMIT_MS = 60 * 60 * 1000; // 1 hour per credential

// Buddy fetch timeouts — short caps so a Buddy hang never blocks a request.
const BUDDY_KEY_FETCH_TIMEOUT_MS = 3000;
const POSTMARK_TOKEN_FETCH_TIMEOUT_MS = 2000;

// Magic 4: bridge channel + flag
const MILESTONE_CHANNEL = 'session-events:bonnie-bothy-cloud';
const MILESTONE_REDIS_FLAG = 'milestone_event_pushed:wave-5c';
const BRIDGE_PUSH_TOKEN_CRED_NAME = 'bridge-push-token-thecairn';
const BRIDGE_PUSH_TIMEOUT_MS = 3000;

// Default credential-name registry. Maps a logical credential id to:
//   { credentialName: '<buddy-name>', envFallbackName: '<ENV_VAR>' }
// Convenience wrappers below use this table; callers can also use
// getCredential() directly for ad-hoc names.
const CREDENTIAL_REGISTRY = {
  supabaseServiceRole:   { credentialName: 'supabase-thecairn-service-role',   envFallbackName: 'SUPABASE_SERVICE_ROLE_KEY' },
  openaiApiKey:          { credentialName: 'openai-api-key-thecairn',          envFallbackName: 'OPENAI_API_KEY' },
  elevenLabsApiKey:      { credentialName: 'elevenlabs-api-key-thecairn',      envFallbackName: 'ELEVENLABS_API_KEY' },
  r2AccessKeyId:         { credentialName: 'r2-access-key-id-thecairn',        envFallbackName: 'R2_ACCESS_KEY_ID' },
  r2SecretAccessKey:     { credentialName: 'r2-secret-access-key-thecairn',    envFallbackName: 'R2_SECRET_ACCESS_KEY' },
  cloudflareApiToken:    { credentialName: 'cloudflare-api-token-thecairn',    envFallbackName: 'CLOUDFLARE_API_TOKEN' },
  iwfApiKey:             { credentialName: 'iwf-api-key-thecairn',             envFallbackName: 'IWF_API_KEY' },
  iwfReportingApiKey:    { credentialName: 'iwf-reporting-api-key-thecairn',   envFallbackName: 'IWF_REPORTING_API_KEY' },
};

/** @type {BuddyClient | null} */
let buddyInstance = null;

/** @type {Map<string, number>} alert rate-limit per credentialName (any errorType collapses to same key per spec) */
const alertLastSentAt = new Map();

/**
 * Tracks the source of the LAST successful credential fetch (for /healthz).
 * Keyed by credentialName. Value: { source: 'buddy'|'env', last_fetch_at: ISO string }.
 * @type {Map<string, { source: 'buddy'|'env', last_fetch_at: string }>}
 */
const credentialSources = new Map();

/** In-process memo for Magic 2 (avoid hammering Redis on every fetch). */
const firstFetchEmailedInProcess = new Set();

/** In-process memo for Magic 4 (one-time per process even before Redis confirms). */
let milestoneEventAttemptedInProcess = false;

/** Resolve the current Cairn environment label for Buddy + Magic gating. */
function envName() {
  if (process.env.CAIRN_ENV) return process.env.CAIRN_ENV;
  return process.env.NODE_ENV === 'production' ? 'prod' : 'dev';
}

/** Lazily build (and cache) the BuddyClient instance. */
function getBuddy() {
  if (!process.env.BUDDY_URL || !process.env.BUDDY_BOOTSTRAP_TOKEN) return null;
  if (!buddyInstance) {
    buddyInstance = new BuddyClient({
      url: process.env.BUDDY_URL,
      bootstrapToken: process.env.BUDDY_BOOTSTRAP_TOKEN,
      environment: /** @type {any} */ (envName()),
      cacheTtlMs: 5 * 60 * 1000,
      staleWhileRevalidateMs: 30 * 60 * 1000,
    });
  }
  return buddyInstance;
}

/**
 * Map a Buddy fetch failure into the spec's coarse reason taxonomy
 * (buddy_error / buddy_null / buddy_timeout) used in the alert email body.
 * @param {unknown} err
 * @returns {'buddy_timeout'|'buddy_null'|'buddy_error'}
 */
function classifyReason(err) {
  if (err instanceof Error && /timeout/i.test(err.message)) return 'buddy_timeout';
  if (err instanceof BuddyError) {
    if (err.code === 'not_found') return 'buddy_null';
    if (err.code === 'network') return 'buddy_timeout';
  }
  return 'buddy_error';
}

/**
 * Short error summary for the alert email body. Includes BuddyError code +
 * HTTP status if available, never the credential value.
 * @param {unknown} err
 */
function shortErrorSummary(err) {
  if (err instanceof BuddyError) {
    const parts = [`code=${err.code}`];
    if (err.httpStatus != null) parts.push(`http=${err.httpStatus}`);
    if (err.message) parts.push(err.message.slice(0, 200));
    return parts.join(' ');
  }
  if (err instanceof Error) return err.message.slice(0, 240);
  return String(err).slice(0, 240);
}

/**
 * Lazy-import Redis. Dynamic so buddy.js doesn't statically depend on the
 * queue module (which itself touches REDIS_URL). Returns null if Redis isn't
 * reachable — Magic 2 + Magic 4 then degrade to log-only.
 * @returns {Promise<import('ioredis').default | null>}
 */
async function getRedis() {
  try {
    const { getRedisConnection } = await import('./queue.js');
    return getRedisConnection();
  } catch {
    return null;
  }
}

/**
 * Generic credential fetcher. Buddy primary, env fallback.
 *
 *   const key = await getCredential('openai-api-key-thecairn', { envFallbackName: 'OPENAI_API_KEY' });
 *
 * @param {string} name           Buddy credential name
 * @param {{ envFallbackName?: string, environment?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function getCredential(name, opts = {}) {
  const env = opts.environment ?? envName();
  const envValue = opts.envFallbackName ? process.env[opts.envFallbackName] : undefined;
  const buddy = getBuddy();

  if (!buddy) {
    if (!envValue) {
      throw new Error(`No Buddy configured (BUDDY_URL+BUDDY_BOOTSTRAP_TOKEN) and no env fallback for ${name}`);
    }
    credentialSources.set(name, { source: 'env', last_fetch_at: new Date().toISOString() });
    return envValue;
  }

  try {
    const value = await Promise.race([
      buddy.get(name, { environment: env }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Buddy timeout')), BUDDY_KEY_FETCH_TIMEOUT_MS)),
    ]);
    credentialSources.set(name, { source: 'buddy', last_fetch_at: new Date().toISOString() });
    console.log(`[buddy] credential fetched from Buddy: ${name}`);

    // Magic 2 + Magic 4 are fire-and-forget — never block the credential return.
    void maybeSendFirstFetchSuccess(name, env).catch((e) => {
      console.warn(`[buddy] first-fetch-success email path threw: ${e instanceof Error ? e.message : e}`);
    });
    void maybePushMilestoneEvent(env).catch((e) => {
      console.warn(`[buddy] milestone-event path threw: ${e instanceof Error ? e.message : e}`);
    });

    return /** @type {string} */ (value);
  } catch (err) {
    const reason = classifyReason(err);
    const errorSummary = shortErrorSummary(err);
    console.warn(`[buddy] fetch failed for ${name} (${reason}), falling back to env: ${errorSummary}`);

    if (!envValue) {
      throw new Error(`Buddy failed for ${name} AND no env fallback set${opts.envFallbackName ? ` (${opts.envFallbackName})` : ''}: ${errorSummary}`);
    }

    credentialSources.set(name, { source: 'env', last_fetch_at: new Date().toISOString() });

    void maybeSendFallbackAlert({ credentialName: name, reason, errorSummary }).catch((alertErr) => {
      console.warn(`[buddy] fallback-alert path threw: ${alertErr instanceof Error ? alertErr.message : alertErr}`);
    });

    return envValue;
  }
}

/* ─── Magic 1: env-fallback alert ─────────────────────────────────────── */

/**
 * @param {{ credentialName: string, reason: 'buddy_timeout'|'buddy_null'|'buddy_error', errorSummary: string }} args
 */
async function maybeSendFallbackAlert({ credentialName, reason, errorSummary }) {
  const lastSent = alertLastSentAt.get(credentialName) ?? 0;
  const now = Date.now();
  if (now - lastSent < ALERT_RATE_LIMIT_MS) return;
  alertLastSentAt.set(credentialName, now);

  const postmarkToken = await tryFetchPostmarkToken();
  if (!postmarkToken) return;

  const subject = `⚠️ [Cairn] Env fallback used: ${credentialName}`;
  const textBody = [
    `Credential: ${credentialName}`,
    `Fallback reason: ${reason}`,
    `Environment: ${envName()}`,
    `Timestamp: ${new Date().toISOString()}`,
    '',
    `Error summary: ${errorSummary}`,
    '',
    'If this persists, HippoBuddy may be down, the bootstrap token may be expired,',
    'or the credential may need to be created/updated in HippoBuddy.',
  ].join('\n');

  await sendPostmarkEmail({ token: postmarkToken, subject, textBody, tag: `fallback:${credentialName}` });
}

/* ─── Magic 2: first-fetch-success email ───────────────────────────────── */

/** @param {string} credentialName @param {string} env */
async function maybeSendFirstFetchSuccess(credentialName, env) {
  if (env !== 'prod') return; // prod-only per spec

  const memoKey = `${env}:${credentialName}`;
  if (firstFetchEmailedInProcess.has(memoKey)) return;

  const redisKey = `first_fetch_done:${env}:${credentialName}`;
  const redis = await getRedis();
  if (!redis) {
    // Without Redis we can't guarantee one-time. Mark in-process so the
    // current process doesn't spam; log-only.
    firstFetchEmailedInProcess.add(memoKey);
    console.warn(`[buddy] first-fetch-success email skipped (no Redis): ${credentialName}`);
    return;
  }

  // SET NX → returns 'OK' if set, null if already exists.
  let setResult;
  try {
    setResult = await redis.set(redisKey, '1', 'NX');
  } catch (err) {
    firstFetchEmailedInProcess.add(memoKey);
    console.warn(`[buddy] first-fetch-success Redis SET NX failed: ${err instanceof Error ? err.message : err}`);
    return;
  }

  if (setResult !== 'OK') {
    firstFetchEmailedInProcess.add(memoKey);
    return; // already emailed previously
  }

  firstFetchEmailedInProcess.add(memoKey);

  const postmarkToken = await tryFetchPostmarkToken();
  if (!postmarkToken) {
    console.warn(`[buddy] first-fetch-success postmark token unavailable for ${credentialName}`);
    return;
  }

  const subject = `✅ [Cairn] First Buddy fetch: ${credentialName}`;
  const textBody = [
    `Cairn is now using HippoBuddy for \`${credentialName}\` in \`${env}\`.`,
    'Wave 5b pattern validated in production.',
    '',
    `Timestamp: ${new Date().toISOString()}`,
  ].join('\n');

  await sendPostmarkEmail({ token: postmarkToken, subject, textBody, tag: `first-fetch:${credentialName}` });
}

/* ─── Magic 4: Bearing Method milestone event ─────────────────────────── */

/** @param {string} env */
async function maybePushMilestoneEvent(env) {
  if (env !== 'prod') return; // prod-only per spec
  if (milestoneEventAttemptedInProcess) return;
  milestoneEventAttemptedInProcess = true;

  const redis = await getRedis();
  if (!redis) {
    console.warn('[buddy] milestone event skipped: no Redis');
    return;
  }

  let setResult;
  try {
    setResult = await redis.set(MILESTONE_REDIS_FLAG, '1', 'NX');
  } catch (err) {
    console.warn(`[buddy] milestone event Redis SET NX failed: ${err instanceof Error ? err.message : err}`);
    return;
  }
  if (setResult !== 'OK') return; // already pushed previously

  const buddy = getBuddy();
  let bridgeToken;
  try {
    bridgeToken = await Promise.race([
      /** @type {BuddyClient} */ (buddy).get(BRIDGE_PUSH_TOKEN_CRED_NAME),
      new Promise((_, rej) => setTimeout(() => rej(new Error('bridge token fetch timeout')), POSTMARK_TOKEN_FETCH_TIMEOUT_MS)),
    ]);
  } catch (err) {
    console.warn(`[buddy] milestone event skipped: bridge token fetch failed: ${err instanceof Error ? err.message : err}`);
    return;
  }

  const bridgePushUrl = process.env.BRIDGE_PUSH_URL || `${process.env.BUDDY_URL?.replace(/\/+$/, '')}/bridge/push`;
  const eventId = `wave-5c-cairn-buddy-live-${Math.floor(Date.now() / 1000)}`;
  const payload = {
    channel: MILESTONE_CHANNEL,
    sender: 'thecairn-proxy',
    content: {
      event_id: eventId,
      kind: 'milestone.shipped',
      title: 'Cairn now fetching credentials from HippoBuddy in production',
      summary:
        "Wave 5c shipped. Cairn fetches credentials from HippoBuddy at runtime. " +
        "Env vars are now belt-and-braces fallback only. Bearing Method worked example: " +
        "'static env vars per repo' was a Dead Constraint; 'runtime credential service " +
        "with visible fallback' is the Live answer.",
      bearing_method: {
        dead_constraint: 'static env vars per repo',
        live_answer: 'runtime credential service with belt-and-braces fallback',
      },
    },
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), BRIDGE_PUSH_TIMEOUT_MS);
  try {
    const res = await fetch(bridgePushUrl, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${/** @type {string} */ (bridgeToken)}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[buddy] milestone event push returned ${res.status}: ${body.slice(0, 200)}`);
      return;
    }
    console.log(`[buddy] milestone event pushed: ${eventId}`);
  } catch (err) {
    console.warn(`[buddy] milestone event push threw: ${err instanceof Error ? err.message : err}`);
  } finally {
    clearTimeout(timer);
  }
}

/* ─── Postmark plumbing (shared by Magic 1 + Magic 2) ──────────────────── */

/** Returns Postmark server token from Buddy or null on any failure. */
async function tryFetchPostmarkToken() {
  const buddy = getBuddy();
  if (!buddy) return null;
  try {
    return /** @type {string} */ (
      await Promise.race([
        buddy.get(POSTMARK_TOKEN_CRED_NAME),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Postmark token fetch timeout')), POSTMARK_TOKEN_FETCH_TIMEOUT_MS)),
      ])
    );
  } catch (err) {
    console.warn(`[buddy] postmark token fetch failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * @param {{ token: string, subject: string, textBody: string, tag: string }} args
 */
async function sendPostmarkEmail({ token, subject, textBody, tag }) {
  try {
    const res = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Postmark-Server-Token': token,
      },
      body: JSON.stringify({
        From: ALERT_FROM,
        To: ALERT_RECIPIENT,
        Subject: subject,
        TextBody: textBody,
        MessageStream: 'outbound',
        Tag: tag,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[buddy] postmark send failed (${tag}): ${res.status} ${body.slice(0, 200)}`);
      return;
    }
    console.log(`[buddy] postmark email sent (${tag})`);
  } catch (err) {
    console.warn(`[buddy] postmark send threw (${tag}): ${err instanceof Error ? err.message : err}`);
  }
}

/* ─── Convenience wrappers (one per registered credential) ─────────────── */

/** @returns {Promise<string>} */
export function getSupabaseServiceRoleKey() {
  return getCredential(
    CREDENTIAL_REGISTRY.supabaseServiceRole.credentialName,
    { envFallbackName: CREDENTIAL_REGISTRY.supabaseServiceRole.envFallbackName },
  );
}

/** @returns {Promise<string>} */
export function getOpenAIApiKey() {
  return getCredential(
    CREDENTIAL_REGISTRY.openaiApiKey.credentialName,
    { envFallbackName: CREDENTIAL_REGISTRY.openaiApiKey.envFallbackName },
  );
}

/**
 * ElevenLabs API key — Roberta's server-side voice-out (TTS). Buddy primary,
 * ELEVENLABS_API_KEY env fallback. Added for the speak-to-Roberta brain
 * endpoint (board-program item 7). The key NEVER ships to the client — voice
 * is synthesized here, in the proxy, and returned as audio.
 * @returns {Promise<string>}
 */
export function getElevenLabsApiKey() {
  return getCredential(
    CREDENTIAL_REGISTRY.elevenLabsApiKey.credentialName,
    { envFallbackName: CREDENTIAL_REGISTRY.elevenLabsApiKey.envFallbackName },
  );
}

/** @returns {Promise<string>} */
export function getR2AccessKeyId() {
  return getCredential(
    CREDENTIAL_REGISTRY.r2AccessKeyId.credentialName,
    { envFallbackName: CREDENTIAL_REGISTRY.r2AccessKeyId.envFallbackName },
  );
}

/** @returns {Promise<string>} */
export function getR2SecretAccessKey() {
  return getCredential(
    CREDENTIAL_REGISTRY.r2SecretAccessKey.credentialName,
    { envFallbackName: CREDENTIAL_REGISTRY.r2SecretAccessKey.envFallbackName },
  );
}

/** @returns {Promise<string>} */
export function getCloudflareApiToken() {
  return getCredential(
    CREDENTIAL_REGISTRY.cloudflareApiToken.credentialName,
    { envFallbackName: CREDENTIAL_REGISTRY.cloudflareApiToken.envFallbackName },
  );
}

/** @returns {Promise<string>} */
export function getIwfApiKey() {
  return getCredential(
    CREDENTIAL_REGISTRY.iwfApiKey.credentialName,
    { envFallbackName: CREDENTIAL_REGISTRY.iwfApiKey.envFallbackName },
  );
}

/** @returns {Promise<string>} */
export function getIwfReportingApiKey() {
  return getCredential(
    CREDENTIAL_REGISTRY.iwfReportingApiKey.credentialName,
    { envFallbackName: CREDENTIAL_REGISTRY.iwfReportingApiKey.envFallbackName },
  );
}

/* ─── /healthz support ─────────────────────────────────────────────────── */

/**
 * Returns the current credential-source map for /healthz. Snapshot only;
 * never includes credential values. Entries appear once a credential has
 * been fetched at least once in this process — credentials that haven't
 * been touched yet do not appear (so a worker-only credential won't show
 * up in web's /healthz until it's been used, which is the honest signal).
 *
 * @returns {Record<string, { source: 'buddy'|'env', last_fetch_at: string }>}
 */
export function getCredentialSources() {
  /** @type {Record<string, { source: 'buddy'|'env', last_fetch_at: string }>} */
  const out = {};
  for (const [name, entry] of credentialSources) {
    out[name] = { source: entry.source, last_fetch_at: entry.last_fetch_at };
  }
  return out;
}

/* ─── Test-only ─────────────────────────────────────────────────────────── */

/**
 * Clears caches and resets module state. Lets smoke tests cleanly re-
 * exercise helpers without restarting the process.
 */
export function _resetForTests() {
  buddyInstance = null;
  alertLastSentAt.clear();
  credentialSources.clear();
  firstFetchEmailedInProcess.clear();
  milestoneEventAttemptedInProcess = false;
}
