import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { createLogger } from '../../logger.js';
import { HarvestError } from '../errors.js';

const log = createLogger('harvest-extract');

const STDERR_BUFFER_CAP_BYTES = 256 * 1024;
const STDERR_TAIL_LINES = 10;

/**
 * @typedef {Object} HarvestCandidate
 * @property {number} frame_index
 * @property {number} timestamp_ms
 * @property {string} reasoning
 *
 * @typedef {Object} HarvestExtractedFrame
 * @property {number} index - 0-based position in the requested timestamps list
 * @property {number} timestamp_ms - the requested timestamp
 * @property {string} file_path - resulting jpg on disk
 */

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const chunks = [];
    let bytes = 0;
    child.stderr.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes <= STDERR_BUFFER_CAP_BYTES) chunks.push(chunk);
    });
    child.on('error', (err) => {
      reject(new HarvestError(`ffmpeg spawn failed: ${err.message}`, { cause: err }));
    });
    child.on('close', (code) => {
      const stderr = Buffer.concat(chunks).toString('utf8');
      if (code !== 0) {
        const tail = stderr.split(/\r?\n/).slice(-STDERR_TAIL_LINES).join('\n');
        reject(new HarvestError(`ffmpeg exited ${code}\n${tail}`, { cause: new Error(stderr) }));
        return;
      }
      resolve(stderr);
    });
  });
}

/**
 * Extract one frame per requested timestamp. Sequential by design — for N ≤ 15
 * the wall time is short, and we avoid throttling decoders that don't share
 * gracefully across processes on smaller machines.
 *
 * @param {string} videoPath
 * @param {string} framesDir
 * @param {number[]} timestampsMs - list of timestamps to sample at
 * @returns {Promise<HarvestExtractedFrame[]>}
 */
export async function extractFramesAtTimestamps(videoPath, framesDir, timestampsMs) {
  if (!ffmpegPath) {
    throw new HarvestError('ffmpeg-static did not provide a binary path');
  }
  if (!Array.isArray(timestampsMs) || timestampsMs.length === 0) {
    throw new HarvestError('extractFramesAtTimestamps: timestampsMs must be a non-empty array');
  }

  mkdirSync(framesDir, { recursive: true });
  log.info({ msg: 'harvest-extract:start', videoPath, framesDir, count: timestampsMs.length });

  const results = [];
  for (let i = 0; i < timestampsMs.length; i++) {
    const tsMs = timestampsMs[i];
    const seconds = Math.max(0, tsMs / 1000);
    const outFile = path.join(
      framesDir,
      `harvest_${String(i).padStart(3, '0')}_${tsMs}.jpg`,
    );

    // -ss before -i = fast input seek; cheap and frame-accurate enough for our purposes.
    await runFfmpeg([
      '-ss', String(seconds),
      '-i', videoPath,
      '-frames:v', '1',
      '-q:v', '5',
      '-vf', 'scale=768:-1',
      '-y',
      outFile,
    ]);

    if (!existsSync(outFile)) {
      throw new HarvestError(
        `harvest-extract: ffmpeg succeeded but no output at ${outFile} (timestampMs=${tsMs})`,
      );
    }

    results.push({ index: i, timestamp_ms: tsMs, file_path: outFile });
  }

  log.info({ msg: 'harvest-extract:done', count: results.length });
  return results;
}
