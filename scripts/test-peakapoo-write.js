/**
 * Standalone Phase 5 acquire → audio → transcribe → frames → understand →
 * peakapoo write test.
 *
 * Usage:
 *   node --env-file=.env scripts/test-peakapoo-write.js [url]
 *
 * Default url: https://www.youtube.com/watch?v=jNQXAC9IVRw  ("Me at the zoo", 19s)
 *
 * Backend selection:
 *   - If R2_ACCOUNT_ID is set → real R2 (HEAD-verifies after write).
 *   - Else                   → local-filesystem stub (stat-verifies the file).
 */

import { mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createYtDlpAcquirer } from '../shared/src/media-pipeline/acquire/yt-dlp.js';
import { extractAudio } from '../shared/src/media-pipeline/transcribe/extract-audio.js';
import { createWhisperTranscriber } from '../shared/src/media-pipeline/transcribe/whisper-openai.js';
import { extractFrames } from '../shared/src/media-pipeline/understand/extract-frames.js';
import { createGpt4oUnderstander } from '../shared/src/media-pipeline/understand/gpt4o.js';
import {
  createR2Storage,
  createStubStorage,
  STUB_STORAGE_ROOT,
} from '../shared/src/media-pipeline/storage/index.js';
import { MediaPipelineError } from '../shared/src/media-pipeline/errors.js';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

const WHISPER_PER_MIN = 0.006;
const GPT4O_INPUT_PER_1K = 0.0025;
const GPT4O_OUTPUT_PER_1K = 0.010;

const DEFAULT_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const url = process.argv[2] || DEFAULT_URL;

const useR2 = !!process.env.R2_ACCOUNT_ID;
const backend = useR2 ? 'r2' : 'stub';

const workdir = join(tmpdir(), `cairn-media-test-${Date.now()}`);
mkdirSync(workdir, { recursive: true });

console.log(`${DIM}url=${url}${RESET}`);
console.log(`${DIM}workdir=${workdir}${RESET}`);
console.log(`${DIM}backend=${backend}${useR2 ? '' : ' (no R2 env vars present)'}${RESET}`);
console.log('');

let exitCode = 0;
let durationSec = 0;
let frameCount = 0;
let peakapooKey = null;
let peakapooSize = 0;
let peakapooBackend = null;

try {
  const acquirer = createYtDlpAcquirer();
  const acquired = await acquirer.acquire(url, { workdir });
  durationSec = acquired.metadata.duration_seconds;
  console.log(`${GREEN}✓${RESET} acquired ${acquired.file_path} — ${(acquired.size_bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`${DIM}  platform=${acquired.metadata.platform} title=${JSON.stringify(acquired.metadata.title)} duration=${durationSec}s${RESET}`);

  const audio = await extractAudio(acquired.file_path, join(workdir, 'audio.mp3'));
  console.log(`${GREEN}✓${RESET} extracted audio — ${(audio.size_bytes / 1024).toFixed(1)} KB`);

  const transcriber = createWhisperTranscriber();
  const transcript = await transcriber.transcribe(audio.audio_path);
  if (transcript) {
    const head = transcript.full_text.slice(0, 80);
    console.log(`${GREEN}✓${RESET} transcribed — ${transcript.language}, ${transcript.segments.length} segments`);
    console.log(`${DIM}  "${head}${transcript.full_text.length > 80 ? '…' : ''}"${RESET}`);
  }

  const frames = await extractFrames(acquired.file_path, join(workdir, 'frames'));
  frameCount = frames.length;
  console.log(`${GREEN}✓${RESET} extracted ${frames.length} frame${frames.length === 1 ? '' : 's'}`);
  for (const f of frames) {
    console.log(`${DIM}  [${String(f.index).padStart(2)}] ${(f.timestamp_ms / 1000).toFixed(2)}s${RESET}`);
  }

  const understander = createGpt4oUnderstander();
  const understanding = await understander.understand({
    frames,
    transcript,
    sourceMetadata: {
      duration_seconds: durationSec,
      title: acquired.metadata.title,
      uploader: acquired.metadata.uploader,
    },
  });

  console.log('');
  console.log(`${BOLD}UnderstanderResult:${RESET}`);
  console.log(`  ${BOLD}video_category${RESET}     ${understanding.video_category}`);
  console.log(`  ${BOLD}summary${RESET}            ${understanding.summary ?? '(null)'}`);
  console.log(`  ${BOLD}suggested_tags${RESET}     [${understanding.suggested_tags.join(', ')}]`);
  console.log(`  ${BOLD}peakapoo_frame${RESET}     index=${understanding.peakapoo_frame_index}${understanding.peakapoo_frame_index !== null ? ` (t=${(frames[understanding.peakapoo_frame_index].timestamp_ms / 1000).toFixed(2)}s)` : ''}`);
  console.log(`  ${BOLD}peakapoo_reasoning${RESET} ${understanding.peakapoo_reasoning ?? '(null)'}`);

  // ─── Peakapoo write ──────────────────────────────────────────────────
  if (understanding.peakapoo_frame_index === null) {
    console.error(`\n${RED}✗${RESET} understander returned peakapoo_frame_index=null — nothing to write`);
    exitCode = 1;
  } else {
    const storage = useR2 ? createR2Storage() : createStubStorage();
    const chosen = frames[understanding.peakapoo_frame_index];
    const result = await storage.storeFrame(chosen.file_path, {
      keyPrefix: 'peakapoo',
      timestampMs: chosen.timestamp_ms,
    });
    peakapooKey = result.key;
    peakapooSize = result.size_bytes;
    peakapooBackend = result.backend;

    console.log('');
    console.log(`${GREEN}✓${RESET} stored peakapoo — backend=${peakapooBackend}, ${(peakapooSize / 1024).toFixed(1)} KB`);
    console.log(`${DIM}  key=${peakapooKey}${RESET}`);

    // ─── Verify ───────────────────────────────────────────────────────
    if (peakapooBackend === 'r2') {
      const s3 = new S3Client({
        region: 'auto',
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
      });
      const head = await s3.send(new HeadObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: peakapooKey,
      }));
      console.log(`${GREEN}✓${RESET} HEAD verified — ContentLength=${head.ContentLength}, ETag=${head.ETag}`);
    } else {
      const localPath = path.join(STUB_STORAGE_ROOT, peakapooKey);
      if (existsSync(localPath)) {
        const stats = statSync(localPath);
        console.log(`${GREEN}✓${RESET} stub file verified — ${stats.size} bytes at ${localPath}`);
      } else {
        console.error(`${RED}✗${RESET} stub file missing at ${localPath}`);
        exitCode = 1;
      }
    }
  }
} catch (err) {
  console.error(`\n${RED}✗${RESET} ${err?.name || 'Error'}: ${err?.message || err}`);
  if (err instanceof MediaPipelineError && err.cause) {
    const causeMsg = String(err.cause?.message || err.cause).slice(0, 400);
    console.error(`${DIM}  cause: ${causeMsg}${RESET}`);
  }
  if (existsSync(workdir)) {
    const remaining = readdirSync(workdir);
    console.error(`${DIM}  workdir contents at error: ${remaining.length === 0 ? '(empty)' : remaining.join(', ')}${RESET}`);
  }
  exitCode = 1;
}

if (exitCode === 0 && frameCount > 0) {
  const whisperCost = (Math.ceil(durationSec) / 60) * WHISPER_PER_MIN;
  const promptTokensApprox = 600 + frameCount * 85;
  const completionTokensApprox = 400;
  const gpt4oCost =
    (promptTokensApprox / 1000) * GPT4O_INPUT_PER_1K +
    (completionTokensApprox / 1000) * GPT4O_OUTPUT_PER_1K;
  const total = whisperCost + gpt4oCost;
  console.log('');
  console.log(`${DIM}approximate cost — whisper $${whisperCost.toFixed(4)} + gpt-4o $${gpt4oCost.toFixed(4)} ≈ $${total.toFixed(4)} (R2 PUT cost negligible)${RESET}`);
}

try {
  rmSync(workdir, { recursive: true, force: true });
  console.log(`${GREEN}✓${RESET} cleaned up workdir ${workdir}`);
} catch (err) {
  console.error(`${RED}⚠${RESET} cleanup failed: ${err.message}`);
}

process.exit(exitCode);
