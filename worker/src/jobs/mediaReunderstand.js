import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createYtDlpAcquirer,
  createWhisperTranscriber,
  createGpt4oUnderstander,
  composeEmbeddingText,
  createOpenAIEmbedder,
  createSafetyScanner,
  scanThenStoreFrame,
  deriveUnderstandingStatus,
  setStoneStatus,
  extractAudio,
  extractFrames,
  PIPELINE_VERSION,
} from '@cairn/shared/media-pipeline';
import { createR2Storage, createStubStorage } from '@cairn/shared/media-pipeline/storage';
import { SafetyError } from '@cairn/shared/media-pipeline/errors';
import { buildModerationQueue, buildIncidentQueue } from '@cairn/shared/queue';
import { getServiceClient } from '@cairn/shared/supabase';

const RETRY_FRAMES_PER_SECOND = 1 / 3; // 1 frame per 3 seconds
const RETRY_FRAME_CAP = 250;
const RETRY_FRAME_FLOOR = 3;

function pickStorage() {
  return process.env.R2_ACCOUNT_ID ? createR2Storage() : createStubStorage();
}

function computeRetryFrameCap(durationSec) {
  const target = Math.ceil(durationSec * RETRY_FRAMES_PER_SECOND);
  return Math.max(RETRY_FRAME_FLOOR, Math.min(RETRY_FRAME_CAP, target));
}

/**
 * Pure-ish re-understand core. Caller may inject supabase/storage/acquirer/
 * understander/embedder for tests; otherwise live clients are used.
 *
 * Steps (per spec):
 *  1. Load stone, validate kind='video' + understanding_status='weak' +
 *     not previously re-understood.
 *  2. Re-acquire source video.
 *  3. Extract frames at retry density (1-per-3s, capped 250) — overrides
 *     Amanda's 1-per-5s default.
 *  4. Run understander with vision_detail='high'.
 *  5. Compute new embedding from the new understanding text.
 *  6. Update stones.metadata.media_pipeline + stones.embedding column.
 *  7. Insert a galleries row for the new peakapoo (old peakapoo's R2 key
 *     becomes orphan; Steward sweeps separately).
 *
 * Phase 9c — Delta 2: writes media_pipeline.status='harvesting' at job
 * start (Delta 2 §1: 'harvesting' is a generic worker-busy marker, used
 * for both harvest-more AND reunderstand). On success, the wholesale
 * media_pipeline replacement at step 6 sets status:'complete' explicitly
 * — we DON'T rely on the {...mp} spread to carry it forward, because
 * `mp` was read at step 1 before we wrote 'harvesting' so the spread
 * could pick up whatever status was there before.
 *
 * @param {{ stone_id: string, requested_by_owner_id: string }} input
 * @param {Object} [options]
 * @returns {Promise<{ stoneId: string, framesUsed: number, understandingStatusBefore: string, understandingStatusAfter: string, peakapooKey: string|null, galleryId: string|null, backend: string }>}
 */
export async function processMediaReunderstand(input, options = {}) {
  const { stone_id, requested_by_owner_id } = input || {};
  const log = options.log;
  const supabase = options.supabase ?? getServiceClient();
  const storage = options.storage ?? pickStorage();
  const acquirer = options.acquirer ?? createYtDlpAcquirer();
  const understander = options.understander ?? createGpt4oUnderstander();
  const embedder = options.embedder ?? createOpenAIEmbedder();
  const safetyScanner = options.safetyScanner ?? createSafetyScanner();

  if (!stone_id) throw new Error('stone_id missing from reunderstand payload');
  if (!requested_by_owner_id) throw new Error('requested_by_owner_id missing from reunderstand payload');

  log?.info?.({ msg: 'reunderstand:start', stoneId: stone_id });

  // 1. Load + validate
  const { data: stone, error: stoneErr } = await supabase
    .from('stones')
    .select('id, owner_id, kind, metadata')
    .eq('id', stone_id)
    .single();

  if (stoneErr || !stone) {
    throw new Error(`reunderstand: stone ${stone_id} not found: ${stoneErr?.message || 'no row'}`);
  }
  if (stone.kind !== 'video') {
    throw new Error(`reunderstand: stone ${stone_id} is kind=${stone.kind}, expected 'video'`);
  }
  const mp = stone?.metadata?.media_pipeline;
  if (!mp) throw new Error(`reunderstand: stone ${stone_id} has no media_pipeline metadata`);

  const beforeStatus = mp.understanding_status;
  if (beforeStatus !== 'weak') {
    throw new Error(`reunderstand: stone ${stone_id} status is ${beforeStatus}, expected 'weak'`);
  }
  if (mp.reunderstand_attempted === true) {
    throw new Error(`reunderstand: stone ${stone_id} already retried once; further attempts not offered`);
  }
  const sourceUrl = mp.source_url;
  if (!sourceUrl) throw new Error(`reunderstand: stone ${stone_id} has no media_pipeline.source_url`);

  // Phase 9c — Delta 2: mark 'harvesting' (generic worker-busy marker)
  // before any expensive work. Throws on RPC error.
  await setStoneStatus(supabase, stone_id, 'harvesting');

  const workdir = path.join(tmpdir(), `cairn-reunderstand-${stone_id}-${randomUUID()}`);
  mkdirSync(workdir, { recursive: true });

  let backend = 'unknown';
  let peakapooKey = null;
  let galleryId = null;
  let framesUsed = 0;
  let afterStatus = beforeStatus;

  try {
    // 2. Re-acquire
    const acquired = await acquirer.acquire(sourceUrl, { workdir });
    log?.info?.({ msg: 'reunderstand:reacquired', stoneId: stone_id, sizeBytes: acquired.size_bytes });

    // 3. Extract frames at denser retry density
    const computedMax = computeRetryFrameCap(acquired.metadata.duration_seconds);
    log?.info?.({
      msg: 'reunderstand:frame-cap',
      durationSec: acquired.metadata.duration_seconds,
      computedMax,
      rule: '1-per-3s',
    });

    const frames = await extractFrames(
      acquired.file_path,
      path.join(workdir, 'frames'),
      { maxFrames: computedMax },
    );
    framesUsed = frames.length;

    // ── audio + transcript reused (cheap; fresh from re-acquired bytes) ──
    const audio = await extractAudio(
      acquired.file_path,
      path.join(workdir, 'audio.mp3'),
    );
    const transcriber = options.transcriber ?? createWhisperTranscriber();
    const transcript = await transcriber.transcribe(audio.audio_path);

    // 4. Understand with high-detail vision
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
      { vision_detail: 'high' },
    );

    // Build a fresh media_pipeline payload, replacing the prior weak one.
    const newMp = { ...mp };
    newMp.platform = acquired.metadata.platform;
    newMp.title = acquired.metadata.title;
    newMp.uploader = acquired.metadata.uploader;
    newMp.duration_seconds = acquired.metadata.duration_seconds;
    newMp.transcript = transcript;
    newMp.language = transcript?.language ?? 'unknown';
    newMp.visual_notes = understanding.visual_notes;
    newMp.summary = understanding.summary;
    newMp.suggested_tags = understanding.suggested_tags;
    newMp.video_category = understanding.video_category;
    newMp.harvest_candidates = (understanding.harvest_candidates || [])
      .map((c) => {
        const f = frames[c.frame_index];
        return f ? { frame_index: c.frame_index, timestamp_ms: f.timestamp_ms, reasoning: c.reasoning } : null;
      })
      .filter(Boolean);

    if (understanding.peakapoo_frame_index !== null) {
      const frame = frames[understanding.peakapoo_frame_index];
      // scanThenStoreFrame throws SafetyError on csam_match — handled by the
      // BullMQ wrapper above. NSFW flagged → stored with safety attached so
      // the wrapper can queue moderation review.
      const { stored, safety } = await scanThenStoreFrame({
        scanner: safetyScanner,
        storage,
        filePath: frame.file_path,
        storeOptions: { keyPrefix: 'peakapoo', timestampMs: frame.timestamp_ms },
      });
      backend = stored.backend;
      peakapooKey = stored.key;
      newMp.peakapoo = {
        frame_r2_key: stored.key,
        frame_timestamp_ms: frame.timestamp_ms,
        why_this_frame: understanding.peakapoo_reasoning,
        safety,
      };
    } else {
      newMp.peakapoo = null;
    }

    // 5. Status + embedding from the new understanding
    const statusInput = {
      video_category: newMp.video_category,
      summary: newMp.summary,
      visual_notes: newMp.visual_notes,
    };
    afterStatus = deriveUnderstandingStatus(statusInput);
    newMp.understanding_status = afterStatus;
    newMp.reunderstand_attempted = true;
    newMp.processing = {
      ...(newMp.processing || {}),
      completed_at: new Date().toISOString(),
      pipeline_version: PIPELINE_VERSION,
      reunderstood_at: new Date().toISOString(),
    };

    let newEmbedding = null;
    const embedSource = composeEmbeddingText({
      summary: newMp.summary,
      visual_notes: newMp.visual_notes,
      suggested_tags: newMp.suggested_tags,
    });
    if (afterStatus === 'complete' && embedSource) {
      const embedResult = await embedder.embed(embedSource);
      newEmbedding = embedResult.vector;
      newMp.embedding = newEmbedding;
    } else {
      newMp.embedding = null;
    }

    // Phase 9c — Delta 2: explicit four-state status. Set HERE, not via
    // the {...mp} spread — `mp` was read at step 1 before we wrote
    // 'harvesting', so the spread carries a stale value. Defence in depth
    // against the route-level concurrency gate (which already prevents
    // most overlap with a concurrent harvest).
    newMp.status = 'complete';

    // 6. Persist: stones.metadata + stones.embedding + stones.safety_status
    const safetyResult = newMp.peakapoo?.safety ?? null;
    const newSafetyStatus = safetyResult?.classification === 'flagged' ? 'flagged' : 'safe';

    const metadataUpdate = { ...stone.metadata, media_pipeline: newMp };
    const updateRow = { metadata: metadataUpdate, safety_status: newSafetyStatus };
    if (newEmbedding) updateRow.embedding = newEmbedding;
    else updateRow.embedding = null;

    const { error: updateErr } = await supabase
      .from('stones')
      .update(updateRow)
      .eq('id', stone.id);

    if (updateErr) {
      throw new Error(`reunderstand: stones update failed: ${updateErr.message}`);
    }

    // 7. Insert new galleries row for the new peakapoo (if any). Old peakapoo
    // R2 key remains in storage as an orphan; Steward sweeps separately.
    if (peakapooKey) {
      const galleryRow = {
        owner_id: stone.owner_id,
        stone_id: stone.id,
        kind: 'photo-from-video',
        file_path: peakapooKey,
        mime_type: 'image/jpeg',
        metadata: {
          timestamp_ms: newMp.peakapoo.frame_timestamp_ms,
          why_this_frame: newMp.peakapoo.why_this_frame,
          pipeline_version: PIPELINE_VERSION,
          source: 'reunderstand',
        },
      };
      const { data: gallery, error: galleryErr } = await supabase
        .from('galleries')
        .insert(galleryRow)
        .select('id')
        .single();
      if (galleryErr) {
        log?.error?.({
          msg: 'reunderstand:galleries-insert-failed',
          stoneId: stone.id,
          peakapooKey,
          err: galleryErr,
        });
      } else {
        galleryId = gallery?.id ?? null;
      }

      // NSFW soft-flag → moderation_review_queue row alongside the galleries row
      if (newSafetyStatus === 'flagged') {
        const { error: moderationErr } = await supabase
          .from('moderation_review_queue')
          .insert({
            user_id: stone.owner_id,
            stone_id: stone.id,
            gallery_id: galleryId,
            file_path: peakapooKey,
            classification: safetyResult?.nsfw?.label ?? 'flagged',
            confidence: Number(safetyResult?.nsfw?.confidence ?? 0),
            status: 'pending',
          });
        if (moderationErr) {
          log?.error?.({ msg: 'reunderstand:moderation-insert-failed', stoneId: stone.id, err: moderationErr });
        }
      }
    }

    log?.info?.({
      msg: 'reunderstand:done',
      stoneId: stone.id,
      framesUsed,
      understandingStatusBefore: beforeStatus,
      understandingStatusAfter: afterStatus,
      safetyStatus: newSafetyStatus,
      backend,
      peakapooKey,
    });

    return {
      stoneId: stone.id,
      framesUsed,
      understandingStatusBefore: beforeStatus,
      understandingStatusAfter: afterStatus,
      peakapooKey,
      galleryId,
      backend,
    };
  } finally {
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch (err) {
      log?.error?.({ msg: 'reunderstand:cleanup-failed', workdir, err });
    }
  }
}

/**
 * BullMQ handler for 'media-reunderstand' jobs.
 *
 * Phase 9c — Delta 2: on terminal job failure, the worker.js failed-event
 * handler writes media_pipeline.status='failed' (only after BullMQ has
 * exhausted its retries). Transient failures during retry leave the row
 * at 'harvesting' so the next attempt rewrites cleanly.
 */
export async function mediaReunderstand(job, log) {
  const jobLog = log.child({ jobId: job.id });
  jobLog.info({ msg: 'media-reunderstand:start', jobId: job.id, data: job.data });

  await job.updateProgress({ stage: 'starting', percent: 5 });

  try {
    const result = await processMediaReunderstand(job.data, { log: jobLog });
    await job.updateProgress({ stage: 'complete', percent: 100 });

    jobLog.info({
      msg: 'media-reunderstand:done',
      jobId: job.id,
      stoneId: result.stoneId,
      framesUsed: result.framesUsed,
      statusBefore: result.understandingStatusBefore,
      statusAfter: result.understandingStatusAfter,
      backend: result.backend,
    });

    return result;
  } catch (err) {
    if (err instanceof SafetyError && err.classification === 'csam_match') {
      const { stone_id } = job.data || {};
      return await handleReunderstandCsamMatch({ err, stoneId: stone_id, jobLog });
    }
    throw err;
  }
}

async function handleReunderstandCsamMatch({ err, stoneId, jobLog }) {
  const supabase = getServiceClient();
  const { data: stone, error: stoneReadErr } = await supabase
    .from('stones')
    .select('id, owner_id, metadata')
    .eq('id', stoneId)
    .single();

  if (stoneReadErr || !stone) {
    jobLog.error({ msg: 'reunderstand-csam:stone-read-failed', stoneId, err: stoneReadErr });
    throw new Error(`reunderstand-csam: stone ${stoneId} read failed`);
  }

  // Phase 9c — Delta 2: status:'failed' folded into the same .update so
  // safety_status, blocked_reason, embedding=null, and the four-state
  // pipeline marker all flip atomically. We deliberately don't call
  // setStoneStatus separately — one write, one transaction.
  const blockedAt = new Date().toISOString();
  const newMeta = {
    ...stone.metadata,
    media_pipeline: {
      ...(stone.metadata?.media_pipeline ?? {}),
      blocked_reason: 'csam-detected-during-reunderstand',
      blocked_at: blockedAt,
      safety_details: err.details,
      reunderstand_attempted: true,
      status: 'failed',
    },
  };
  const { error: updateErr } = await supabase
    .from('stones')
    .update({ metadata: newMeta, safety_status: 'blocked', embedding: null })
    .eq('id', stoneId);
  if (updateErr) {
    jobLog.error({ msg: 'reunderstand-csam:stones-update-failed', stoneId, err: updateErr });
  }

  const incidentRow = {
    user_id: stone.owner_id,
    stone_id: stoneId,
    type: 'csam',
    detected_at: err.details?.scanned_at ?? blockedAt,
    hash_data: { hash: err.details?.hash ?? null, source: err.details?.source ?? null },
    notes: 'detected during reunderstand retry',
  };
  const { data: incidentInsert, error: incidentErr } = await supabase
    .from('incidents')
    .insert(incidentRow)
    .select('id')
    .single();
  if (incidentErr) {
    jobLog.error({ msg: 'reunderstand-csam:incidents-insert-failed', stoneId, err: incidentErr });
  }
  const incidentId = incidentInsert?.id ?? null;

  try {
    const moderationQueue = buildModerationQueue();
    await moderationQueue.add('media-suspend-user', {
      user_id: stone.owner_id,
      reason: 'csam-detected-during-reunderstand',
      incident_id: incidentId,
    });
  } catch (qErr) {
    jobLog.error({ msg: 'reunderstand-csam:enqueue-suspend-failed', err: qErr });
  }
  if (incidentId) {
    try {
      const incidentQueue = buildIncidentQueue();
      await incidentQueue.add('media-report-incident', { incident_id: incidentId });
    } catch (qErr) {
      jobLog.error({ msg: 'reunderstand-csam:enqueue-report-failed', err: qErr });
    }
  }

  jobLog.error({ msg: 'media-reunderstand:csam-blocked', stoneId, incidentId });

  return { stoneId, blocked: true, incidentId, safetyStatus: 'blocked' };
}
