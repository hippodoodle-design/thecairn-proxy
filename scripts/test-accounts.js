/**
 * Schema round-trip check for Wave Cairn Customer Accounts + Entitlement
 * Foundation (dispatch ced83e2e). Run from C:\thecairn-proxy with:
 *   node --env-file=.env scripts/test-accounts.js
 *
 * Verifies (read-only, non-destructive) that migration 008 has been applied to
 * the Cairn project (mzjvcntzcfagasxcnuye):
 *   1. All four tables exist + are readable by the service role.
 *   2. paid_rescues is the cross-product lookup the free-month rule reads (it is
 *      expected to be EMPTY until ByteMe/CairnFerry paid flows go live — an
 *      empty table is a pass, not a failure).
 *
 * NOTE: the free-month rule itself (grantFreeMonthIfEligible), RLS enforcement,
 * and the magic-link sign-in UI need a real auth.users row + a user JWT + the
 * frontend — that's the E2E test's job (thecairn-app-site). This script confirms
 * the schema is in place so the backend endpoints + entitlement logic have
 * something to talk to.
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

const TABLES = ['accounts', 'subscriptions', 'entitlements', 'paid_rescues'];

// PostgREST reports a missing table either as Postgres 42P01 ("relation does
// not exist") or, when its schema cache simply has no entry, as PGRST205.
function isMissingTable(error) {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  return /does not exist|schema cache|could not find the table/i.test(error.message || '');
}

for (const table of TABLES) {
  const { error } = await supabase.from(table).select('id').limit(1);
  if (isMissingTable(error)) {
    fail(`table public.${table} does not exist`);
    warn('Migration 008 has not been applied. Apply migrations/20260603_008_cairn_accounts_entitlements.sql');
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

// paid_rescues is expected to be empty until the ByteMe/CairnFerry paid flows go
// live. Confirm it's queryable the way the free-month rule queries it (by
// status='paid'); an empty result is the correct current state.
const { data: rescues, error: rescueErr } = await supabase
  .from('paid_rescues')
  .select('product, status')
  .eq('status', 'paid')
  .limit(1);

if (rescueErr) {
  fail(`paid_rescues not queryable by status: ${rescueErr.message}`);
  allOk = false;
} else if ((rescues ?? []).length === 0) {
  ok('paid_rescues queryable (empty — expected until ByteMe/CairnFerry paid flows go live)');
} else {
  ok(`paid_rescues queryable (${rescues.length}+ paid rescue record(s) present)`);
}

console.log('');
if (allOk) {
  ok('accounts + entitlements schema verified');
  dim('free-month rule + RLS + magic-link sign-in belong to the E2E test (needs a real auth user + JWT + frontend).');
  process.exit(0);
} else {
  fail('accounts schema verification failed');
  process.exit(1);
}
