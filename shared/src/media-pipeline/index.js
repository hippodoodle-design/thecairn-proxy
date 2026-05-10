import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger.js';
import {
  buildStubUnderstandingRecord,
  deriveUnderstandingStatus,
  PIPELINE_VERSION,
} from './schema.js';
import { createYtDlpAcquirer } from './acquire/yt-dlp.js';
import { extractAudio } from './transcribe/extract-audio.js';
import { createWhisperTranscriber } from './transcribe/whisper-openai.js';
import { extractFrames } from './understand/extract-frames.js';
import { createGpt4oUnderstander } from './understand/gpt4o.js';
import { createStubStorage } from './storage/index.js';
import { composeEmbeddingText, createOpenAIEmbedder } from './embedding/index.js';
import { createSafetyScanner, scanThenStoreFrame } from './safety/index.js';

const log = createLogger('media-pipeline');

/**
 * Single public entry point for the media pipeline.
 *
 * Phase 7: real acquire → audio extraction → Whisper transcription → frame
 * extraction (Amanda's 1-per-5s rule) → GPT-4o multimodal understanding →
 * peakapoo write → embedding generation → understanding_status decision.
 * Populates the full UnderstandingRecord including embedding[] and
 * understanding_status.
 *
 * Steward cleanup: a per-call workdir under os.tmpdir() is removed in finally.
 *
 * @param {string} url
 * @param {Object} [options]
 * @param {import('./acquire/index.js').AcquirerBinding} [options.acquirer]
 * @param {import('./transcribe/index.js').TranscriberBinding} [options.transcriber]
 * @param {import('./understand/index.js').UnderstanderBinding} [options.understander]
 * @param {import('./embedding/index.js').EmbeddingBinding} [options.embedder]
 * @param {import('./storage/index.js').StorageBinding} [options.storage]
 * @param {{ maxFrames?: number, vision_detail?: 'low'|'high' }} [options.understandOptions]
 * @param {number} [options.maxDurationSeconds]
 * @returns {Promise<import('./schema.js').UnderstandingRecord>}
 */
export async function processVideoUrl(url, options = {}) {
  const workdir = path.join(tmpdir(), `cairn-media-${randomUUID()}`);
  mkdirSync(workdir, { recursive: true });

  const acquirer = options.acquirer ?? createYtDlpAcquirer();
  const transcriber = options.transcriber ?? createWhisperTranscriber();
  const understander = options.understander ?? createGpt4oUnderstander();
  const storage = options.storage ?? createStubStorage();
  const embedder = options.embedder ?? createOpenAIEmbedder();
  const safetyScanner = options.safetyScanner ?? createSafetyScanner();
  const understandOptions = options.understandOptions ?? {};

  log.info({ msg: 'media-pipeline:start', url, pipelineVersion: PIPELINE_VERSION, workdir });

  try {
    const acquired = await acquirer.acquire(url, {
      workdir,
      maxDurationSeconds: options.maxDurationSeconds,
    });

    const audio = await extractAudio(
      acquired.file_path,
      path.join(workdir, 'audio.mp3'),
    );

    const transcript = await transcriber.transcribe(audio.audio_path);

    const frameOptions = {};
    if (typeof understandOptions.maxFrames === 'number') {
      frameOptions.maxFrames = understandOptions.maxFrames;
    }
    const frames = await extractFrames(
      acquired.file_path,
      path.join(workdir, 'frames'),
      frameOptions,
    );

    const understanding = await understander.understand(
      {
        frames,
        transcript,
        sourceMetadata: {
          duration_seconds: acquired.metadata.duration_seconds,
          title: acquired.metadata.title,
          uploader: acquired.metadata.uploader,
        },
      },
      { vision_detail: understandOptions.vision_detail ?? 'low' },
    );

    const record = buildStubUnderstandingRecord(url);
    record.platform = acquired.metadata.platform;
    record.title = acquired.metadata.title;
    record.uploader = acquired.metadata.uploader;
    record.duration_seconds = acquired.metadata.duration_seconds;
    record.transcript = transcript;
    record.language = transcript?.language ?? 'unknown';
    record.visual_notes = understanding.visual_notes;
    record.summary = understanding.summary;
    record.suggested_tags = understanding.suggested_tags;
    record.video_category = understanding.video_category;

    record.harvest_candidates = (understanding.harvest_candidates || [])
      .map((c) => {
        const frame = frames[c.frame_index];
        if (!frame) return null;
        return {
          frame_index: c.frame_index,
          timestamp_ms: frame.timestamp_ms,
          reasoning: c.reasoning,
        };
      })
      .filter((x) => x !== null);

    if (understanding.peakapoo_frame_index !== null) {
      const frame = frames[understanding.peakapoo_frame_index];

      // Phase 8: scanThenStoreFrame throws SafetyError on csam_match (no bytes
      // go to storage). NSFW flagged → proceed; record.peakapoo.safety carries
      // the result so the worker can queue moderation review after persist.
      const { stored, safety } = await scanThenStoreFrame({
        scanner: safetyScanner,
        storage,
        filePath: frame.file_path,
        storeOptions: { keyPrefix: 'peakapoo', timestampMs: frame.timestamp_ms },
      });

      record.peakapoo = {
        frame_r2_key: stored.key,
        frame_timestamp_ms: frame.timestamp_ms,
        why_this_frame: understanding.peakapoo_reasoning,
        safety,
      };

      log.info({
        msg: 'media-pipeline:peakapoo-stored',
        backend: stored.backend,
        key: stored.key,
        sizeBytes: stored.size_bytes,
        safetyClassification: safety.classification,
      });
    }

    // ── understanding_status ───────────────────────────────────────
    record.understanding_status = deriveUnderstandingStatus(record);
    record.reunderstand_attempted = false;

    // ── embedding ──────────────────────────────────────────────────
    // Skip the embedding call entirely for weak understandings or if
    // composeEmbeddingText returned null — embedding noise hurts quiet
    // connections more than missing data does.
    const embedSource = composeEmbeddingText(record);
    if (record.understanding_status === 'complete' && embedSource) {
      const embedResult = await embedder.embed(embedSource);
      record.embedding = embedResult.vector;
      log.info({
        msg: 'media-pipeline:embedding-done',
        model: embedResult.model,
        dimensions: embedResult.dimensions,
      });
    } else {
      record.embedding = null;
      log.info({
        msg: 'media-pipeline:embedding-skipped',
        status: record.understanding_status,
        hasSourceText: !!embedSource,
      });
    }

    log.info({
      msg: 'media-pipeline:done',
      url,
      platform: record.platform,
      durationSeconds: record.duration_seconds,
      language: record.language,
      category: record.video_category,
      tagsCount: record.suggested_tags.length,
      hasPeakapoo: !!record.peakapoo,
      peakapooKey: record.peakapoo?.frame_r2_key ?? null,
      harvestCount: record.harvest_candidates.length,
      understandingStatus: record.understanding_status,
      hasEmbedding: !!record.embedding,
    });

    return record;
  } finally {
    try {
      rmSync(workdir, { recursive: true, force: true });
      log.debug({ msg: 'media-pipeline:cleanup', workdir });
    } catch (err) {
      log.error({ msg: 'media-pipeline:cleanup-failed', workdir, err });
    }
  }
}

export { PIPELINE_VERSION, deriveUnderstandingStatus } from './schema.js';
export { createYtDlpAcquirer } from './acquire/yt-dlp.js';
export { extractAudio } from './transcribe/extract-audio.js';
export { createWhisperTranscriber, createStubTranscriber } from './transcribe/index.js';
export { extractFrames } from './understand/extract-frames.js';
export { createGpt4oUnderstander, createStubUnderstander } from './understand/index.js';
export { extractFramesAtTimestamps } from './harvest/index.js';
export { composeEmbeddingText, createOpenAIEmbedder, createStubEmbedder } from './embedding/index.js';
export { findSimilarMemories, rankByCosine } from './connections/index.js';
export {
  createSafetyScanner,
  scanThenStoreFrame,
  createIwfStub,
  createIwfLive,
  createNsfwLive,
  createNsfwSkip,
} from './safety/index.js';
export { setStoneStatus, ALLOWED_STATUSES } from './status.js';
