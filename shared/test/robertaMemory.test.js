/**
 * Release-condition tests for Roberta's per-user memory notebook.
 *
 * These assert THE LAW — "Infinite Append, Constant Render" (Amanda, 14 Jun
 * 2026) — at the seam layer, with a fake Supabase client (no network):
 *   • ALWAYS ROOM    — a non-empty memory is never refused; no size ceiling.
 *   • NEVER TRUNCATE — content is stored whole; the seam exports no update/delete.
 *   • SMALL THINGS   — the tiniest note is stored as-is.
 *   • WHOLE RECORD   — recall reads the entire record oldest-first, not the top.
 *   • OPERATOR-BLIND — recall is per-user and scoped to that user's id.
 *   • GRACEFUL       — a missing table (pre-migration) no-ops, never throws.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendMemory,
  recallMemories,
  countMemories,
  MEMORY_TABLE,
} from '../src/robertaMemory.js';
import * as memoryModule from '../src/robertaMemory.js';

/* ─── A tiny in-memory fake of the Supabase query builder we use ──────────── */

function makeFakeClient(rows = []) {
  const store = [...rows];
  const calls = { inserted: [], selectedTable: null, eqUser: null, ordered: null, limit: null };

  return {
    _store: store,
    _calls: calls,
    from(table) {
      calls.selectedTable = table;
      return {
        async insert(row) {
          // The DB has no UPDATE/DELETE grant; the fake only knows how to append.
          calls.inserted.push(row);
          store.push({ id: `id-${store.length + 1}`, created_at: row.created_at || `t-${store.length + 1}`, ...row });
          return { error: null };
        },
        select(_cols, opts) {
          let filterUser = null;
          let asc = true;
          let lim = null;
          const builder = {
            eq(_col, val) { filterUser = val; calls.eqUser = val; return builder; },
            order(_col, { ascending } = {}) { asc = ascending !== false; calls.ordered = asc ? 'asc' : 'desc'; return builder; },
            limit(n) { lim = n; calls.limit = n; return builder; },
            then(resolve) {
              let data = store.filter((r) => filterUser == null || r.user_id === filterUser);
              data = data.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
              if (!asc) data = data.reverse();
              if (lim != null) data = data.slice(0, lim);
              if (opts && opts.head && opts.count === 'exact') {
                return resolve({ count: data.length, error: null });
              }
              return resolve({ data, error: null });
            },
          };
          return builder;
        },
      };
    },
  };
}

/** A client whose table is absent — every op returns the PostgREST "no table" code. */
function makeMissingTableClient() {
  const missing = { code: '42P01', message: 'relation "cairn_roberta_memory" does not exist' };
  return {
    from() {
      return {
        async insert() { return { error: missing }; },
        select() {
          const builder = {
            eq() { return builder; },
            order() { return builder; },
            limit() { return builder; },
            then(resolve) { return resolve({ data: null, count: null, error: missing }); },
          };
          return builder;
        },
      };
    },
  };
}

/* ─── NEVER TRUNCATE — the seam offers no way to rub anything out ─────────── */

test('law: the seam is append-only — no update/delete is exported', () => {
  assert.equal(typeof memoryModule.appendMemory, 'function');
  assert.equal(typeof memoryModule.recallMemories, 'function');
  assert.equal(memoryModule.updateMemory, undefined, 'must NOT expose updateMemory');
  assert.equal(memoryModule.deleteMemory, undefined, 'must NOT expose deleteMemory');
  assert.equal(memoryModule.clearMemories, undefined, 'must NOT expose clearMemories');
  assert.equal(memoryModule.truncate, undefined, 'must NOT expose truncate');
});

test('law: content is stored WHOLE — never truncated, even when long', async () => {
  const client = makeFakeClient();
  const long = 'they always hummed while making tea. '.repeat(500); // ~18k chars
  const ok = await appendMemory({ userId: 'u1', content: long, client });
  assert.equal(ok, true);
  assert.equal(client._calls.inserted[0].content, long.trim(), 'stored verbatim, no cap');
});

/* ─── ALWAYS ROOM + SMALL THINGS — never refuse a non-empty memory ────────── */

test('law: the tiniest small thing is stored as-is', async () => {
  const client = makeFakeClient();
  const ok = await appendMemory({ userId: 'u1', content: 'tea.', client });
  assert.equal(ok, true);
  assert.equal(client._store[0].content, 'tea.');
});

test('law: there is always room — repeated appends never get refused', async () => {
  const client = makeFakeClient();
  for (let i = 0; i < 200; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await appendMemory({ userId: 'u1', content: `thing ${i}`, client }), true);
  }
  assert.equal(await countMemories({ userId: 'u1', client }), 200, 'no cap clipped the record');
});

test('only truly-empty content is declined (nothing to store)', async () => {
  const client = makeFakeClient();
  assert.equal(await appendMemory({ userId: 'u1', content: '   ', client }), false);
  assert.equal(client._calls.inserted.length, 0);
});

/* ─── WHOLE RECORD, NOT THE TOP — recall returns all of it, oldest-first ──── */

test('law: recall returns the WHOLE record, oldest-first — not just the top', async () => {
  const client = makeFakeClient();
  for (const c of ['first', 'second', 'third', 'fourth']) {
    // eslint-disable-next-line no-await-in-loop
    await appendMemory({ userId: 'u1', content: c, client });
  }
  const all = await recallMemories({ userId: 'u1', client });
  assert.equal(all.length, 4, 'every memory comes back — no recent-slice cap');
  assert.deepEqual(all.map((m) => m.content), ['first', 'second', 'third', 'fourth']);
  assert.equal(client._calls.ordered, 'asc', 'oldest-first: the whole arc, not the top');
});

/* ─── OPERATOR-BLIND / per-user isolation — recall is scoped to the user ──── */

test('per-user isolation: one user never recalls another user\'s notebook', async () => {
  const client = makeFakeClient();
  await appendMemory({ userId: 'alice', content: 'her secret', client });
  await appendMemory({ userId: 'bob', content: 'his secret', client });
  const aliceOnly = await recallMemories({ userId: 'alice', client });
  assert.equal(aliceOnly.length, 1);
  assert.equal(aliceOnly[0].content, 'her secret');
  assert.equal(client._calls.eqUser, 'alice', 'query is scoped to the asking user');
});

/* ─── GRACEFUL before migration 011 is applied (Amanda's tap) ─────────────── */

test('graceful: a missing table no-ops, never throws', async () => {
  const client = makeMissingTableClient();
  assert.equal(await appendMemory({ userId: 'u1', content: 'x', client }), false);
  assert.deepEqual(await recallMemories({ userId: 'u1', client }), []);
  assert.equal(await countMemories({ userId: 'u1', client }), 0);
});

/* ─── input guards ───────────────────────────────────────────────────────── */

test('userId is required for every operation', async () => {
  await assert.rejects(() => appendMemory({ content: 'x' }), /userId is required/);
  await assert.rejects(() => recallMemories({}), /userId is required/);
  await assert.rejects(() => countMemories({}), /userId is required/);
});

test('the table name is the cairn_ namespaced notebook', () => {
  assert.equal(MEMORY_TABLE, 'cairn_roberta_memory');
});
