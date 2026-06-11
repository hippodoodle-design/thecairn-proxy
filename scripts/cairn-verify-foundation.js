// cairn-verify-foundation.js — one-command, READ-ONLY certification of the
// WHOLE Cairn data foundation (migrations 008/009/010/011 + the Cairn's own
// canvas) against the BLESSED spec (Pod docs 5a50c3ac / f4b74a9b / d36881a1).
//
// It touches NOTHING. It runs structural assertions against the LIVE schema on
// mzjvcntzcfagasxcnuye via the Supabase Management API (scripts/cairn-db-query.js,
// the DDL/query path mandated by CLAUDE.md HippoSwitch Layer 1 — NOT the MCP,
// NOT the service-role PostgREST key). Exits non-zero if any gate fails, so it
// doubles as a CI / pre-flight gate before anyone touches the foundation again.
//
// Usage:  node scripts/cairn-verify-foundation.js
//
// History: supersedes the per-migration verifiers (cairn-verify-010.js,
// cairn-verify-011.js) by certifying the full chain in one pass. Authored for
// dispatch cairn-foundation-canvas-2026-06-10-a1 (VERIFY-LIVE-FIRST), which
// found the foundation already fully applied by the 6–8 Jun waves (PRs #7/#8/#10).
import { runQuery } from './cairn-db-query.js';

let pass = 0, fail = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; fails.push(name); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
const rows = async (sql) => (await runQuery(sql)) || [];
const one = async (sql) => (await rows(sql))[0];

// The full foundation surface.
const SEAM = ['cairn_surfaces','cairn_placements','cairn_roberta_space',
  'cairn_retention_states','cairn_retention_events','cairn_next_of_kin',
  'cairn_legacy_reserve','cairn_recall_metadata'];
const CONTENT = ['folder_items','stone_collections','stone_collection_items','undo_log'];
const BILLING = ['cairn_subscriptions','cairn_entitlements','cairn_paid_rescues'];
const USAGE = ['cairn_usage_events'];
const ALL_CAIRN_DATA = [...CONTENT, ...BILLING, ...USAGE, ...SEAM]; // every table that must be empty (Gate C)
const lit = (arr) => '(' + arr.map((t) => `'${t}'`).join(',') + ')';

(async () => {
  console.log('# Cairn foundation certification (live, read-only) — mzjvcntzcfagasxcnuye\n');

  // ---- VAULT ANCHOR (migration 005) ----
  console.log('## Anchor — public.profiles (PK id = auth.users.id, live since 005)');
  const prof = await one(`select 1 ok from information_schema.tables
    where table_schema='public' and table_name='profiles';`);
  check('profiles table present (the account anchor)', !!prof);

  // ---- MIGRATION 008 — accounts/entitlements (reworked, cairn_-prefixed, auth.users) ----
  console.log('\n## 008 — accounts / entitlements (cairn_-prefixed, FK auth.users)');
  const billPresent = (await rows(`select table_name from information_schema.tables
    where table_schema='public' and table_name in ${lit(BILLING)};`)).map((r) => r.table_name);
  for (const t of BILLING) check(`${t} present`, billPresent.includes(t));
  const billFk = await rows(`select t.relname tbl, pg_get_constraintdef(c.oid) def
    from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
    where n.nspname='public' and t.relname in ${lit(BILLING)} and c.contype='f'
      and pg_get_constraintdef(c.oid) like '%auth.users%';`);
  check('billing tables FK -> auth.users present', billFk.length >= 1, `${billFk.length} found`);
  const grantFn = await one(`select p.proname,
      (select string_agg(distinct g.grantee,',') from information_schema.role_routine_grants g
        where g.routine_name=p.proname and g.privilege_type='EXECUTE') execs
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='cairn_grant_free_storage_month';`);
  check('cairn_grant_free_storage_month() present', !!grantFn);
  check('  ...EXECUTE locked to service_role/postgres only (no authenticated/anon/public)',
    !!grantFn && !/authenticated|anon|PUBLIC/i.test(grantFn.execs || ''), grantFn && grantFn.execs);

  // ---- MIGRATION 009 — content model (4 owner_id FKs repointed -> auth.users) ----
  console.log('\n## 009 — content model (owner_id -> auth.users, NO-DELETE, undo ring)');
  const contentPresent = (await rows(`select table_name from information_schema.tables
    where table_schema='public' and table_name in ${lit(CONTENT)};`)).map((r) => r.table_name);
  for (const t of CONTENT) check(`${t} present`, contentPresent.includes(t));
  const ownerFk = await rows(`select t.relname tbl, pg_get_constraintdef(c.oid) def
    from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
    join pg_attribute a on a.attrelid=t.oid and a.attnum = any(c.conkey)
    where n.nspname='public' and t.relname in ${lit(CONTENT)} and c.contype='f' and a.attname='owner_id';`);
  for (const t of CONTENT) {
    const def = (ownerFk.find((r) => r.tbl === t) || {}).def || '';
    check(`${t}.owner_id -> auth.users(id)`, /auth\.users\(id\)/.test(def), def || 'no owner_id FK');
  }
  const status = await one(`select 1 ok from information_schema.columns
    where table_schema='public' and table_name='folder_items' and column_name='status';`);
  check('folder_items.status present (NO-DELETE soft-trash, blob retained)', !!status);
  const undoTrig = await one(`select 1 ok from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='undo_log' and t.tgname='undo_log_trim' and not t.tgisinternal;`);
  check('undo_log_trim ring trigger present (~20-op undo spine)', !!undoTrig);

  // ---- MIGRATION 010 — usage events + namespace manifest ----
  console.log('\n## 010 — cairn_usage_events + _product_namespace');
  check('cairn_usage_events present', !!(await one(`select 1 ok from information_schema.tables
    where table_schema='public' and table_name='cairn_usage_events';`)));
  const ns = await rows(`select prefix from public._product_namespace;`);
  check('_product_namespace seeded (>=1 row incl. cairn_)',
    ns.some((r) => r.prefix === 'cairn_'), `${ns.length} rows`);

  // ---- MIGRATION 011 — seams A–D ----
  console.log('\n## 011 — seams A–D (placement / sealed Roberta / retention+kin / recall)');
  const seamPresent = (await rows(`select table_name from information_schema.tables
    where table_schema='public' and table_name in ${lit(SEAM)};`)).map((r) => r.table_name);
  for (const t of SEAM) check(`${t} present`, seamPresent.includes(t));
  const seamFk = await rows(`select t.relname tbl from pg_constraint c
    join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
    where n.nspname='public' and t.relname in ${lit(SEAM)} and c.contype='f'
      and pg_get_constraintdef(c.oid) like '%auth.users%';`);
  check('all 8 seam tables FK user_id -> auth.users', new Set(seamFk.map((r) => r.tbl)).size === 8,
    `${new Set(seamFk.map((r) => r.tbl)).size}/8`);
  // Seam B — sealed Roberta space: RLS on, ZERO policies, no authenticated DML.
  const robPol = await rows(`select policyname from pg_policies
    where schemaname='public' and tablename='cairn_roberta_space';`);
  check('Seam B: cairn_roberta_space has ZERO policies (sealed even from owner)', robPol.length === 0,
    `${robPol.length} policies`);
  const robGrant = await rows(`select privilege_type from information_schema.role_table_grants
    where table_schema='public' and table_name='cairn_roberta_space'
      and grantee in ('authenticated','anon')
      and privilege_type in ('SELECT','INSERT','UPDATE','DELETE');`);
  check('Seam B: authenticated/anon have NO SELECT/INSERT/UPDATE/DELETE on Roberta space',
    robGrant.length === 0, `${robGrant.length} grants`);
  // Seam C — locked semantics as CHECK constraints.
  const checks = (await rows(`select t.relname tbl, pg_get_constraintdef(c.oid) def
    from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace
    where n.nspname='public' and c.contype='c'
      and t.relname in ('cairn_next_of_kin','cairn_retention_states','cairn_recall_metadata');`))
    .map((r) => r.def).join(' | ');
  check("Seam C: next_of_kin.role CHECK = 'notifier' (notifier, not heir)", /role = 'notifier'/.test(checks));
  check('Seam C: retention.state CHECK = live/in_the_bin/legacy_hold/cold_free_file_floor',
    /in_the_bin/.test(checks) && /legacy_hold/.test(checks) && /cold_free_file_floor/.test(checks));
  const clocks = await one(`select bin_grace_days, legacy_hold_months from public.cairn_retention_states limit 1;`)
    || (await one(`select (select column_default from information_schema.columns where table_name='cairn_retention_states' and column_name='bin_grace_days') bin,
                          (select column_default from information_schema.columns where table_name='cairn_retention_states' and column_name='legacy_hold_months') leg;`));
  check('Seam C: clocks default bin=30d / legacy-hold=12mo',
    /30/.test(JSON.stringify(clocks)) && /12/.test(JSON.stringify(clocks)), JSON.stringify(clocks));
  check('Seam D: recall_metadata.authored_by CHECK in (user, roberta) — never a machine classifier',
    /authored_by = ANY \(ARRAY\['user'::text, 'roberta'::text\]\)/.test(checks) || /'user'.*'roberta'/.test(checks));

  // ---- CANVAS — the Cairn's OWN placement layer (NOT the Pod's canvas) ----
  console.log("\n## Canvas — the Cairn's own placement-over-vault model");
  const placeCols = (await rows(`select column_name from information_schema.columns
    where table_schema='public' and table_name='cairn_placements';`)).map((r) => r.column_name);
  for (const c of ['memory_id','surface_id','x','y','scale','rotation','z','theme'])
    check(`cairn_placements has ${c}`, placeCols.includes(c));
  check('canvas is the Cairn\'s OWN (cairn_*), not a copy of the Pod pod_canvas* tables',
    !(await one(`select 1 ok from information_schema.tables
       where table_schema='public' and table_name in ('pod_canvases','pod_canvas_placements');`)));

  // ---- CROSS-CUTTING — operator-blind + own-row RLS on every data table ----
  console.log('\n## Cross-cutting — operator-blind + own-row RLS');
  const noRls = await rows(`select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname in ${lit(ALL_CAIRN_DATA)} and relrowsecurity=false;`);
  check('RLS enabled on EVERY foundation data table', noRls.length === 0,
    noRls.map((r) => r.relname).join(','));
  // No policy may grant a cross-user read (operator-blind): every qual ties to auth.uid().
  const leaky = await rows(`select tablename, policyname, qual from pg_policies
    where schemaname='public' and tablename in ${lit(ALL_CAIRN_DATA)} and cmd in ('SELECT','ALL')
      and (qual is null or qual not like '%auth.uid()%');`);
  check('No SELECT/ALL policy escapes auth.uid() (no admin/all-users read path)', leaky.length === 0,
    leaky.map((r) => `${r.tablename}.${r.policyname}`).join(','));
  // NO-DELETE, encoded to the doctrine (d36881a1 Remove≠Delete + f4b74a9b One-Vault-
  // Many-Lenses), NOT as a blanket ban:
  //   * VAULT + append/safety tables = the frightening word "delete" is quarantined
  //     AWAY from customers (soft-trash / append-only only). Hard gate: NO customer DELETE.
  //   * LENS grouping tables (stone_collections / stone_collection_items) = a memory's
  //     membership in a stack. Removing it / disbanding a stack is a "remove" — zero
  //     effect on the vault, reversible via undo_log. Owner-scoped DELETE here is BY
  //     DESIGN (PR #6 removeFromStone). We only assert it stays owner-scoped (operator-blind).
  const VAULT_NODELETE = ['folder_items', 'undo_log', ...USAGE, ...BILLING, ...SEAM];
  const LENS_DELETE_OK = ['stone_collections', 'stone_collection_items'];
  const custDelete = await rows(`select table_name, grantee from information_schema.role_table_grants
    where table_schema='public' and table_name in ${lit(VAULT_NODELETE)}
      and privilege_type='DELETE' and grantee in ('authenticated','anon');`);
  check('Vault + append/safety tables grant NO customer DELETE (delete quarantined to the vault, by hand)',
    custDelete.length === 0, custDelete.map((r) => `${r.table_name}:${r.grantee}`).join(','));
  // Lens delete, where it exists, must be owner-scoped (a private "remove", never cross-user).
  const lensDel = await rows(`select tablename, policyname, qual from pg_policies
    where schemaname='public' and tablename in ${lit(LENS_DELETE_OK)} and cmd in ('DELETE','ALL')
      and (qual is null or qual not like '%auth.uid()%');`);
  check('Lens "remove" (stone_collections membership) is owner-scoped only — a reversible remove, not a vault delete',
    lensDel.length === 0, lensDel.map((r) => `${r.tablename}.${r.policyname}`).join(','));

  // ---- GATE C — experimental only: every data table EMPTY (no real memories) ----
  console.log('\n## Gate C — placeholder only (every data table EMPTY until IWF spine live)');
  const counts = await rows(ALL_CAIRN_DATA.map((t) =>
    `select '${t}' t, count(*)::int n from public.${t}`).join(' union all ') + ' order by 1;');
  const nonEmpty = counts.filter((r) => r.n > 0);
  check('every foundation data table is EMPTY (Gate C — no real data)', nonEmpty.length === 0,
    nonEmpty.map((r) => `${r.t}=${r.n}`).join(','));

  console.log(`\n# RESULT: ${pass} passed, ${fail} failed.`);
  if (fail) { console.log('FAILED:', fails.join('; ')); process.exit(1); }
  console.log('ALL GATES GREEN — foundation + seams A–D + canvas certified against the BLESSED spec.');
})().catch((e) => { console.error('ERR', e.message); process.exit(2); });
