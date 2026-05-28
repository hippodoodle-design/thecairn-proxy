/**
 * Schema round-trip check for Wave Cairn Companions Foundation.
 * Run from C:\thecairn-proxy with:
 *   node --env-file=.env scripts/test-companions.js
 *
 * Verifies (read-only, non-destructive) that migration 006 has been applied to
 * the Cairn project (mzjvcntzcfagasxcnuye):
 *   1. All four tables exist + are readable by the service role.
 *   2. The companions registry holds the 8 seeded starter species (status=live).
 *
 * NOTE: a full write round-trip (pick → name → dimension swap → return-to-zoo)
 * and RLS enforcement require a real auth.users row + a user JWT — that's the
 * E2E test's job (frontend, thecairn-app). This script confirms the schema is
 * in place so the backend endpoints have something to talk to.
 *
 * Exits 0 on success, 1 on any failure (incl. "migration not yet applied").
 */

import { createClient } from '@supabase/supabase-js';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';

const ok = (m) => console.log(`${GREEN}✓${RESET} ${m}`);
const fail = (m) => console.log(`${RED}✗${RESET} ${m}`);
const dim = (m) => console.log(`${DIM}  ${m}${RESET}`);
const warn = (m) => console.log(`${YELLOW}!${RESET} ${m}`);

const EXPECTED_SLUGS = [
  'bluey-blue-whale', 'brontle-dinosaur', 'rolo-panda', 'stick-insect',
  'snail', 'axolotl', 'red-panda', 'garden-frog',
];

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  fail(`Supabase env vars missing (SUPABASE_URL=${url ? 'set' : 'MISSING'}, SUPABASE_SERVICE_ROLE_KEY=${key ? 'set' : 'MISSING'})`);
  process.exit(1);
}
if (!url.includes('mzjvcntzcfagasxcnuye')) {
  fail(`SUPABASE_URL is not the Cairn project (expected mzjvcntzcfagasxcnuye): ${url}`);
  process.exit(1);
}
ok(`Connected to Cairn project (mzjvcntzcfagasxcnuye)`);

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

let allOk = true;

const TABLES = ['companions', 'user_companions', 'companion_events', 'species_requests'];

// PostgREST reports a missing table either as Postgres 42P01 ("relation does
// not exist") or, when its schema cache simply has no entry, as PGRST205
// ("Could not find the table ... in the schema cache").
function isMissingTable(error) {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  return /does not exist|schema cache|could not find the table/i.test(error.message || '');
}

for (const table of TABLES) {
  const { error } = await supabase.from(table).select('id').limit(1);
  if (isMissingTable(error)) {
    fail(`table public.${table} does not exist`);
    warn('Migration 006 has not been applied. Apply migrations/20260528_006_companions_zoo_schema.sql');
    warn('(CLAUDE.md forbids the Supabase MCP for this project — use the CLI with --db-url or the SQL editor.)');
    process.exit(1);
  }
  if (error) {
    fail(`table public.${table} not readable: ${error.message}`);
    allOk = false;
  } else {
    ok(`table public.${table} exists + readable`);
  }
}

// Seed check.
const { data: seeds, error: seedErr } = await supabase
  .from('companions')
  .select('slug')
  .eq('status', 'live');

if (seedErr) {
  fail(`could not read companions registry: ${seedErr.message}`);
  allOk = false;
} else {
  const got = new Set((seeds ?? []).map((r) => r.slug));
  const missing = EXPECTED_SLUGS.filter((s) => !got.has(s));
  if (got.size >= 8 && missing.length === 0) {
    ok(`companions registry seeded (${got.size} live species, all 8 starters present)`);
  } else {
    fail(`companions registry incomplete: ${got.size} live species; missing: ${missing.join(', ') || 'none'}`);
    allOk = false;
  }
}

console.log('');
if (allOk) {
  ok('companions schema verified');
  dim('write round-trip + RLS belong to the E2E test (needs a real auth user + JWT).');
  process.exit(0);
} else {
  fail('companions schema verification failed');
  process.exit(1);
}
