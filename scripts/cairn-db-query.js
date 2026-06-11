// cairn-db-query.js — run SQL against the live Cairn Supabase project
// (mzjvcntzcfagasxcnuye) via the Management API database/query endpoint, using
// the project access token (SUPABASE_ACCESS_TOKEN, sbp_...). This is the
// DDL/query path mandated by CLAUDE.md (HippoSwitch Layer 1): NOT the Supabase
// MCP (forbidden for this project), NOT the service-role PostgREST key (cannot
// run DDL). Used to apply Cairn migrations and run read-only verification.
//
// Usage:
//   node scripts/cairn-db-query.js --file migrations/XXXX.sql   # apply a SQL file
//   node scripts/cairn-db-query.js --sql "select 1;"            # run inline SQL
//   echo "select 1;" | node scripts/cairn-db-query.js           # SQL from stdin
import fs from 'fs';
import { fileURLToPath } from 'url';

const REF = process.env.CAIRN_SUPABASE_REF || 'mzjvcntzcfagasxcnuye';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

async function runQuery(sql) {
  if (!TOKEN) throw new Error('SUPABASE_ACCESS_TOKEN not set');
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${REF}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    }
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

export { runQuery, REF };

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  (async () => {
    const args = process.argv.slice(2);
    let sql = null;
    const fileIdx = args.indexOf('--file');
    const sqlIdx = args.indexOf('--sql');
    if (fileIdx !== -1) {
      sql = fs.readFileSync(args[fileIdx + 1], 'utf8');
    } else if (sqlIdx !== -1) {
      sql = args[sqlIdx + 1];
    } else if (!process.stdin.isTTY) {
      sql = fs.readFileSync(0, 'utf8');
    }
    if (!sql || !sql.trim()) {
      console.error('No SQL provided (use --file, --sql, or stdin).');
      process.exit(2);
    }
    try {
      const out = await runQuery(sql);
      console.log(JSON.stringify(out, null, 2));
    } catch (e) {
      console.error('ERROR', e.message);
      process.exit(1);
    }
  })();
}
