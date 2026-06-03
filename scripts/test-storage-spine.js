/**
 * Schema check for Wave Cairn Storage + Stones Spine (dispatch db871533).
 * Run from C:\thecairn-proxy with:
 *   node --env-file=.env scripts/test-storage-spine.js
 *
 * Verifies (read-only, non-destructive) that migration 009 has been applied to
 * the Cairn project (mzjvcntzcfagasxcnuye):
 *   1. folder_items / stone_collections / stone_collection_items / undo_log
 *      tables exist + are readable by the service role.
 *
 * A full write round-trip (deposit → folder → copy-to-stone → undo) needs a real
 * auth.users/account row; that is the E2E test's job. This confirms the schema is
 * in place so the /api/cairn endpoints have something to talk to.
 *
 * Exits 0 on success, 1 on any failure (incl. "migration not yet applied").
 * NOTE: migration 009 depends on migration 008 (accounts) — apply 008 first.
 */

import { createClient } from '@supabase/supabase-js';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const ok = (m) => console.log(`${GREEN}✓${RESET} ${m}`);
const fail = (m) => console.log(`${RED}✗${RESET} ${m}`);
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
ok('Connected to Cairn project (mzjvcntzcfagasxcnuye)');

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

function isMissingTable(error) {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  return /does not exist|schema cache|could not find the table/i.test(error.message || '');
}

let allOk = true;
const TABLES = ['folder_items', 'stone_collections', 'stone_collection_items', 'undo_log'];

for (const table of TABLES) {
  const { error } = await supabase.from(table).select('id').limit(1);
  if (isMissingTable(error)) {
    fail(`table public.${table} does not exist`);
    warn('migration 009 not applied yet — apply 20260603_009_storage_stones_spine.sql (after 008)');
    allOk = false;
  } else if (error) {
    fail(`table public.${table} read error: ${error.message}`);
    allOk = false;
  } else {
    ok(`table public.${table} exists + readable`);
  }
}

console.log('');
if (allOk) {
  ok('migration 009 storage+stones spine verified');
  process.exit(0);
} else {
  fail('storage+stones spine NOT verified (see above)');
  process.exit(1);
}
