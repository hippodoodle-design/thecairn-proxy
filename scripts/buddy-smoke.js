/**
 * Wave 5c smoke tests for the Buddy-aware Supabase key helper.
 *
 *   node scripts/buddy-smoke.js
 *
 * Reads:
 *   SUPABASE_URL                — required (any-real Cairn URL)
 *   SUPABASE_SERVICE_ROLE_KEY   — required (the fallback)
 *   BUDDY_URL                   — required (https://hippobridge.hippoflow.workers.dev)
 *   BUDDY_BOOTSTRAP_TOKEN       — required (the freshly-minted bearer)
 *
 * Exercises all 4 spec scenarios in one process, resetting helper state
 * (cache + alert dedupe) between them via the helper's _resetForTests.
 *
 * Asserts directly — process exits 1 on any failure.
 */

import { getSupabaseServiceRoleKey, _resetForTests } from '../shared/src/buddy.js';

const RESET = '\x1b[0m', G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m';
const ok = (m) => console.log(`${G}✓${RESET} ${m}`);
const bad = (m) => console.log(`${R}✗${RESET} ${m}`);
const head = (m) => console.log(`\n${C}== ${m} ==${RESET}`);

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'BUDDY_URL', 'BUDDY_BOOTSTRAP_TOKEN'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  bad(`missing required env: ${missing.join(', ')}`);
  process.exit(1);
}

const ENV_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOD_BUDDY_URL = process.env.BUDDY_URL;
const GOOD_BUDDY_TOKEN = process.env.BUDDY_BOOTSTRAP_TOKEN;

/** capture console.log/warn output so we can assert on it. */
function captureConsole(fn) {
  const lines = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args) => lines.push(['log', args.map(String).join(' ')]);
  console.warn = (...args) => lines.push(['warn', args.map(String).join(' ')]);
  return fn().then(
    (res) => { console.log = origLog; console.warn = origWarn; return { res, lines }; },
    (err) => { console.log = origLog; console.warn = origWarn; throw Object.assign(err, { lines }); }
  );
}

let failures = 0;

// ---- Test 1: Buddy configured + reachable → fetched from Buddy ----
head('Test 1: Buddy primary path');
process.env.BUDDY_URL = GOOD_BUDDY_URL;
process.env.BUDDY_BOOTSTRAP_TOKEN = GOOD_BUDDY_TOKEN;
_resetForTests();
try {
  const { res, lines } = await captureConsole(getSupabaseServiceRoleKey);
  if (res === ENV_KEY) {
    bad(`returned env key, expected Buddy-fetched key`);
    failures += 1;
  } else if (typeof res === 'string' && res.length > 20) {
    ok(`returned a non-env key (length=${res.length}, head=${res.slice(0, 8)}...)`);
  } else {
    bad(`returned unexpected value: ${typeof res} ${String(res).slice(0, 50)}`);
    failures += 1;
  }
  const sawBuddyLog = lines.some(([, l]) => /\[buddy\] credential fetched from Buddy: supabase-thecairn-service-role/.test(l));
  if (sawBuddyLog) ok(`log emitted: "[buddy] credential fetched from Buddy: supabase-thecairn-service-role"`);
  else { bad('missing expected log line'); failures += 1; }
} catch (e) {
  bad(`threw: ${e instanceof Error ? e.message : e}`);
  failures += 1;
}

// ---- Test 2: Buddy unconfigured → env fallback ----
head('Test 2: env-only fallback (no BUDDY_URL)');
delete process.env.BUDDY_URL;
process.env.BUDDY_BOOTSTRAP_TOKEN = GOOD_BUDDY_TOKEN;
_resetForTests();
try {
  const { res, lines } = await captureConsole(getSupabaseServiceRoleKey);
  if (res === ENV_KEY) ok(`returned env key (legacy path), no Buddy attempt made`);
  else { bad(`expected env key, got something else (length=${String(res).length})`); failures += 1; }
  const sawBuddyLog = lines.some(([, l]) => /\[buddy\] supabase service_role key fetched/.test(l));
  if (sawBuddyLog) { bad(`unexpected Buddy log when Buddy unconfigured`); failures += 1; }
} catch (e) {
  bad(`threw: ${e instanceof Error ? e.message : e}`);
  failures += 1;
}

// ---- Test 3: Invalid bearer → 401 → fallback to env ----
head('Test 3: invalid bearer → 401 → graceful env fallback');
process.env.BUDDY_URL = GOOD_BUDDY_URL;
process.env.BUDDY_BOOTSTRAP_TOKEN = 'hbk_invalid_token_for_smoke_test_0000000000000000000000000000000000000000';
_resetForTests();
try {
  const { res, lines } = await captureConsole(getSupabaseServiceRoleKey);
  if (res === ENV_KEY) ok(`fell back to env after invalid-bearer rejection`);
  else { bad(`expected env fallback, got something else`); failures += 1; }
  const sawFallback = lines.some(([k, l]) => k === 'warn' && /\[buddy\] fetch failed/.test(l) && /unauthorized|401/i.test(l));
  if (sawFallback) ok(`warn log indicates unauthorized + fallback`);
  else { bad(`missing fetch-failed warn log`); console.log(lines); failures += 1; }
} catch (e) {
  bad(`threw: ${e instanceof Error ? e.message : e}`);
  failures += 1;
}

// ---- Test 4: Buddy unreachable host → network error → fallback ----
head('Test 4: Buddy unreachable → network error → graceful env fallback');
process.env.BUDDY_URL = 'http://127.0.0.1:1'; // closed port → connection refused
process.env.BUDDY_BOOTSTRAP_TOKEN = GOOD_BUDDY_TOKEN;
_resetForTests();
try {
  const t0 = Date.now();
  const { res, lines } = await captureConsole(getSupabaseServiceRoleKey);
  const dt = Date.now() - t0;
  if (res === ENV_KEY) ok(`fell back to env after unreachable Buddy (dt=${dt}ms)`);
  else { bad(`expected env fallback, got something else`); failures += 1; }
  const sawFallback = lines.some(([k, l]) => k === 'warn' && /\[buddy\] fetch failed/.test(l));
  if (sawFallback) ok(`warn log indicates fallback`);
  else { bad(`missing fetch-failed warn log`); console.log(lines); failures += 1; }
  if (dt < 5000) ok(`returned within 5s (dt=${dt}ms) — timeout/retry caps respected`);
  else { bad(`took ${dt}ms — too slow`); failures += 1; }
} catch (e) {
  bad(`threw: ${e instanceof Error ? e.message : e}`);
  failures += 1;
}

// restore
process.env.BUDDY_URL = GOOD_BUDDY_URL;
process.env.BUDDY_BOOTSTRAP_TOKEN = GOOD_BUDDY_TOKEN;

console.log('');
if (failures === 0) {
  console.log(`${G}All smoke tests passed.${RESET}`);
  process.exit(0);
} else {
  console.log(`${R}${failures} smoke test assertion(s) failed.${RESET}`);
  process.exit(1);
}
