// Read-only re-verification of the AS-BUILT migration 011 (Cairn seams A-D),
// dispatch cairn-seams-A-D-2026-06-08-a1. The seams were applied LIVE to
// mzjvcntzcfagasxcnuye by a concurrent run of the same dispatch; this script
// certifies the live tables against the dispatch hard gates. Touches nothing.
//
// As-built table names (note plurals + the split retention pair):
//   A: cairn_surfaces, cairn_placements
//   B: cairn_roberta_space (SEALED — RLS on, NO policy, NO authenticated grant)
//   C: cairn_retention_states, cairn_retention_events, cairn_next_of_kin,
//      cairn_legacy_reserve
//   D: cairn_recall_metadata
import { runQuery } from './cairn-db-query.js';

const AS = `('cairn_surfaces','cairn_placements','cairn_roberta_space',
  'cairn_retention_states','cairn_retention_events','cairn_next_of_kin',
  'cairn_legacy_reserve','cairn_recall_metadata')`;

const Q = {
  // All 8 present.
  tablesPresent: `select table_name from information_schema.tables
                  where table_schema='public' and table_name in ${AS} order by 1;`,
  // Own-row RLS enabled on all 8.
  rls: `select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and relname in ${AS} order by 1;`,
  // Policies (cairn_roberta_space must have NONE = sealed; owner-managed tables
  // have select/insert/update; backend-written tables have select-own only).
  policies: `select tablename, policyname, cmd, qual, with_check from pg_policies
             where schemaname='public' and tablename in ${AS} order by 1,2;`,
  // FK -> auth.users(id) on every new table's user_id.
  fkAuthUsers: `select t.relname tbl, pg_get_constraintdef(c.oid) def
                from pg_constraint c join pg_class t on t.oid=c.conrelid
                join pg_namespace n on n.oid=t.relnamespace
                where n.nspname='public' and t.relname in ${AS} and c.contype='f'
                  and pg_get_constraintdef(c.oid) like '%auth.users%' order by 1;`,
  // NO-DELETE toward the customer: assert authenticated/anon hold NO DELETE.
  customerDeletePaths: `select table_name, grantee from information_schema.role_table_grants
                        where table_schema='public' and table_name in ${AS}
                          and privilege_type='DELETE' and grantee in ('authenticated','anon')
                        order by 1,2;`,
  // Sealed Roberta space: authenticated/anon hold NO meaningful DML.
  robertaSeal: `select grantee, privilege_type from information_schema.role_table_grants
                where table_schema='public' and table_name='cairn_roberta_space'
                  and grantee in ('authenticated','anon')
                  and privilege_type in ('SELECT','INSERT','UPDATE','DELETE') order by 1,2;`,
  // Locked semantics carried as CHECK constraints.
  lockedChecks: `select t.relname tbl, pg_get_constraintdef(c.oid) def
                 from pg_constraint c join pg_class t on t.oid=c.conrelid
                 join pg_namespace n on n.oid=t.relnamespace
                 where n.nspname='public'
                   and t.relname in ('cairn_retention_states','cairn_next_of_kin','cairn_recall_metadata')
                   and c.contype='c' order by 1;`,
  // Gate C: tables must be empty (experimental-only; no real data before IWF spine).
  rowCounts: `select 'cairn_surfaces' t, count(*)::int n from public.cairn_surfaces
    union all select 'cairn_placements', count(*)::int from public.cairn_placements
    union all select 'cairn_roberta_space', count(*)::int from public.cairn_roberta_space
    union all select 'cairn_retention_states', count(*)::int from public.cairn_retention_states
    union all select 'cairn_retention_events', count(*)::int from public.cairn_retention_events
    union all select 'cairn_next_of_kin', count(*)::int from public.cairn_next_of_kin
    union all select 'cairn_legacy_reserve', count(*)::int from public.cairn_legacy_reserve
    union all select 'cairn_recall_metadata', count(*)::int from public.cairn_recall_metadata
    order by 1;`,
};

(async () => {
  for (const [k, sql] of Object.entries(Q)) {
    const out = await runQuery(sql);
    console.log(`\n## ${k}`);
    console.log(JSON.stringify(out));
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
