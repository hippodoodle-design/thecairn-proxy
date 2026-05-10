/**
 * One-shot connectivity check for local dev.
 * Run from C:\thecairn-proxy with:
 *   node --env-file=.env scripts/connectivity-check.js
 *
 * Verifies:
 *   1. SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY can talk to the project
 *      (read-only: SELECT id FROM stones LIMIT 1 via PostgREST).
 *   2. REDIS_URL responds to PING.
 *
 * Exits 0 on full success, 1 if either check fails.
 */

import { createClient } from '@supabase/supabase-js';
import IORedis from 'ioredis';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';

function ok(msg)   { console.log(`${GREEN}✓${RESET} ${msg}`); }
function fail(msg) { console.log(`${RED}✗${RESET} ${msg}`); }
function dim(msg)  { console.log(`${DIM}  ${msg}${RESET}`); }

let allOk = true;

// ---- 1. Supabase ----
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  fail(`Supabase env vars missing (SUPABASE_URL=${url ? 'set' : 'MISSING'}, SUPABASE_SERVICE_ROLE_KEY=${key ? 'set' : 'MISSING'})`);
  allOk = false;
} else {
  try {
    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const start = Date.now();
    const { error } = await supabase.from('stones').select('id').limit(1);
    const ms = Date.now() - start;
    if (error) {
      fail(`Supabase reachable but query errored: ${error.message}`);
      dim(`code=${error.code ?? '-'} hint=${error.hint ?? '-'}`);
      allOk = false;
    } else {
      ok(`Supabase OK — SELECT id FROM stones LIMIT 1 returned in ${ms}ms`);
      dim(`url=${url}`);
    }
  } catch (err) {
    fail(`Supabase threw: ${err.message}`);
    allOk = false;
  }
}

// ---- 2. Redis ----
const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  fail('REDIS_URL is missing');
  allOk = false;
} else {
  const conn = new IORedis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    connectTimeout: 3000,
    retryStrategy: () => null, // fail fast
    lazyConnect: false,
  });

  let redisDone = false;

  // Hard timeout so a missing Redis doesn't hang the check.
  const timeout = setTimeout(() => {
    if (!redisDone) {
      redisDone = true;
      fail('Redis PING timed out after 4s — is `npm run dev:redis` running?');
      dim(`url=${redisUrl}`);
      allOk = false;
      try { conn.disconnect(); } catch {}
    }
  }, 4000);

  try {
    const start = Date.now();
    const pong = await conn.ping();
    const ms = Date.now() - start;
    redisDone = true;
    clearTimeout(timeout);
    if (pong === 'PONG') {
      ok(`Redis OK — PING → PONG in ${ms}ms`);
      dim(`url=${redisUrl}`);
    } else {
      fail(`Redis PING returned unexpected: ${pong}`);
      allOk = false;
    }
  } catch (err) {
    if (!redisDone) {
      redisDone = true;
      clearTimeout(timeout);
      fail(`Redis PING failed: ${err.message}`);
      dim(`url=${redisUrl}`);
      allOk = false;
    }
  } finally {
    try { await conn.quit(); } catch {}
  }
}

console.log('');
console.log(allOk ? `${GREEN}All connectivity checks passed.${RESET}` : `${RED}One or more checks failed.${RESET}`);
process.exit(allOk ? 0 : 1);
