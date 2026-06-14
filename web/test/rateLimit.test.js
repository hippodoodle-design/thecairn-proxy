/**
 * Release-condition test: per-user rate-limit enforcement.
 * The rate limit is one bar of the rule-based gate and the spend protection that
 * makes "free-AI" abuse self-throttling. We assert: the bucket allows up to its
 * capacity then returns 429 with Retry-After, and that two different keys (two
 * users / IPs) are isolated from each other.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimitPerUser } from '../src/middleware/rateLimit.js';

// Minimal Express req/res doubles. We only need what the middleware touches.
function makeReqRes({ userId, ip }) {
  const headers = {};
  let statusCode = 200;
  let body = null;
  let nextCalled = false;
  const req = { auth: userId ? { userId } : undefined, ip: ip || '203.0.113.1' };
  const res = {
    setHeader: (k, v) => { headers[k] = v; },
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; },
  };
  const next = () => { nextCalled = true; };
  return { req, res, next, get: () => ({ headers, statusCode, body, nextCalled }) };
}

test('allows up to capacity (60) then 429s with Retry-After', () => {
  const userId = 'user-cap-test';
  let allowed = 0;
  let blocked = 0;
  let lastBlocked = null;

  // Fire well past capacity in a tight loop (refill in this window is negligible).
  for (let i = 0; i < 70; i++) {
    const h = makeReqRes({ userId });
    rateLimitPerUser(h.req, h.res, h.next);
    const out = h.get();
    if (out.nextCalled) {
      allowed++;
      assert.equal(out.headers['X-RateLimit-Limit'], '60');
    } else {
      blocked++;
      lastBlocked = out;
    }
  }

  assert.ok(allowed >= 59 && allowed <= 61, `~60 allowed, got ${allowed}`);
  assert.ok(blocked > 0, 'some requests must be blocked once the bucket drains');
  assert.equal(lastBlocked.statusCode, 429);
  assert.ok(lastBlocked.headers['Retry-After'], '429 carries Retry-After');
  assert.equal(lastBlocked.body.ok, false);
});

test('isolation: one user draining their bucket does not throttle another', () => {
  const a = 'user-isolation-A';
  const b = 'user-isolation-B';

  // Drain A completely.
  for (let i = 0; i < 65; i++) {
    const h = makeReqRes({ userId: a });
    rateLimitPerUser(h.req, h.res, h.next);
  }
  // A should now be blocked...
  const hA = makeReqRes({ userId: a });
  rateLimitPerUser(hA.req, hA.res, hA.next);
  assert.equal(hA.get().nextCalled, false, 'A is throttled after draining');

  // ...but B, a different user, is unaffected.
  const hB = makeReqRes({ userId: b });
  rateLimitPerUser(hB.req, hB.res, hB.next);
  assert.equal(hB.get().nextCalled, true, 'B is independent of A');
});

test('unauthenticated callers fall back to a per-IP bucket', () => {
  const h = makeReqRes({ ip: '198.51.100.7' });
  rateLimitPerUser(h.req, h.res, h.next);
  assert.equal(h.get().nextCalled, true, 'first anonymous call passes (keyed by ip)');
});
