import { Router } from 'express';
import { buildMediaQueue, MEDIA_QUEUE } from '@cairn/shared/queue';
import { validateUrl } from '@cairn/shared/validateUrl';
import { createLogger } from '@cairn/shared/logger';
import { getServiceClient } from '@cairn/shared/supabase';
import { PIPELINE_VERSION } from '@cairn/shared/media-pipeline';
import { requireAuth } from '../middleware/auth.js';
import { rateLimitPerUser } from '../middleware/rateLimit.js';

const router = Router();
const log = createLogger('ingest-video-route');
const mediaQueue = buildMediaQueue();

// Warm Presence-Principle copy the frontend renders verbatim.
const INVALID_URL_MESSAGE =
  "That doesn't look like a video URL I can read — try pasting it again?";
const ENQUEUE_FAILED_MESSAGE =
  "Something didn't go as I expected on my side — let me know if you'd like me to try again.";

/**
 * POST /api/media/ingest-video
 * body: { video_url: string }
 *
 * Phase 1a — Video Understanding Chat Layer 1. Auth-gated ingest entry point.
 * Creates a stones row up-front with media_pipeline.status='pending' so the
 * frontend can poll the row by id while the worker runs. Enqueues onto the
 * existing cairn-media queue with job name 'media-ingest' and an additive
 * stone_id field on the payload; the worker treats stone_id as "update this
 * row" instead of inserting a new one at the end.
 *
 * scripts/enqueue-media.js still works without stone_id — the worker keeps
 * the legacy insert-at-end path for that case.
 *
 * Returns { stone_id, status: 'queued' } on success.
 */
router.post('/ingest-video', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId } = req.auth;
  const ownerIdTail = userId.slice(-4);
  const reqLog = log.child({ route: 'POST /api/media/ingest-video', ownerIdTail });

  const raw = typeof req.body?.video_url === 'string' ? req.body.video_url.trim() : '';
  if (!raw) {
    return res.status(400).json({ ok: false, error: INVALID_URL_MESSAGE });
  }

  const check = await validateUrl(raw);
  if (!check.ok) {
    reqLog.warn({ msg: 'url rejected', reason: check.error });
    return res.status(400).json({ ok: false, error: INVALID_URL_MESSAGE });
  }

  const normalizedUrl = check.url.toString();
  const supabase = getServiceClient();

  let stoneId;
  try {
    const { data, error } = await supabase
      .from('stones')
      .insert({
        owner_id: userId,
        kind: 'video',
        content_url: normalizedUrl,
        metadata: {
          media_pipeline: {
            source_url: normalizedUrl,
            pipeline_version: PIPELINE_VERSION,
            status: 'pending',
          },
        },
      })
      .select('id')
      .single();

    if (error) {
      reqLog.error({ msg: 'stones insert failed', err: error });
      return res.status(500).json({ ok: false, error: ENQUEUE_FAILED_MESSAGE });
    }
    stoneId = data.id;
  } catch (err) {
    reqLog.error({ msg: 'stones insert threw', err });
    return res.status(500).json({ ok: false, error: ENQUEUE_FAILED_MESSAGE });
  }

  try {
    const job = await mediaQueue.add('media-ingest', {
      url: normalizedUrl,
      ownerId: userId,
      stone_id: stoneId,
    });

    reqLog.info({
      event: 'job_enqueued',
      queue: MEDIA_QUEUE,
      jobId: job.id,
      stoneId,
      url: normalizedUrl,
    });

    return res.status(202).json({ stone_id: stoneId, status: 'queued' });
  } catch (err) {
    // Enqueue failed after the row was created. Mark it failed so the row
    // doesn't sit at 'pending' forever; failure to mark is logged but
    // doesn't change the response — the user still gets the same warm
    // error and can retry.
    reqLog.error({ msg: 'enqueue failed', stoneId, err });
    try {
      await supabase
        .from('stones')
        .update({
          metadata: {
            media_pipeline: {
              source_url: normalizedUrl,
              pipeline_version: PIPELINE_VERSION,
              status: 'failed',
              enqueue_error: true,
            },
          },
        })
        .eq('id', stoneId);
    } catch (markErr) {
      reqLog.error({ msg: 'failed to mark stone failed after enqueue error', stoneId, err: markErr });
    }
    return res.status(500).json({ ok: false, error: ENQUEUE_FAILED_MESSAGE });
  }
});

export default router;
