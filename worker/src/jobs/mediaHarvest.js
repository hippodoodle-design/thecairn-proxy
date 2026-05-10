import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createYtDlpAcquirer,
  extractFramesAtTimestamps,
  createSafetyScanner,
  scanThenStoreFrame,
  setStoneStatus,
  PIPELINE_VERSION,
} from '@cairn/shared/media-pipeline';
import {
  createR2Storage,
  createStubStorage,
} from '@cairn/shared/media-pipeline/storage';
import { SafetyError } from '@cairn/shared/media-pipeline/errors';
import {
  buildModerationQueue,
  buildIncidentQueue,
} from '@cairn/shared/queue';
import { getServiceClient } from '@cairn/shared/supabase';

const ALLOWED_COUNTS = new Set([5, 10, 15]);

function pickStorage() {
  return process.env.R2_ACCOUNT_ID ? createR2Storage() : createStubStorage();
}

/**
 * Pure-ish harvest core. The caller may inject a supabase client (for tests)
 * and a storage binding (for tests or alternative backends). Otherwise both
 * default to live clients.
 *
 * Loads the source stone, slices the requested top-N harvest_candidates,
 * re-acquires the source video via yt-dlp, extracts frames at the candidate
 * timestamps, writes each to storage, and inserts one galleries row per
 * frame. Workdir is steward-cleaned in finally.
 *
 * Phase 9c — Delta 2: writes media_pipeline.status='harvesting' at job
 * start (after validation, before re-acquire) and 'complete' at job
 * success. The route gate in web/src/routes/media-harvest.js prevents
 * a second harvest/reunderstand from being enqueued while the first is
 * in flight.
 *
 * @param {{ stone_id: string, count: number, requested_by_owner_id: string }} input
 * @param {{ supabase?: any, storage?: import('@cairn/shared/media-pipeline/storage').StorageBinding, log?: any, acquirer?: any }} [options]
 * @returns {Promise<{ stoneId: string, framesRequested: number, framesWritten: number, keys: string[], backend: 'r2'|'stub', galleryIds: string[] }>}
 */
export async function processMediaHarvest(input, options = {}) {
  const { stone_id, count, requested_by_owner_id } = input || {};
  const log = options.log;
  const supabase = options.supabase ?? getServiceClient();
  const storage = options.storage ?? pickStorage();
  const acquirer = options.acquirer ?? createYtDlpAcquirer();
  const safetyScanner = options.safetyScanner ?? createSafetyScanner();

  if (!stone_id) throw new Error('stone_id missing from harvest payload');
  if (!ALLOWED_COUNTS.has(count)) throw new Error(`harvest count must be 5, 10, or 15 (got ${count})`);
  if (!requested_by_owner_id) throw new Error('requested_by_owner_id missing from harvest payload');

  log?.info?.({ msg: 'harvest:start', stoneId: stone_id, count });

  // 1. Load stone
  const { data: stone, error: stoneErr } = await supabase
    .from('stones')
    .select('id, owner_id, kind, metadata')
    .eq('id', stone_id)
    .single();

  if (stoneErr || !stone) {
    throw new Error(`harvest: stone ${stone_id} not found: ${stoneErr?.message || 'no row'}`);
  }
  if (stone.kind !== 'video') {
    throw new Error(`harvest: stone ${stone_id} is kind=${stone.kind}, expected 'video'`);
  }
  const candidates = stone?.metadata?.media_pipeline?.harvest_candidates;
  const sourceUrl = stone?.metadata?.media_pipeline?.source_url;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error(`harvest: stone ${stone_id} has no harvest_candidates`);
  }
  if (!sourceUrl) {
    throw new Error(`harvest: stone ${stone_id} missing source_url`);
  }

  // Phase 9c — Delta 2: mark the row 'harvesting' before any expensive work.
  // The route already wrote 'pending' on enqueue; we overwrite it now that a
  // worker has actually picked the job up. Throws on RPC error — a failed
  // status write is loud rather than silently leaving the row stale.
  await setStoneStatus(supabase, stone_id, 'harvesting');

  // 2. Cap count at available candidates
  const requested = count;
  const chosen = candidates.slice(0, Math.min(count, candidates.length));
  if (chosen.length < requested) {
    log?.info?.({
      msg: 'harvest:cap-applied',
      requested,
      available: candidates.length,
      using: chosen.length,
    });
  }

  // 3. Workdir
  const workdir = path.join(tmpdir(), `cairn-harvest-${stone_id}-${randomUUID()}`);
  mkdirSync(workdir, { recursive: true });

  const keys = [];
  const galleryIds = [];
  let backend = 'unknown';

  try {
    // 4. Re-acquire source video (skip the maxDurationSeconds check — we already
    // ingested it once at original durations; a re-fetch is just to get bytes).
    const acquired = await acquirer.acquire(sourceUrl, { workdir });
    log?.info?.({ msg: 'harvest:reacquired', stoneId: stone_id, sizeBytes: acquired.size_bytes });

    // 5. Extract frames at the chosen timestamps
    const framesDir = path.join(workdir, 'frames');
    const timestamps = chosen.map((c) => c.timestamp_ms);
    const extracted = await extractFramesAtTimestamps(acquired.file_path, framesDir, timestamps);

    // 6+7. Per frame: scan → store → galleries insert. SafetyError on any
    // frame bails the loop; the caller (mediaHarvest BullMQ wrapper) handles
    // CSAM bookkeeping.
    let moderationFlagCount = 0;
    for (let i = 0; i < extracted.length; i++) {
      const frame = extracted[i];
      const candidate = chosen[i];

      const { stored, safety } = await scanThenStoreFrame({
        scanner: safetyScanner,
        storage,
        filePath: frame.file_path,
        storeOptions: { keyPrefix: 'harvest', timestampMs: frame.timestamp_ms },
      });
      backend = stored.backend;
      keys.push(stored.key);

      const galleryRow = {
        owner_id: stone.owner_id,
        stone_id: stone.id,
        kind: 'photo-from-video',
        file_path: stored.key,
        mime_type: 'image/jpeg',
        size_bytes: stored.size_bytes,
        metadata: {
          timestamp_ms: frame.timestamp_ms,
          why_this_frame: candidate.reasoning ?? null,
          pipeline_version: PIPELINE_VERSION,
          source: 'harvest',
          safety,
        },
      };

      const { data: gallery, error: galleryErr } = await supabase
        .from('galleries')
        .insert(galleryRow)
        .select('id')
        .single();

      let galleryId = null;
      if (galleryErr) {
        log?.error?.({
          msg: 'harvest:galleries-insert-failed',
          stoneId: stone_id,
          key: stored.key,
          err: galleryErr,
        });
      } else if (gallery?.id) {
        galleryIds.push(gallery.id);
        galleryId = gallery.id;
      }

      // NSFW soft-flag → moderation_review_queue row
      if (safety.classification === 'flagged') {
        moderationFlagCount += 1;
        const { error: moderationErr } = await supabase
          .from('moderation_review_queue')
          .insert({
            user_id: stone.owner_id,
            stone_id: stone.id,
            gallery_id: galleryId,
            file_path: stored.key,
            classification: safety.nsfw?.label ?? 'flagged',
            confidence: Number(safety.nsfw?.confidence ?? 0),
            status: 'pending',
          });
        if (moderationErr) {
          log?.error?.({ msg: 'harvest:moderation-insert-failed', stoneId: stone_id, err: moderationErr });
        }
      }
    }
    if (moderationFlagCount > 0) {
      log?.info?.({ msg: 'harvest:moderation-flagged', stoneId: stone_id, count: moderationFlagCount });
    }

    // Phase 9c — Delta 2: success — flip back to 'complete'.
    await setStoneStatus(supabase, stone_id, 'complete');

    log?.info?.({
      msg: 'harvest:done',
      stoneId: stone_id,
      framesRequested: requested,
      framesWritten: extracted.length,
      backend,
    });

    return {
      stoneId: stone_id,
      framesRequested: requested,
      framesWritten: extracted.length,
      keys,
      backend,
      galleryIds,
    };
  } finally {
    try {
      rmSync(workdir, { recursive: true, force: true });
    } catch (err) {
      log?.error?.({ msg: 'harvest:cleanup-failed', workdir, err });
    }
  }
}

/**
 * BullMQ handler for 'media-harvest' jobs. Delegates to processMediaHarvest.
 * SafetyError('csam-detected') from any frame in the loop is intercepted here:
 * the existing stones row is marked safety_status='blocked', an incident row
 * is opened, and the suspension + reporting follow-ups are enqueued.
 *
 * Phase 9c — Delta 2: on terminal job failure, the worker.js failed-event
 * handler writes media_pipeline.status='failed' (only after BullMQ has
 * exhausted its retries). Transient failures during retry leave the row
 * at 'harvesting' so the next attempt rewrites cleanly.
 */
export async function mediaHarvest(job, log) {
  const jobLog = log.child({ jobId: job.id });
  jobLog.info({ msg: 'media-harvest:start', jobId: job.id, data: job.data });

  await job.updateProgress({ stage: 'starting', percent: 5 });

  try {
    const result = await processMediaHarvest(job.data, { log: jobLog });
    await job.updateProgress({ stage: 'complete', percent: 100 });

    jobLog.info({
      msg: 'media-harvest:done',
      jobId: job.id,
      stoneId: result.stoneId,
      framesWritten: result.framesWritten,
      framesRequested: result.framesRequested,
      backend: result.backend,
    });

    return result;
  } catch (err) {
    if (err instanceof SafetyError && err.classification === 'csam_match') {
      const { stone_id } = job.data || {};
      return await handleHarvestCsamMatch({ err, stoneId: stone_id, jobLog });
    }
    throw err;
  }
}

async function handleHarvestCsamMatch({ err, stoneId, jobLog }) {
  const supabase = getServiceClient();

  // Read existing stone for owner_id + space_id continuity.
  const { data: stone, error: stoneReadErr } = await supabase
    .from('stones')
    .select('id, owner_id, metadata')
    .eq('id', stoneId)
    .single();

  if (stoneReadErr || !stone) {
    jobLog.error({ msg: 'harvest-csam:stone-read-failed', stoneId, err: stoneReadErr });
    throw new Error(`harvest-csam: stone ${stoneId} read failed`);
  }

  // Mark the existing stone blocked + annotate the metadata so the row tells
  // the truth about what happened.
  //
  // Phase 9c — Delta 2: status:'failed' is folded into the same .update so
  // safety_status, blocked_reason, and the four-state pipeline marker all
  // flip atomically. We deliberately don't call setStoneStatus separately
  // here — one write, one transaction.
  const blockedAt = new Date().toISOString();
  const newMeta = {
    ...stone.metadata,
    media_pipeline: {
      ...(stone.metadata?.media_pipeline ?? {}),
      blocked_reason: 'csam-detected-during-harvest',
      blocked_at: blockedAt,
      safety_details: err.details,
      status: 'failed',
    },
  };
  const { error: updateErr } = await supabase
    .from('stones')
    .update({ metadata: newMeta, safety_status: 'blocked' })
    .eq('id', stoneId);
  if (updateErr) {
    jobLog.error({ msg: 'harvest-csam:stones-update-failed', stoneId, err: updateErr });
  }

  const incidentRow = {
    user_id: stone.owner_id,
    stone_id: stoneId,
    type: 'csam',
    detected_at: err.details?.scanned_at ?? blockedAt,
    hash_data: { hash: err.details?.hash ?? null, source: err.details?.source ?? null },
    notes: 'detected during harvest re-extraction',
  };
  const { data: incidentInsert, error: incidentErr } = await supabase
    .from('incidents')
    .insert(incidentRow)
    .select('id')
    .single();
  if (incidentErr) {
    jobLog.error({ msg: 'harvest-csam:incidents-insert-failed', stoneId, err: incidentErr });
  }
  const incidentId = incidentInsert?.id ?? null;

  try {
    const moderationQueue = buildModerationQueue();
    await moderationQueue.add('media-suspend-user', {
      user_id: stone.owner_id,
      reason: 'csam-detected-during-harvest',
      incident_id: incidentId,
    });
  } catch (qErr) {
    jobLog.error({ msg: 'harvest-csam:enqueue-suspend-failed', err: qErr });
  }
  if (incidentId) {
    try {
      const incidentQueue = buildIncidentQueue();
      await incidentQueue.add('media-report-incident', { incident_id: incidentId });
    } catch (qErr) {
      jobLog.error({ msg: 'harvest-csam:enqueue-report-failed', err: qErr });
    }
  }

  jobLog.error({ msg: 'media-harvest:csam-blocked', stoneId, incidentId });

  return { stoneId, blocked: true, incidentId, safetyStatus: 'blocked' };
}
