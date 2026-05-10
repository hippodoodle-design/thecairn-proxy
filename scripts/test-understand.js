/**
 * Standalone Phase 4 acquire → audio → transcribe → frames → understand test.
 *
 * Usage:
 *   node --env-file=.env scripts/test-understand.js [url]
 *
 * Default url: https://www.youtube.com/watch?v=jNQXAC9IVRw  ("Me at the zoo", 19s)
 *
 * Exits 0 on full success, 1 on any failure. Prints an approximate cost based
 * on whisper-1 + gpt-4o vision pricing as of Jan 2026.
 */

import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createYtDlpAcquirer } from '../shared/src/media-pipeline/acquire/yt-dlp.js';
import { extractAudio } from '../shared/src/media-pipeline/transcribe/extract-audio.js';
import { createWhisperTranscriber } from '../shared/src/media-pipeline/transcribe/whisper-openai.js';
import { extractFrames } from '../shared/src/media-pipeline/understand/extract-frames.js';
import { createGpt4oUnderstander } from '../shared/src/media-pipeline/understand/gpt4o.js';
import { MediaPipelineError } from '../shared/src/media-pipeline/errors.js';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

// Pricing (Jan 2026)
const WHISPER_PER_MIN = 0.006;
const GPT4O_INPUT_PER_1K = 0.0025;
const GPT4O_OUTPUT_PER_1K = 0.010;

const DEFAULT_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const url = process.argv[2] || DEFAULT_URL;

const workdir = join(tmpdir(), `cairn-media-test-${Date.now()}`);
mkdirSync(workdir, { recursive: true });

console.log(`${DIM}url=${url}${RESET}`);
console.log(`${DIM}workdir=${workdir}${RESET}`);
console.log('');

let exitCode = 0;
let durationSec = 0;
let frameCount = 0;
let usage = null;

try {
  // 1. Acquire
  const acquirer = createYtDlpAcquirer();
  const acquired = await acquirer.acquire(url, { workdir });
  durationSec = acquired.metadata.duration_seconds;
  console.log(`${GREEN}✓${RESET} acquired ${acquired.file_path} — ${(acquired.size_bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`${DIM}  platform=${acquired.metadata.platform} title=${JSON.stringify(acquired.metadata.title)} duration=${durationSec}s${RESET}`);

  // 2. Extract audio
  const audio = await extractAudio(acquired.file_path, join(workdir, 'audio.mp3'));
  console.log(`${GREEN}✓${RESET} extracted audio — ${(audio.size_bytes / 1024).toFixed(1)} KB`);

  // 3. Transcribe
  const transcriber = createWhisperTranscriber();
  const transcript = await transcriber.transcribe(audio.audio_path);
  if (transcript) {
    const head = transcript.full_text.slice(0, 80);
    console.log(`${GREEN}✓${RESET} transcribed — language=${transcript.language}, ${transcript.segments.length} segments`);
    console.log(`${DIM}  "${head}${transcript.full_text.length > 80 ? '…' : ''}"${RESET}`);
  } else {
    console.log(`${DIM}  no transcript${RESET}`);
  }

  // 4. Extract frames
  const frames = await extractFrames(acquired.file_path, join(workdir, 'frames'));
  frameCount = frames.length;
  console.log(`${GREEN}✓${RESET} extracted ${frames.length} frame${frames.length === 1 ? '' : 's'}`);
  for (const f of frames) {
    const sec = (f.timestamp_ms / 1000).toFixed(2);
    console.log(`${DIM}  [${String(f.index).padStart(2)}] ${sec}s — ${f.file_path}${RESET}`);
  }

  // 5. Understand
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

  // Best-effort: capture the most recent usage from the OpenAI client logs
  // wasn't surfaced via the binding. We compute cost from token estimates below
  // using max_tokens upper bound and frame count.

  console.log('');
  console.log(`${BOLD}UnderstanderResult:${RESET}`);
  console.log(`  ${BOLD}video_category${RESET}     ${understanding.video_category}`);
  console.log(`  ${BOLD}summary${RESET}            ${understanding.summary ?? '(null)'}`);
  console.log(`  ${BOLD}visual_notes${RESET}       ${understanding.visual_notes ?? '(null)'}`);
  console.log(`  ${BOLD}suggested_tags${RESET}     [${understanding.suggested_tags.join(', ')}]`);
  console.log(`  ${BOLD}peakapoo_frame${RESET}     index=${understanding.peakapoo_frame_index}${understanding.peakapoo_frame_index !== null ? ` (t=${(frames[understanding.peakapoo_frame_index].timestamp_ms / 1000).toFixed(2)}s)` : ''}`);
  console.log(`  ${BOLD}peakapoo_reasoning${RESET} ${understanding.peakapoo_reasoning ?? '(null)'}`);
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

// Approximate cost (no exact usage from the binding — estimate from inputs).
if (exitCode === 0) {
  // Whisper: $0.006 / minute, rounded up to the nearest second.
  const whisperCost = (Math.ceil(durationSec) / 60) * WHISPER_PER_MIN;
  // GPT-4o vision low-detail: 85 tokens per image. Plus ~600 tokens of system+intro+transcript.
  // Output: max 800 tokens.
  const promptTokensApprox = 600 + frameCount * 85;
  const completionTokensApprox = 400; // typical, well under max
  const gpt4oCost =
    (promptTokensApprox / 1000) * GPT4O_INPUT_PER_1K +
    (completionTokensApprox / 1000) * GPT4O_OUTPUT_PER_1K;
  const total = whisperCost + gpt4oCost;
  console.log('');
  console.log(`${DIM}approximate cost — whisper $${whisperCost.toFixed(4)} + gpt-4o $${gpt4oCost.toFixed(4)} ≈ $${total.toFixed(4)}${RESET}`);
}

try {
  rmSync(workdir, { recursive: true, force: true });
  console.log(`${GREEN}✓${RESET} cleaned up ${workdir}`);
} catch (err) {
  console.error(`${RED}⚠${RESET} cleanup failed: ${err.message}`);
}

process.exit(exitCode);
