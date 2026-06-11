// Post-apply verification for migration 010. Read-only.
import { runQuery } from './cairn-db-query.js';

const Q = {
  tablesPresent: `select table_name from information_schema.tables
                  where table_schema='public'
                    and table_name in ('cairn_usage_events','_product_namespace') order by 1;`,
  usageCols: `select column_name, data_type, is_nullable from information_schema.columns
              where table_schema='public' and table_name='cairn_usage_events' order by ordinal_position;`,
  usageFk: `select c.conname, pg_get_constraintdef(c.oid) as def
            from pg_constraint c join pg_class t on t.oid=c.conrelid
            where t.relname='cairn_usage_events' and c.contype='f';`,
  rls: `select relname, relrowsecurity from pg_class
        where relname in ('cairn_usage_events','_product_namespace') order by 1;`,
  policies: `select tablename, policyname, cmd from pg_policies
             where tablename in ('cairn_usage_events','_product_namespace') order by 1,2;`,
  // NO-DELETE check: list privileges granted on cairn_usage_events.
  grants: `select grantee, privilege_type from information_schema.role_table_grants
           where table_schema='public' and table_name='cairn_usage_events'
           order by grantee, privilege_type;`,
  manifest: `select prefix, product_name, owner_role from public._product_namespace order by prefix;`,
  // Function still present + unchanged signature (we did not touch it).
  fn: `select proname, pg_get_function_identity_arguments(oid) as args from pg_proc
       where proname='cairn_grant_free_storage_month';`,
  // public.subscriptions untouched: same 13 cols, 0 rows, processor shape.
  subsCols: `select count(*)::int as ncols from information_schema.columns
             where table_schema='public' and table_name='subscriptions';`,
  subsRows: `select count(*)::int as nrows from public.subscriptions;`,
};

(async () => {
  for (const [k, sql] of Object.entries(Q)) {
    const out = await runQuery(sql);
    console.log(`\n## ${k}`);
    console.log(JSON.stringify(out));
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
