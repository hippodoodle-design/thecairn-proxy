// Post-apply verification for migration 011 (The Cairn seams A–D). Read-only.
// Run: node scripts/cairn-verify-011.js
// Confirms: all 8 seam tables present, RLS enabled, expected policy counts,
// FK targets (auth.users / folder_items / cairn_surfaces / cairn_retention_states),
// CHECK locks (next_of_kin=notifier, recall authored_by=user|roberta, etc.),
// the NO-DELETE posture for the customer (authenticated has no DELETE on any seam
// table), and that the sealed Roberta space (seam B) has NO authenticated grant.
import { runQuery } from './cairn-db-query.js';

const TABLES = [
  'cairn_surfaces', 'cairn_placements', 'cairn_roberta_space',
  'cairn_retention_states', 'cairn_retention_events',
  'cairn_next_of_kin', 'cairn_legacy_reserve', 'cairn_recall_metadata',
];
const list = TABLES.map((t) => `'${t}'`).join(',');

const Q = {
  // All 8 tables present + RLS enabled + policy counts (roberta_space expected 0 = sealed).
  tablesRlsPolicies: `select c.relname as tbl, c.relrowsecurity as rls,
      (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=c.relname) as policies
    from pg_class c join pg_namespace n on c.relnamespace=n.oid
    where n.nspname='public' and c.relname in (${list}) order by c.relname;`,
  // FK targets — every table -> auth.users; placements/recall/retention -> folder_items; etc.
  foreignKeys: `select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def
    from pg_constraint
    where contype='f' and conrelid::regclass::text = any (array[${TABLES.map((t) => `'public.${t}'`).join(',')}]::regclass[]::text[])
    order by tbl, conname;`,
  // CHECK locks (notifier-only, authored_by user|roberta, retention state/quota, kinds).
  checks: `select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def
    from pg_constraint
    where contype='c' and conrelid::regclass::text = any (array[${TABLES.map((t) => `'public.${t}'`).join(',')}]::regclass[]::text[])
    order by tbl, conname;`,
  // NO-DELETE for the customer: authenticated must NOT have DELETE on any seam table.
  authenticatedHasNoDelete: `select table_name, privilege_type
    from information_schema.role_table_grants
    where table_schema='public' and grantee='authenticated'
      and table_name in (${list}) and privilege_type='DELETE' order by table_name;`,
  // Seam B sealed: roberta_space must have NO grant to authenticated (locked from owner).
  robertaSpaceSealed: `select grantee, string_agg(privilege_type,',' order by privilege_type) as privs
    from information_schema.role_table_grants
    where table_schema='public' and table_name='cairn_roberta_space'
      and grantee in ('authenticated','anon') group by grantee order by grantee;`,
  // Namespace manifest records the seams.
  manifestNote: `select prefix, (position('Migration 011' in notes) > 0) as records_011
    from public._product_namespace where prefix='cairn_';`,
};

(async () => {
  for (const [k, sql] of Object.entries(Q)) {
    const out = await runQuery(sql);
    console.log(`\n## ${k}`);
    console.log(JSON.stringify(out));
  }
  console.log('\n-- expectations: 8 tables rls=true; roberta_space policies=0;');
  console.log('-- authenticatedHasNoDelete = [] (empty); robertaSpaceSealed = [] (no authenticated/anon row);');
  console.log('-- manifestNote records_011=true.');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
