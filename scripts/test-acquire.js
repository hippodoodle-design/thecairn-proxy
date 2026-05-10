/**
 * Standalone Phase 2 acquirer isolation test. No Redis, no Supabase, no Express.
 *
 * Usage:
 *   node --env-file=.env scripts/test-acquire.js [url] [maxDurationSeconds]
 *
 * Defaults:
 *   url                  https://www.youtube.com/watch?v=jNQXAC9IVRw  ("Me at the zoo", 19s)
 *   maxDurationSeconds   3600 (DEFAULT_MAX_DURATION_SECONDS)
 *
 * Exits 0 on success, 1 on any failure. The error class name is printed so
 * callers can see whether SourceUnavailableError / TooLongError / etc. fired.
 */

import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createYtDlpAcquirer } from '../shared/src/media-pipeline/acquire/yt-dlp.js';
import { DEFAULT_MAX_DURATION_SECONDS } from '../shared/src/media-pipeline/acquire/index.js';
import { MediaPipelineError } from '../shared/src/media-pipeline/errors.js';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';

const DEFAULT_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

const url = process.argv[2] || DEFAULT_URL;
const maxArg = process.argv[3];
const maxDurationSeconds = maxArg !== undefined ? Number(maxArg) : DEFAULT_MAX_DURATION_SECONDS;

if (Number.isNaN(maxDurationSeconds) || maxDurationSeconds <= 0) {
  console.error(`${RED}invalid maxDurationSeconds:${RESET} ${maxArg}`);
  process.exit(2);
}

const workdir = join(tmpdir(), `cairn-media-test-${Date.now()}`);
mkdirSync(workdir, { recursive: true });

console.log(`${DIM}url=${url}${RESET}`);
console.log(`${DIM}maxDurationSeconds=${maxDurationSeconds}${RESET}`);
console.log(`${DIM}workdir=${workdir}${RESET}`);
console.log('');

const acquirer = createYtDlpAcquirer();

let exitCode = 0;
try {
  const result = await acquirer.acquire(url, { workdir, maxDurationSeconds });

  console.log('AcquirerResult:');
  console.log(JSON.stringify(result, null, 2));

  if (!existsSync(result.file_path)) {
    console.error(`\n${RED}✗${RESET} file not found at ${result.file_path}`);
    exitCode = 1;
  } else {
    const sizeMb = (result.size_bytes / 1024 / 1024).toFixed(2);
    console.log(`\n${GREEN}✓${RESET} file exists at ${result.file_path} — ${sizeMb} MB`);
  }
} catch (err) {
  console.error(`\n${RED}✗${RESET} ${err?.name || 'Error'}: ${err?.message || err}`);
  if (err instanceof MediaPipelineError && err.cause) {
    const causeMsg = String(err.cause?.message || err.cause).slice(0, 300);
    console.error(`${DIM}  cause: ${causeMsg}${RESET}`);
  }
  if (existsSync(workdir)) {
    const remaining = readdirSync(workdir);
    const note = remaining.length === 0
      ? '(empty — no download attempted)'
      : remaining.join(', ');
    console.error(`${DIM}  workdir contents at error: ${note}${RESET}`);
  }
  exitCode = 1;
}

try {
  rmSync(workdir, { recursive: true, force: true });
  console.log(`${GREEN}✓${RESET} cleaned up ${workdir}`);
} catch (err) {
  console.error(`${RED}⚠${RESET} cleanup failed: ${err.message}`);
}

process.exit(exitCode);
