import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import ffmpegPath from 'ffmpeg-static';
import { createLogger } from '../../logger.js';
import { MediaPipelineError } from '../errors.js';

const log = createLogger('extract-audio');

const STDERR_TAIL_LINES = 10;
const STDERR_BUFFER_CAP_BYTES = 256 * 1024;

/**
 * Extract a small mono mp3 from a video file. Settings (mono / 16 kHz / 32 kbps)
 * are tuned for Whisper: max ~104 minutes fits inside Whisper's 25 MB upload cap,
 * with no perceptible loss for speech-to-text.
 *
 * @param {string} videoPath - source video file
 * @param {string} audioPath - destination mp3 file (overwritten if exists)
 * @returns {Promise<{ audio_path: string, size_bytes: number }>}
 */
export async function extractAudio(videoPath, audioPath) {
  if (!ffmpegPath) {
    throw new MediaPipelineError('ffmpeg-static did not provide a binary path');
  }

  log.info({ msg: 'extract-audio:start', videoPath, audioPath });

  const args = [
    '-i', videoPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'libmp3lame',
    '-b:a', '32k',
    '-y',
    audioPath,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderrBytes = 0;
    const stderrChunks = [];
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= STDERR_BUFFER_CAP_BYTES) stderrChunks.push(chunk);
    });

    child.on('error', (err) => {
      log.error({ msg: 'extract-audio:spawn-failed', err });
      reject(new MediaPipelineError(`ffmpeg spawn failed: ${err.message}`, { cause: err }));
    });

    child.on('close', (code) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        const tail = stderr.split(/\r?\n/).slice(-STDERR_TAIL_LINES).join('\n');
        log.error({ msg: 'extract-audio:failed', code, stderrTail: tail });
        reject(new MediaPipelineError(
          `ffmpeg exited ${code}\n${tail}`,
          { cause: new Error(stderr) },
        ));
        return;
      }
      let stats;
      try {
        stats = statSync(audioPath);
      } catch (err) {
        reject(new MediaPipelineError(
          `ffmpeg reported success but output missing at ${audioPath}: ${err.message}`,
          { cause: err },
        ));
        return;
      }
      log.info({ msg: 'extract-audio:done', audioPath, sizeBytes: stats.size });
      resolve({ audio_path: audioPath, size_bytes: stats.size });
    });
  });
}
