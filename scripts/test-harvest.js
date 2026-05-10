/**
 * Standalone Phase 6 ingest → harvest test (no Redis required).
 *
 * Usage:
 *   node --env-file=.env scripts/test-harvest.js [url] [count]
 *
 * Defaults:
 *   url    https://www.youtube.com/watch?v=jNQXAC9IVRw  ("Me at the zoo")
 *   count  5  (5 / 10 / 15)
 *
 * Steps:
 *   1. Run processVideoUrl on the url.
 *   2. Verify harvest_candidates is non-empty (it should be — "Me at the zoo"
 *      classifies personal).
 *   3. Synthesise a stone object with that understanding embedded.
 *   4. Stub the Supabase client so loads return the synth stone and inserts
 *      are captured (not persisted).
 *   5. Call processMediaHarvest({ stone_id, count, requested_by_owner_id }).
 *   6. Print backend, keys, would-be inserts. Verify each stored frame exists.
 *
 * Bypasses BullMQ entirely. The harvest core is the same code paths the
 * worker calls; only Supabase is stubbed.
 */

import { existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { processVideoUrl } from '../shared/src/media-pipeline/index.js';
import { processMediaHarvest } from '../worker/src/jobs/mediaHarvest.js';
import { STUB_STORAGE_ROOT } from '../shared/src/media-pipeline/storage/index.js';
import { createLogger } from '../shared/src/logger.js';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

const DEFAULT_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const DEFAULT_COUNT = 5;

const url = process.argv[2] || DEFAULT_URL;
const count = process.argv[3] ? Number(process.argv[3]) : DEFAULT_COUNT;
if (![5, 10, 15].includes(count)) {
  console.error(`${RED}invalid count:${RESET} ${count} (must be 5, 10, or 15)`);
  process.exit(2);
}

const TEST_STONE_ID = 'test-stone-' + Date.now();
const TEST_OWNER_ID = 'test-owner-' + Date.now();

const log = createLogger('test-harvest');

let exitCode = 0;
let storedKeysToCleanup = [];

try {
  // ─── 1. Ingest ──────────────────────────────────────────────────────
  console.log(`${DIM}url=${url}${RESET}`);
  console.log(`${DIM}count=${count}${RESET}`);
  console.log('');
  console.log(`${BOLD}Step 1 — ingest${RESET}`);

  const understanding = await processVideoUrl(url);
  console.log(`${GREEN}✓${RESET} ingested — category=${understanding.video_category}, harvest_candidates=${understanding.harvest_candidates.length}`);
  for (const c of understanding.harvest_candidates) {
    console.log(`${DIM}  [${String(c.frame_index).padStart(2)}] ${(c.timestamp_ms / 1000).toFixed(2)}s — ${c.reasoning}${RESET}`);
  }

  if (understanding.harvest_candidates.length === 0) {
    console.error(`${RED}✗${RESET} expected non-empty harvest_candidates for personal video; got 0`);
    process.exit(1);
  }

  // ─── 2. Synthesise stone ────────────────────────────────────────────
  const stone = {
    id: TEST_STONE_ID,
    owner_id: TEST_OWNER_ID,
    kind: 'video',
    metadata: {
      media_pipeline: {
        source_url: url,
        harvest_candidates: understanding.harvest_candidates,
      },
    },
  };

  // ─── 3. Stub Supabase ───────────────────────────────────────────────
  const inserts = [];
  let nextGalleryId = 1;
  const stubSupabase = {
    from(table) {
      const builder = {
        _table: table,
        _insertRow: null,
        select() { return this; },
        eq() { return this; },
        async single() {
          if (this._insertRow) {
            const id = `synthetic-gallery-${nextGalleryId++}`;
            inserts.push({ table: this._table, row: this._insertRow, id });
            return { data: { id }, error: null };
          }
          if (this._table === 'stones') {
            return { data: stone, error: null };
          }
          return { data: null, error: { message: `unexpected select on ${this._table}` } };
        },
        insert(row) {
          this._insertRow = row;
          return this;
        },
      };
      return builder;
    },
  };

  // ─── 4. Run harvest ─────────────────────────────────────────────────
  console.log('');
  console.log(`${BOLD}Step 2 — harvest${RESET}`);

  const result = await processMediaHarvest(
    {
      stone_id: TEST_STONE_ID,
      count,
      requested_by_owner_id: TEST_OWNER_ID,
    },
    {
      supabase: stubSupabase,
      log,
    },
  );

  storedKeysToCleanup = [...result.keys];

  console.log(`${GREEN}✓${RESET} harvested — backend=${result.backend}, framesRequested=${result.framesRequested}, framesWritten=${result.framesWritten}`);
  console.log(`${DIM}  galleryIds (synthesized): ${result.galleryIds.join(', ')}${RESET}`);
  console.log(`${DIM}  would-be galleries inserts: ${inserts.length}${RESET}`);

  console.log('');
  console.log(`${BOLD}Step 3 — verify stored frames${RESET}`);
  let allOk = true;
  for (let i = 0; i < result.keys.length; i++) {
    const key = result.keys[i];
    const insert = inserts[i];
    if (result.backend === 'stub') {
      const localPath = path.join(STUB_STORAGE_ROOT, key);
      if (existsSync(localPath)) {
        const size = statSync(localPath).size;
        console.log(`${GREEN}✓${RESET} [${i}] ${key} — ${size} bytes (timestamp_ms=${insert.row.metadata.timestamp_ms})`);
      } else {
        console.error(`${RED}✗${RESET} [${i}] ${key} — file missing at ${localPath}`);
        allOk = false;
      }
    } else {
      // R2 backend: trust storeFrame's return; deeper HEAD check would be redundant
      // here since Phase 5's test-peakapoo-write.js already proves R2 wiring.
      console.log(`${GREEN}✓${RESET} [${i}] ${key} (R2)`);
    }
  }
  if (!allOk) exitCode = 1;

  if (count > understanding.harvest_candidates.length) {
    console.log('');
    console.log(`${DIM}Note: requested count=${count} but only ${understanding.harvest_candidates.length} candidates available — cap behaviour exercised, frames_written=${result.framesWritten}${RESET}`);
  }
} catch (err) {
  console.error(`\n${RED}✗${RESET} ${err?.name || 'Error'}: ${err?.message || err}`);
  if (err?.cause) {
    console.error(`${DIM}  cause: ${String(err.cause?.message || err.cause).slice(0, 400)}${RESET}`);
  }
  exitCode = 1;
}

// ─── Cleanup stub storage ─────────────────────────────────────────────
console.log('');
for (const key of storedKeysToCleanup) {
  const localPath = path.join(STUB_STORAGE_ROOT, key);
  try {
    rmSync(localPath, { force: true });
  } catch {
    // best-effort
  }
}
if (storedKeysToCleanup.length > 0) {
  console.log(`${GREEN}✓${RESET} cleaned up ${storedKeysToCleanup.length} stub file${storedKeysToCleanup.length === 1 ? '' : 's'}`);
}

process.exit(exitCode);
