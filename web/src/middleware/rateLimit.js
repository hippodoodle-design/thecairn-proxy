/**
 * In-memory token bucket per userId. 60 requests per rolling minute.
 *
 * NOTE — scaling beyond a single web instance requires moving this to Redis
 * (e.g. rate-limiter-flexible with RedisStore). The interface of this middleware
 * is intentionally stable so the swap is a one-file change later.
 */

import { createLogger } from '@cairn/shared/logger';

const log = createLogger('thecairn-web');

const CAPACITY = 60;         // tokens in the bucket
const REFILL_PER_MS = 60 / 60000; // 60 tokens refilled per 60_000ms -> 1 per 1000ms

const buckets = new Map();

// Periodic cleanup so a burst of unique users can't grow the map forever.
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const IDLE_TTL_MS = 15 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastSeen > IDLE_TTL_MS) buckets.delete(key);
  }
}, CLEANUP_INTERVAL_MS).unref?.();

function take(key) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: CAPACITY, updatedAt: now, lastSeen: now };
    buckets.set(key, bucket);
  }

  const elapsed = now - bucket.updatedAt;
  bucket.tokens = Math.min(CAPACITY, bucket.tokens + elapsed * REFILL_PER_MS);
  bucket.updatedAt = now;
  bucket.lastSeen = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { ok: true, remaining: Math.floor(bucket.tokens) };
  }

  const msUntilNext = Math.ceil((1 - bucket.tokens) / REFILL_PER_MS);
  return { ok: false, retryAfterMs: msUntilNext };
}

/**
 * Requires requireAuth to have run first so req.auth.userId is set.
 * Falls back to IP if auth is missing (defensive — routes should chain auth first).
 */
export function rateLimitPerUser(req, res, next) {
  const key = req.auth?.userId || `ip:${req.ip}`;
  const result = take(key);

  res.setHeader('X-RateLimit-Limit', String(CAPACITY));
  if (result.ok) {
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    return next();
  }

  const ownerIdTail = req.auth?.userId ? req.auth.userId.slice(-4) : 'ip-only';
  log.warn({ event: 'rate_limited', ownerIdTail });

  res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
  return res.status(429).json({
    ok: false,
    error: 'Rate limit exceeded. Please slow down and try again shortly.',
  });
}
