/**
 * Schema round-trip check for Wave Cairn Customer Accounts + Entitlements.
 * Run from C:\thecairn-proxy with:
 *   node --env-file=.env scripts/test-cairn-accounts.js
 *
 * Verifies (read-only, non-destructive) that migration 008 has been applied to
 * the Cairn project (mzjvcntzcfagasxcnuye):
 *   1. The four account tables exist + are readable by the service role.
 *   2. The free-month granting function exists and is callable (dry probe on a
 *      random non-existent account → expects granted=false, reason=no_profile).
 *   3. The provider-agnostic free-month predicate (shared/accounts) matches the
 *      SQL rule for a few representative cases (pure, no DB needed).
 *
 * NOTE: full RLS enforcement (owner-only reads, paid_rescues invisible to
 * customers) requires real auth.users rows + user JWTs — that's the E2E test's
 * job (frontend, thecairn-app). This script confirms the schema + rule wiring.
 *
 * Exits 0 on success, 1 on any failure (incl. "migration not yet applied").
 */

import { createClient } from '@supabase/supabase-js';
import { freeMonthEligibility } from '@cairn/shared/accounts';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const YELLOW = '\x1b[33m';

const ok = (m) => console.log(`${GREEN}✓${RESET} ${m}`);
const fail = (m) => console.log(`${RED}✗${RESET} ${m}`);
const dim = (m) => console.log(`${DIM}  ${m}${RESET}`);
const warn = (m) => console.log(`${YELLOW}!${RESET} ${m}`);

// ---------------------------------------------------------------------------
// Part 1 — pure predicate checks (no DB). These mirror the SQL rule exactly.
// ---------------------------------------------------------------------------
let allOk = true;

const CASES = [
  {
    name: 'no paid rescue → ineligible',
    input: { email: 'a@x.com', paidRescues: [], subscription: { tier: 'paid', status: 'active' } },
    expect: { eligible: false, reason: 'no_paid_rescue' },
  },
  {
    name: 'paid rescue but no paid sub → ineligible',
    input: {
      email: 'a@x.com',
      paidRescues: [{ product: 'byteme', email: 'A@X.com', status: 'paid' }],
      subscription: { tier: 'free', status: 'inactive' },
    },
    expect: { eligible: false, reason: 'no_paid_cairn_subscription' },
  },
  {
    name: 'paid rescue (case-insensitive email) + paid active sub → eligible',
    input: {
      email: 'a@x.com',
      paidRescues: [{ product: 'cairnferry', email: 'A@X.COM', status: 'paid' }],
      subscription: { tier: 'paid', status: 'active' },
    },
    expect: { eligible: true, reason: 'eligible', productPaid: 'cairnferry' },
  },
  {
    name: 'refunded rescue does not count → ineligible',
    input: {
      email: 'a@x.com',
      paidRescues: [{ product: 'byteme', email: 'a@x.com', status: 'refunded' }],
      subscription: { tier: 'paid', status: 'active' },
    },
    expect: { eligible: false, reason: 'no_paid_rescue' },
  },
];

for (const c of CASES) {
  const got = freeMonthEligibility(c.input);
  const matches =
    got.eligible === c.expect.eligible &&
    got.reason === c.expect.reason &&
    (c.expect.productPaid === undefined || got.productPaid === c.expect.productPaid);
  if (matches) {
    ok(`predicate: ${c.name}`);
  } else {
    fail(`predicate: ${c.name} — got ${JSON.stringify(got)}`);
    allOk = false;
  }
}

// ---------------------------------------------------------------------------
// Part 2 — schema checks (need the DB). Skipped cleanly if env is absent.
// ---------------------------------------------------------------------------
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.log('');
  warn(`Supabase env vars missing — skipping DB schema checks (predicate checks above still ran).`);
  warn(`Set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to verify migration 008 is applied.`);
  process.exit(allOk ? 0 : 1);
}
if (!url.includes('mzjvcntzcfagasxcnuye')) {
  fail(`SUPABASE_URL is not the Cairn project (expected mzjvcntzcfagasxcnuye): ${url}`);
  process.exit(1);
}
ok(`Connected to Cairn project (mzjvcntzcfagasxcnuye)`);

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const TABLES = ['profiles', 'subscriptions', 'entitlements', 'paid_rescues'];

function isMissingTable(error) {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  return /does not exist|schema cache|could not find the table/i.test(error.message || '');
}

for (const table of TABLES) {
  const { error } = await supabase.from(table).select('*').limit(1);
  if (isMissingTable(error)) {
    fail(`table public.${table} does not exist`);
    warn('Migration 008 has not been applied. Apply migrations/20260603_008_cairn_customer_accounts.sql');
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

// Granting function exists + is callable. Probe with a random uuid that has no
// profile → the rule must short-circuit to granted=false, reason=no_profile,
// proving the function is wired without mutating any real account.
const PROBE_ID = '00000000-0000-0000-0000-000000000000';
const { data: rpcData, error: rpcErr } = await supabase.rpc('grant_free_month_if_eligible', {
  p_account_id: PROBE_ID,
});
if (rpcErr) {
  if (/function .*does not exist|could not find the function|PGRST202/i.test(rpcErr.message || '') || rpcErr.code === 'PGRST202') {
    fail('function public.grant_free_month_if_eligible(uuid) does not exist');
    warn('Migration 008 has not been applied (or only partially).');
    process.exit(1);
  }
  fail(`grant_free_month_if_eligible not callable: ${rpcErr.message}`);
  allOk = false;
} else {
  const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
  if (row && row.granted === false && row.reason === 'no_profile') {
    ok('grant_free_month_if_eligible callable + short-circuits on unknown account (no_profile)');
  } else {
    fail(`grant_free_month_if_eligible returned unexpected: ${JSON.stringify(rpcData)}`);
    allOk = false;
  }
}

console.log('');
if (allOk) {
  ok('cairn accounts schema + free-month rule verified');
  dim('RLS owner-only enforcement + paid_rescues invisibility belong to the E2E test (needs real auth users + JWTs).');
  process.exit(0);
} else {
  fail('cairn accounts schema verification failed');
  process.exit(1);
}
