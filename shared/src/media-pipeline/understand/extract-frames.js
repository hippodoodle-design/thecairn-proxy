import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { createLogger } from '../../logger.js';
import { MediaPipelineError } from '../errors.js';

const log = createLogger('extract-frames');

const STDERR_BUFFER_CAP_BYTES = 1024 * 1024; // showinfo is verbose
const STDERR_TAIL_LINES = 10;

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
      reject(new MediaPipelineError(`ffmpeg spawn failed: ${err.message}`, { cause: err }));
    });
    child.on('close', (code) => {
      const stderr = Buffer.concat(chunks).toString('utf8');
      if (code !== 0) {
        const tail = stderr.split(/\r?\n/).slice(-STDERR_TAIL_LINES).join('\n');
        reject(new MediaPipelineError(`ffmpeg exited ${code}\n${tail}`, { cause: new Error(stderr) }));
        return;
      }
      resolve(stderr);
    });
  });
}

/**
 * showinfo emits "pts_time:N.NN" once per accepted frame. We pull them in order.
 */
function parsePtsTimes(stderr) {
  const re = /pts_time:([0-9.]+)/g;
  const times = [];
  let m;
  while ((m = re.exec(stderr)) !== null) times.push(Number(m[1]));
  return times;
}

/**
 * Probe duration. ffmpeg with -i and no output exits non-zero but prints
 * "Duration: HH:MM:SS.ss" to stderr — enough for our needs without ffprobe.
 */
async function getDurationSeconds(videoPath) {
  const stderr = await new Promise((resolve) => {
    const child = spawn(ffmpegPath, ['-i', videoPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    const chunks = [];
    child.stderr.on('data', (c) => chunks.push(c));
    child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    child.on('error', () => resolve(''));
  });
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function clearFiles(framesDir, prefix) {
  for (const f of readdirSync(framesDir)) {
    if (f.startsWith(prefix)) {
      try { unlinkSync(path.join(framesDir, f)); } catch {}
    }
  }
}

/**
 * Compute the per-video frame cap using Amanda's rule (locked 9 May 2026):
 *   1 frame per 5 seconds, clamped between 3 and 200.
 *
 * @param {number} durationSec
 * @returns {number}
 */
function computeMaxFrames(durationSec) {
  return Math.max(3, Math.min(200, Math.ceil(durationSec / 5)));
}

/**
 * Extract representative frames from a video.
 *
 * Strategy 1: scene detection (select='gt(scene,T)') — emits a frame whenever
 *             the visual delta crosses the threshold.
 * Strategy 2: interval fallback (fps=N/D) — only when scene detection yielded
 *             fewer than 3 frames AND duration > 10s.
 *
 * Always produces at least minFrames; caps at maxFrames (sampling evenly if
 * scene detection over-shot). When options.maxFrames is omitted the cap is
 * computed from duration via computeMaxFrames.
 *
 * @param {string} videoPath
 * @param {string} framesDir
 * @param {{ maxFrames?: number, minFrames?: number, sceneThreshold?: number }} [options]
 * @returns {Promise<import('./index.js').ExtractedFrame[]>}
 */
export async function extractFrames(videoPath, framesDir, options = {}) {
  if (!ffmpegPath) {
    throw new MediaPipelineError('ffmpeg-static did not provide a binary path');
  }

  const minFrames = options.minFrames ?? 1;
  const sceneThreshold = options.sceneThreshold ?? 0.3;

  mkdirSync(framesDir, { recursive: true });

  // Probe duration up front — both the frame rule and the fallback need it.
  const durationSec = await getDurationSeconds(videoPath);
  const computedMax = computeMaxFrames(durationSec);
  const maxFrames = options.maxFrames ?? computedMax;

  log.info({
    msg: 'extract-frames:start',
    videoPath,
    framesDir,
    durationSec,
    computedMax,
    maxFrames,
    sceneThreshold,
  });

  // Strategy 1 — scene detection
  const sceneArgs = [
    '-i', videoPath,
    '-vf', `select='gt(scene,${sceneThreshold})',scale=768:-1,showinfo`,
    '-vsync', 'vfr',
    '-q:v', '5',
    path.join(framesDir, 'scene_%03d.jpg'),
  ];

  const sceneStderr = await runFfmpeg(sceneArgs);
  const sceneTimes = parsePtsTimes(sceneStderr);
  const sceneFiles = readdirSync(framesDir).filter((f) => f.startsWith('scene_')).sort();

  let frames = sceneFiles.map((file, i) => ({
    index: i,
    timestamp_ms: Math.round((sceneTimes[i] ?? 0) * 1000),
    file_path: path.join(framesDir, file),
  }));

  log.info({ msg: 'extract-frames:scene-result', count: frames.length });

  // Strategy 2 — fallback for non-trivial videos that yielded too few scenes
  if (frames.length < 3 && durationSec > 10) {
    log.info({ msg: 'extract-frames:fallback', sceneCount: frames.length, durationSec });
    clearFiles(framesDir, 'scene_');

    const fps = maxFrames / durationSec;
    const intervalArgs = [
      '-i', videoPath,
      '-vf', `fps=${fps},scale=768:-1`,
      '-q:v', '5',
      path.join(framesDir, 'interval_%03d.jpg'),
    ];
    await runFfmpeg(intervalArgs);

    const intervalFiles = readdirSync(framesDir).filter((f) => f.startsWith('interval_')).sort();
    if (intervalFiles.length === 0) {
      throw new MediaPipelineError('extract-frames: interval fallback produced no frames');
    }
    const slice = durationSec / intervalFiles.length;
    frames = intervalFiles.map((file, i) => ({
      index: i,
      timestamp_ms: Math.round((i + 0.5) * slice * 1000),
      file_path: path.join(framesDir, file),
    }));
  }

  // Cap if scene detection over-shot. Sample evenly across the set, delete the rest.
  if (frames.length > maxFrames) {
    log.info({ msg: 'extract-frames:capping', original: frames.length, max: maxFrames });
    const step = frames.length / maxFrames;
    const dropped = new Set(frames.map((f) => f.file_path));
    const sampled = [];
    for (let i = 0; i < maxFrames; i++) sampled.push(frames[Math.floor(i * step)]);
    for (const keep of sampled) dropped.delete(keep.file_path);
    for (const fp of dropped) {
      try { unlinkSync(fp); } catch {}
    }
    frames = sampled.map((f, i) => ({ ...f, index: i }));
  }

  // Last-resort safety net: ensure at least minFrames. For very short videos
  // with no detected scenes, sample a single frame at the midpoint.
  if (frames.length < minFrames) {
    log.info({ msg: 'extract-frames:safety-net', current: frames.length, durationSec });
    clearFiles(framesDir, 'scene_');
    clearFiles(framesDir, 'interval_');
    const midpoint = Math.max(0, durationSec / 2);
    const safetyArgs = [
      '-ss', String(midpoint),
      '-i', videoPath,
      '-frames:v', '1',
      '-vf', 'scale=768:-1',
      '-q:v', '5',
      path.join(framesDir, 'midpoint_001.jpg'),
    ];
    await runFfmpeg(safetyArgs);
    const got = readdirSync(framesDir).filter((f) => f.startsWith('midpoint_'));
    if (got.length === 0) {
      throw new MediaPipelineError(
        `extract-frames: produced ${frames.length} frames, need at least ${minFrames}`,
      );
    }
    frames = [{
      index: 0,
      timestamp_ms: Math.round(midpoint * 1000),
      file_path: path.join(framesDir, got[0]),
    }];
  }

  log.info({
    msg: 'extract-frames:done',
    count: frames.length,
    firstMs: frames[0].timestamp_ms,
    lastMs: frames[frames.length - 1].timestamp_ms,
  });

  return frames;
}
