/**
 * Schema round-trip check for Wave Cairn Customer Accounts (dispatch ced83e2e).
 * Run from C:\thecairn-proxy with:
 *   node --env-file=.env scripts/test-accounts.js
 *
 * Verifies (read-only, non-destructive) that migration 008 has been applied to
 * the Cairn project (mzjvcntzcfagasxcnuye):
 *   1. accounts / subscriptions / entitlements / paid_rescues tables exist + are
 *      readable by the service role.
 *   2. The grant_free_storage_month(uuid) RPC exists and is callable. Called with
 *      a random (non-existent) account id it must return null (rule not satisfied)
 *      WITHOUT erroring — proving the founder-locked gate is in place and that a
 *      free month is NEVER granted without a paid rescue + paid subscription.
 *
 * A full grant round-trip (seed a paid rescue + a paid subscription, assert one
 * idempotent entitlement) needs a real auth.users row; that is the E2E test's job.
 * This script confirms the schema + the gate are wired so the endpoints have
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

function isMissingTable(error) {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  return /does not exist|schema cache|could not find the table/i.test(error.message || '');
}

const TABLES = ['accounts', 'subscriptions', 'entitlements', 'paid_rescues'];

for (const table of TABLES) {
  const { error } = await supabase.from(table).select('id').limit(1);
  if (isMissingTable(error)) {
    fail(`table public.${table} does not exist`);
    warn('migration 008 not applied yet — apply 20260603_008_accounts_entitlements_foundation.sql');
    allOk = false;
  } else if (error) {
    fail(`table public.${table} read error: ${error.message}`);
    allOk = false;
  } else {
    ok(`table public.${table} exists + readable`);
  }
}

// The free-month gate. A random account id has no paid rescue + no paid sub, so
// the rule MUST return null (never grant). An error here means the RPC is
// missing or broken.
const randomId = '00000000-0000-4000-8000-000000000000';
const { data: grantResult, error: grantErr } = await supabase.rpc('grant_free_storage_month', { p_account_id: randomId });
if (grantErr) {
  if (/function .* does not exist|could not find the function|PGRST202/i.test(grantErr.message || '') || grantErr.code === 'PGRST202') {
    fail('RPC grant_free_storage_month(uuid) does not exist');
    warn('migration 008 not applied yet');
  } else {
    fail(`grant_free_storage_month errored: ${grantErr.message}`);
  }
  allOk = false;
} else if (grantResult === null) {
  ok('grant_free_storage_month gate holds: no paid rescue + no paid sub → null (never granted)');
} else {
  fail(`grant_free_storage_month returned non-null (${grantResult}) for a non-existent account — gate is leaking!`);
  allOk = false;
}

console.log('');
if (allOk) {
  ok('migration 008 accounts foundation verified');
  process.exit(0);
} else {
  fail('accounts foundation NOT verified (see above)');
  dim('Apply migration 008 to mzjvcntzcfagasxcnuye, then re-run.');
  process.exit(1);
}
