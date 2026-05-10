import {
  processVideoUrl,
  PIPELINE_VERSION,
} from '@cairn/shared/media-pipeline';
import { createR2Storage, createStubStorage } from '@cairn/shared/media-pipeline/storage';
import { SafetyError } from '@cairn/shared/media-pipeline/errors';
import {
  buildModerationQueue,
  buildIncidentQueue,
} from '@cairn/shared/queue';
import { getServiceClient } from '@cairn/shared/supabase';

/**
 * Job processor for 'media-ingest'.
 *
 * Phase 8 flow:
 *   1. Pick storage backend.
 *   2. Run processVideoUrl. The pipeline now scans every frame about to be
 *      written; CSAM match raises SafetyError BEFORE any bytes hit storage.
 *   3a. SafetyError('csam-detected'): insert a stones row with
 *       safety_status='blocked' (no peakapoo, no embedding), insert an
 *       incidents row, enqueue suspension + reporting jobs. Return.
 *   3b. Successful return: insert stones row with safety_status='safe' or
 *       'flagged' depending on NSFW outcome. Insert galleries row for the
 *       peakapoo. If flagged, also enqueue a moderation_review_queue row.
 *
 * Phase 9c — Delta 2: rows are born with media_pipeline.status set —
 * 'complete' on the success path, 'failed' on the CSAM-blocked path.
 * Both go inside the row's initial INSERT so the field is always
 * present from the moment the row exists. We don't write 'pending' or
 * 'harvesting' in this worker because the row doesn't exist before
 * the pipeline runs (the four-state map only describes follow-on
 * jobs against an existing row — see Delta 2 proposal §2).
 */
export async function mediaIngest(job, log) {
  const jobStart = Date.now();
  const { url, ownerId, spaceId } = job.data || {};
  const jobLog = log.child({ jobId: job.id });

  if (!ownerId) throw new Error('ownerId missing from job payload');
  if (!url) throw new Error('url missing from job payload');

  jobLog.info({ msg: 'media-ingest:start', jobId: job.id, url, ownerId });
  await job.updateProgress({ stage: 'processing', percent: 5 });

  const useR2 = !!process.env.R2_ACCOUNT_ID;
  const storage = useR2 ? createR2Storage() : createStubStorage();
  jobLog.info({ msg: 'media-ingest:storage', backend: useR2 ? 'r2' : 'stub' });

  const supabase = getServiceClient();

  let understanding;
  try {
    understanding = await processVideoUrl(url, { storage });
  } catch (err) {
    if (err instanceof SafetyError && err.classification === 'csam_match') {
      return await handleCsamMatch({
        err, url, ownerId, spaceId, supabase, jobLog, jobStart,
      });
    }
    throw err;
  }

  await job.updateProgress({ stage: 'persisting', percent: 80 });

  const safetyResult = understanding.peakapoo?.safety ?? null;
  const safetyStatus = safetyResult?.classification === 'flagged' ? 'flagged' : 'safe';

  const stonesRow = {
    owner_id: ownerId,
    space_id: spaceId ?? null,
    kind: 'video',
    content_url: url,
    metadata: {
      // Born 'complete'. Phase 9c — Delta 2: the four-state status field
      // is set as part of the initial INSERT so callers reading this row
      // always see one of the four allowed values, never undefined.
      media_pipeline: { ...understanding, status: 'complete' },
    },
    embedding: understanding.embedding ?? null,
    safety_status: safetyStatus,
  };

  const { data: stoneInsert, error: stoneErr } = await supabase
    .from('stones')
    .insert(stonesRow)
    .select('id')
    .single();

  if (stoneErr) {
    jobLog.error({ msg: 'supabase stones insert failed', err: stoneErr });
    throw new Error(`Supabase stones insert failed: ${stoneErr.message}`);
  }
  const stoneId = stoneInsert.id;

  let galleryId = null;
  let moderationQueueId = null;
  const peakapooKey = understanding.peakapoo?.frame_r2_key ?? null;

  if (peakapooKey) {
    const galleryRow = {
      owner_id: ownerId,
      stone_id: stoneId,
      kind: 'photo-from-video',
      file_path: peakapooKey,
      mime_type: 'image/jpeg',
      metadata: {
        timestamp_ms: understanding.peakapoo.frame_timestamp_ms,
        why_this_frame: understanding.peakapoo.why_this_frame,
        pipeline_version: PIPELINE_VERSION,
      },
    };

    const { data: gallery, error: galleryErr } = await supabase
      .from('galleries')
      .insert(galleryRow)
      .select('id')
      .single();

    if (galleryErr) {
      jobLog.error({ msg: 'galleries insert failed (stone preserved)', stoneId, peakapooKey, err: galleryErr });
    } else {
      galleryId = gallery.id;
    }

    if (safetyStatus === 'flagged') {
      const moderationRow = {
        user_id: ownerId,
        stone_id: stoneId,
        gallery_id: galleryId,
        file_path: peakapooKey,
        classification: safetyResult?.nsfw?.label ?? 'flagged',
        confidence: Number(safetyResult?.nsfw?.confidence ?? 0),
        status: 'pending',
      };
      const { data: moderation, error: moderationErr } = await supabase
        .from('moderation_review_queue')
        .insert(moderationRow)
        .select('id')
        .single();
      if (moderationErr) {
        jobLog.error({ msg: 'moderation_review_queue insert failed', stoneId, err: moderationErr });
      } else {
        moderationQueueId = moderation.id;
      }
    }
  }

  jobLog.info({
    msg: 'media-ingest:done',
    jobId: job.id,
    stoneId,
    galleryId,
    moderationQueueId,
    peakapooKey,
    safetyStatus,
    durationMs: Date.now() - jobStart,
  });

  await job.updateProgress({ stage: 'complete', percent: 100 });

  return {
    stoneId,
    pipelineVersion: understanding.processing.pipeline_version,
    peakapooKey,
    galleryId,
    moderationQueueId,
    safetyStatus,
  };
}

/**
 * CSAM-match handler. Records the attempt as a 'blocked' stones row (no
 * peakapoo, no embedding), opens an incidents row for the 1-year evidence
 * preservation window, and enqueues the suspension + reporting follow-ups.
 *
 * The job itself returns successfully — the user-facing failure is the
 * stones row's safety_status='blocked' and the absence of any galleries row.
 *
 * Phase 9c — Delta 2: this row is born with media_pipeline.status='failed'
 * inside the same INSERT — the user-facing pipeline did not finish usefully.
 */
async function handleCsamMatch({ err, url, ownerId, spaceId, supabase, jobLog, jobStart }) {
  const blockedAt = new Date().toISOString();

  const stonesRow = {
    owner_id: ownerId,
    space_id: spaceId ?? null,
    kind: 'video',
    content_url: url,
    metadata: {
      media_pipeline: {
        source_url: url,
        pipeline_version: PIPELINE_VERSION,
        blocked_reason: 'csam-detected',
        blocked_at: blockedAt,
        safety_details: err.details,
        status: 'failed',
      },
    },
    embedding: null,
    safety_status: 'blocked',
  };

  const { data: stoneInsert, error: stoneErr } = await supabase
    .from('stones')
    .insert(stonesRow)
    .select('id')
    .single();

  if (stoneErr) {
    jobLog.error({ msg: 'csam:stones insert failed', err: stoneErr });
    throw new Error(`csam handler: stones insert failed: ${stoneErr.message}`);
  }
  const stoneId = stoneInsert.id;

  const incidentRow = {
    user_id: ownerId,
    stone_id: stoneId,
    type: 'csam',
    detected_at: err.details?.scanned_at ?? blockedAt,
    hash_data: {
      hash: err.details?.hash ?? null,
      source: err.details?.source ?? null,
    },
  };

  const { data: incidentInsert, error: incidentErr } = await supabase
    .from('incidents')
    .insert(incidentRow)
    .select('id')
    .single();

  if (incidentErr) {
    jobLog.error({ msg: 'csam:incidents insert failed', stoneId, err: incidentErr });
  }
  const incidentId = incidentInsert?.id ?? null;

  // Enqueue follow-ups. Failures here are logged loudly but don't unwind the
  // stones+incidents records — those are the legal-evidence rows.
  try {
    const moderationQueue = buildModerationQueue();
    await moderationQueue.add('media-suspend-user', {
      user_id: ownerId,
      reason: 'csam-detected',
      incident_id: incidentId,
    });
  } catch (qErr) {
    jobLog.error({ msg: 'csam:enqueue suspend failed', err: qErr });
  }

  if (incidentId) {
    try {
      const incidentQueue = buildIncidentQueue();
      await incidentQueue.add('media-report-incident', { incident_id: incidentId });
    } catch (qErr) {
      jobLog.error({ msg: 'csam:enqueue report failed', err: qErr });
    }
  }

  jobLog.error({
    msg: 'media-ingest:csam-blocked',
    stoneId,
    incidentId,
    durationMs: Date.now() - jobStart,
  });

  return { stoneId, blocked: true, incidentId, safetyStatus: 'blocked' };
}
