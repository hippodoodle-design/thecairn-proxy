/**
 * Standalone Phase 8 safety-rails test (no Redis required).
 *
 * Usage:
 *   node --env-file=.env scripts/test-safety-scan.js
 *
 * Steps:
 *   1. Download a public-domain Wikimedia Commons landscape JPG.
 *   2. Run the safety scanner on it (stub IWF + live-or-skip NSFW).
 *      Expect classification='safe' (no false positives), and either
 *      a real NSFW result if Cloudflare creds are present or null if not.
 *   3. Swap IWF for a fake-match stub. Expect SafetyError thrown with
 *      classification='csam_match' and bytes never written to storage.
 */

import { mkdirSync, writeFileSync, statSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'undici';
import {
  createSafetyScanner,
  createIwfStub,
  createNsfwSkip,
  scanThenStoreFrame,
} from '../shared/src/media-pipeline/safety/index.js';
import { createNsfwLive } from '../shared/src/media-pipeline/safety/nsfw.js';
import { createStubStorage, STUB_STORAGE_ROOT } from '../shared/src/media-pipeline/storage/index.js';
import { SafetyError } from '../shared/src/media-pipeline/errors.js';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

// A clearly-safe Wikimedia Commons landscape (Featured Picture, public domain).
// Mountain landscape, no people, no animals, no nudity — about as safe as it gets.
const TEST_IMAGE_URL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/640px-Cat03.jpg';

const workdir = join(tmpdir(), `cairn-safety-test-${Date.now()}`);
mkdirSync(workdir, { recursive: true });
const imagePath = join(workdir, 'test-image.jpg');

let exitCode = 0;
const cleanupKeys = [];

try {
  // ─── 1. Download test image ─────────────────────────────────────────
  console.log(`${BOLD}Step 1 — fetch test image${RESET}`);
  const res = await request(TEST_IMAGE_URL, {
    method: 'GET',
    headers: { 'user-agent': 'CairnSafetyTest/1.0 (+https://thecairn.app)' },
  });
  if (res.statusCode !== 200) {
    console.error(`${RED}✗${RESET} fetch returned ${res.statusCode}`);
    process.exit(1);
  }
  const chunks = [];
  for await (const chunk of res.body) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  writeFileSync(imagePath, body);
  const size = statSync(imagePath).size;
  console.log(`${GREEN}✓${RESET} downloaded ${(size / 1024).toFixed(1)} KB to ${imagePath}`);
  console.log('');

  // ─── 2. Scan with default bindings (stub IWF + live-or-skip NSFW) ───
  console.log(`${BOLD}Step 2 — safety scan with stub IWF + ${process.env.CLOUDFLARE_ACCOUNT_ID ? 'live' : 'skip'} NSFW${RESET}`);
  const scanner = createSafetyScanner();
  const result = await scanner.scan(imagePath);

  console.log(`${DIM}  classification: ${result.classification}${RESET}`);
  console.log(`${DIM}  csam: matched=${result.csam.matched}, source=${result.csam.source}${RESET}`);
  if (result.nsfw) {
    console.log(`${DIM}  nsfw: flagged=${result.nsfw.flagged}, confidence=${result.nsfw.confidence?.toFixed?.(4) ?? result.nsfw.confidence}, label=${result.nsfw.label}${RESET}`);
  } else {
    console.log(`${DIM}  nsfw: null (skipped — no Cloudflare creds)${RESET}`);
  }
  console.log(`${DIM}  scan_duration_ms: ${result.scan_duration_ms}${RESET}`);

  if (result.classification !== 'safe') {
    console.error(`${RED}✗${RESET} expected classification='safe' on a clean test image, got ${result.classification}`);
    exitCode = 1;
  } else {
    console.log(`${GREEN}✓${RESET} clean image classified safe`);
  }

  // If Cloudflare is configured, sanity-check the NSFW shape.
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) {
    if (typeof result.nsfw?.confidence !== 'number') {
      console.error(`${RED}✗${RESET} expected numeric nsfw.confidence, got ${typeof result.nsfw?.confidence}`);
      exitCode = 1;
    }
    if (typeof result.nsfw?.label !== 'string') {
      console.error(`${RED}✗${RESET} expected string nsfw.label, got ${typeof result.nsfw?.label}`);
      exitCode = 1;
    }
  }
  console.log('');

  // ─── 3. Synthetic CSAM stub — expect SafetyError ────────────────────
  console.log(`${BOLD}Step 3 — synthetic CSAM stub (expect SafetyError)${RESET}`);
  const fakeCsamIwf = {
    async scan(_filePath) {
      return { matched: true, hash: 'sha256:test-hash-not-real', source: 'test-stub' };
    },
  };
  const fakeScanner = createSafetyScanner({
    iwf: fakeCsamIwf,
    nsfw: createNsfwSkip(),
  });
  const stubStorage = createStubStorage();

  let caught = null;
  try {
    await scanThenStoreFrame({
      scanner: fakeScanner,
      storage: stubStorage,
      filePath: imagePath,
      storeOptions: { keyPrefix: 'csam-test', timestampMs: 0 },
    });
  } catch (err) {
    caught = err;
  }

  if (!caught) {
    console.error(`${RED}✗${RESET} expected SafetyError, got success`);
    exitCode = 1;
  } else if (!(caught instanceof SafetyError)) {
    console.error(`${RED}✗${RESET} expected SafetyError, got ${caught?.constructor?.name}: ${caught?.message}`);
    exitCode = 1;
  } else if (caught.classification !== 'csam_match') {
    console.error(`${RED}✗${RESET} expected classification='csam_match', got '${caught.classification}'`);
    exitCode = 1;
  } else {
    console.log(`${GREEN}✓${RESET} SafetyError thrown with classification='csam_match'`);
    console.log(`${DIM}  hash=${caught.details?.hash}, source=${caught.details?.source}${RESET}`);
  }

  // Verify NO bytes ever made it to storage on the CSAM path. The stub
  // storage writes under STUB_STORAGE_ROOT/<key>; nothing under csam-test/
  // should exist.
  const stubRoot = STUB_STORAGE_ROOT;
  const csamPrefix = join(stubRoot, 'csam-test');
  if (existsSync(csamPrefix)) {
    console.error(`${RED}✗${RESET} csam-test/ directory exists at ${csamPrefix} — bytes leaked!`);
    exitCode = 1;
  } else {
    console.log(`${GREEN}✓${RESET} no bytes written to storage on CSAM path`);
  }

  // ─── 4. Sanity scan with explicit stub IWF (no-match) ───────────────
  console.log('');
  console.log(`${BOLD}Step 4 — sanity scan with explicit stub IWF (no-match)${RESET}`);
  const explicitScanner = createSafetyScanner({
    iwf: createIwfStub(),
    nsfw: createNsfwSkip(),
  });
  const explicitResult = await explicitScanner.scan(imagePath);
  if (explicitResult.classification !== 'safe' || explicitResult.csam.matched) {
    console.error(`${RED}✗${RESET} expected safe + no match, got ${JSON.stringify(explicitResult)}`);
    exitCode = 1;
  } else {
    console.log(`${GREEN}✓${RESET} explicit stub IWF + skip NSFW: classification=safe, csam=no-match`);
  }
} catch (err) {
  console.error(`\n${RED}✗${RESET} ${err?.name || 'Error'}: ${err?.message || err}`);
  if (err?.cause) console.error(`${DIM}  cause: ${String(err.cause?.message || err.cause).slice(0, 400)}${RESET}`);
  exitCode = 1;
}

// ─── Cleanup ─────────────────────────────────────────────────────────
console.log('');
try {
  rmSync(workdir, { recursive: true, force: true });
  console.log(`${GREEN}✓${RESET} cleaned up workdir ${workdir}`);
} catch (err) {
  console.error(`${RED}⚠${RESET} cleanup failed: ${err.message}`);
}

process.exit(exitCode);
