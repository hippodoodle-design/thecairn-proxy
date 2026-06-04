/**
 * Standalone test for the Cairn phone-importer backend (no DB/R2 required).
 *
 * Usage:
 *   node scripts/test-cairn-import.js
 *
 * Covers the parts that are verifiable offline:
 *   1. Safety matcher FAILS CLOSED while the IWF hash-list licence is
 *      unprovisioned: matchHashes() -> { allow:[], blocked:all, available:false }
 *      and isHashMatchConfigured() === false. This is the hard guarantee the
 *      dispatch (e1c0d2a7) requires — the importer must never fail-open.
 *   2. The three endpoints are wired under /api/import and sit behind requireAuth
 *      (an unauthenticated request gets 401, NOT 404), so the routing + auth
 *      chain is correct. A bogus path still 404s.
 *
 * Live ingest (R2 store + folder_items insert + stack link) needs a real JWT +
 * the live DB and is intentionally out of scope here — those paths are exercised
 * once the IWF licence lands and the safety matcher reports available=true.
 */

import { spawn } from 'node:child_process';
import { matchHashes, isHashMatchConfigured } from '../shared/src/cairn-import/safety.js';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

let exitCode = 0;
function ok(msg) { console.log(`${GREEN}✓${RESET} ${msg}`); }
function fail(msg) { console.error(`${RED}✗${RESET} ${msg}`); exitCode = 1; }

// ─── 1. Safety matcher fails closed (offline, no env) ──────────────────
console.log(`${BOLD}Step 1 — safety matcher fails CLOSED when unprovisioned${RESET}`);

if (isHashMatchConfigured() !== false) {
  fail(`isHashMatchConfigured() should be false in a clean env, got ${isHashMatchConfigured()}`);
} else {
  ok('isHashMatchConfigured() === false');
}

const hashes = ['aaa111', 'bbb222', 'aaa111', 'ccc333']; // includes a dupe
const result = await matchHashes(hashes);
if (result.available !== false) {
  fail(`expected available=false, got ${result.available}`);
} else {
  ok('matchHashes available=false');
}
if (result.allow.length !== 0) {
  fail(`expected allow=[] (fail-closed), got ${JSON.stringify(result.allow)}`);
} else {
  ok('allow is empty (nothing allowed while unprovisioned)');
}
const expectedBlocked = [...new Set(hashes)];
if (result.blocked.length !== expectedBlocked.length || !expectedBlocked.every((h) => result.blocked.includes(h))) {
  fail(`expected all unique hashes blocked, got ${JSON.stringify(result.blocked)}`);
} else {
  ok('every (deduped) hash is blocked');
}
console.log('');

// ─── 2. Routes wired behind auth ───────────────────────────────────────
console.log(`${BOLD}Step 2 — endpoints wired under /api/import behind requireAuth${RESET}`);

const PORT = 38217;
const server = spawn(process.execPath, ['web/src/server.js'], {
  // REDIS_URL: the digest route builds a BullMQ queue at import (ioredis
  // connects lazily, so a dummy URL lets the server listen without Redis).
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d.toString(); });

async function waitForReady(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // Any HTTP response (here a 404 from the fallthrough handler) means the
      // server is listening. Avoid /healthz — it runs heavy connectivity checks.
      const r = await fetch(`http://127.0.0.1:${PORT}/api/import/__ready_probe`);
      if (r.status) return true;
    } catch {
      // not up yet
    }
    await new Promise((res) => setTimeout(res, 150));
  }
  return false;
}

try {
  const ready = await waitForReady();
  if (!ready) {
    fail('server did not become ready');
    if (serverErr) console.error(`${DIM}${serverErr.slice(0, 800)}${RESET}`);
  } else {
    ok('server booted');

    // No Authorization header -> requireAuth must reject with 401 (proves the
    // route exists AND auth runs). A 404 would mean the route is not wired.
    const cases = [
      { method: 'POST', path: '/api/import/safety-match', body: JSON.stringify({ hashes: ['x'] }), ct: 'application/json' },
      { method: 'POST', path: '/api/import/stack', body: JSON.stringify({ name: 'Test' }), ct: 'application/json' },
      // item is multipart; send no body — auth still runs first, so 401.
      { method: 'POST', path: '/api/import/item', body: undefined, ct: undefined },
    ];
    for (const c of cases) {
      const r = await fetch(`http://127.0.0.1:${PORT}${c.path}`, {
        method: c.method,
        headers: c.ct ? { 'content-type': c.ct } : {},
        body: c.body,
      });
      if (r.status === 401) {
        ok(`${c.path} -> 401 (wired, auth-gated)`);
      } else if (r.status === 404) {
        fail(`${c.path} -> 404 (route NOT wired)`);
      } else {
        fail(`${c.path} -> ${r.status} (expected 401)`);
      }
    }

    // Sanity: a bogus path still 404s.
    const bogus = await fetch(`http://127.0.0.1:${PORT}/api/import/nope`);
    if (bogus.status === 404) {
      ok('/api/import/nope -> 404 (404 handler intact)');
    } else {
      fail(`/api/import/nope -> ${bogus.status} (expected 404)`);
    }
  }
} catch (err) {
  fail(`${err?.name || 'Error'}: ${err?.message || err}`);
} finally {
  server.kill('SIGTERM');
}

console.log('');
console.log(exitCode === 0 ? `${GREEN}${BOLD}ALL PASS${RESET}` : `${RED}${BOLD}FAILURES${RESET}`);
process.exit(exitCode);
