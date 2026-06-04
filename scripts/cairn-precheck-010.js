// Read-only pre-check for migration 010 (cairn_usage_events + _product_namespace).
// Confirms the two new names do NOT already exist, the foundation is present, and
// records the other-product footprint. Touches nothing.
import { runQuery } from './cairn-db-query.js';

const Q = {
  newNames: `select table_name from information_schema.tables
             where table_schema='public'
               and table_name in ('cairn_usage_events','_product_namespace');`,
  cairnTables: `select table_name from information_schema.tables
                where table_schema='public' and table_name like 'cairn\\_%' order by 1;`,
  spine: `select table_name from information_schema.tables
          where table_schema='public'
            and table_name in ('folder_items','stone_collections','stone_collection_items','undo_log')
          order by 1;`,
  subsCols: `select column_name, data_type from information_schema.columns
             where table_schema='public' and table_name='subscriptions' order by ordinal_position;`,
  subsCount: `select count(*)::int as n from public.subscriptions;`,
  otherProduct: `select table_name from information_schema.tables
                 where table_schema='public'
                   and table_name in ('companions','user_companions','companion_events',
                     'species_requests','zoo_keeper_letters','zoo_daily_activities','subscriptions')
                 order by 1;`,
  grantFn: `select proname from pg_proc where proname='cairn_grant_free_storage_month';`,
};

(async () => {
  for (const [k, sql] of Object.entries(Q)) {
    const out = await runQuery(sql);
    console.log(`\n## ${k}`);
    console.log(JSON.stringify(out));
  }
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
