/**
 * Standalone Phase 3 acquire → extract → transcribe isolation test.
 *
 * Usage:
 *   node --env-file=.env scripts/test-transcribe.js [url]
 *
 * Default url: https://www.youtube.com/watch?v=jNQXAC9IVRw  ("Me at the zoo", 19s)
 *
 * Exits 0 on full success, 1 on any failure. The error class name is printed
 * so callers can see whether SourceUnavailableError / TranscriptionError /
 * MediaPipelineError fired.
 */

import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createYtDlpAcquirer } from '../shared/src/media-pipeline/acquire/yt-dlp.js';
import { extractAudio } from '../shared/src/media-pipeline/transcribe/extract-audio.js';
import { createWhisperTranscriber } from '../shared/src/media-pipeline/transcribe/whisper-openai.js';
import { MediaPipelineError } from '../shared/src/media-pipeline/errors.js';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';

const DEFAULT_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const url = process.argv[2] || DEFAULT_URL;

const workdir = join(tmpdir(), `cairn-media-test-${Date.now()}`);
mkdirSync(workdir, { recursive: true });

console.log(`${DIM}url=${url}${RESET}`);
console.log(`${DIM}workdir=${workdir}${RESET}`);
console.log('');

let exitCode = 0;
try {
  // 1. acquire
  const acquirer = createYtDlpAcquirer();
  const acquired = await acquirer.acquire(url, { workdir });
  console.log(`${GREEN}✓${RESET} acquired ${acquired.file_path} — ${(acquired.size_bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`${DIM}  platform=${acquired.metadata.platform} title=${JSON.stringify(acquired.metadata.title)} duration=${acquired.metadata.duration_seconds}s${RESET}`);

  // 2. extract
  const audioPath = join(workdir, 'audio.mp3');
  const audio = await extractAudio(acquired.file_path, audioPath);
  const audioKb = (audio.size_bytes / 1024).toFixed(1);
  console.log(`${GREEN}✓${RESET} extracted audio — ${audioKb} KB at ${audio.audio_path}`);

  // 3. transcribe
  const transcriber = createWhisperTranscriber();
  const transcript = await transcriber.transcribe(audio.audio_path);
  if (!transcript) {
    console.error(`${RED}✗${RESET} transcriber returned null`);
    exitCode = 1;
  } else {
    console.log(`${GREEN}✓${RESET} transcribed — language=${transcript.language}, segments=${transcript.segments.length}`);
    console.log('');
    console.log('full_text:');
    console.log(transcript.full_text);
    console.log('');
    console.log('segments:');
    for (const s of transcript.segments) {
      const start = (s.start_ms / 1000).toFixed(2);
      const end = (s.end_ms / 1000).toFixed(2);
      console.log(`  [${start}s - ${end}s] ${s.text}`);
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

try {
  rmSync(workdir, { recursive: true, force: true });
  console.log(`\n${GREEN}✓${RESET} cleaned up ${workdir}`);
} catch (err) {
  console.error(`\n${RED}⚠${RESET} cleanup failed: ${err.message}`);
}

process.exit(exitCode);
