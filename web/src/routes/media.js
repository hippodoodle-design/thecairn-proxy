import { Router } from 'express';
import { buildMediaQueue, MEDIA_QUEUE } from '@cairn/shared/queue';
import { validateUrl } from '@cairn/shared/validateUrl';
import { createLogger } from '@cairn/shared/logger';
import { requireAuth } from '../middleware/auth.js';
import { rateLimitPerUser } from '../middleware/rateLimit.js';

const router = Router();
const log = createLogger('media-route');
const mediaQueue = buildMediaQueue();

/**
 * POST /api/media
 * body: { url: string }
 * Enqueues a media-ingest job for the authenticated user and returns a jobId.
 */
router.post('/', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId } = req.auth;
  const ownerIdTail = userId.slice(-4);
  const reqLog = log.child({ route: 'POST /api/media', ownerIdTail });

  try {
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    if (!url) {
      return res.status(400).json({ ok: false, error: 'URL is required' });
    }

    const check = await validateUrl(url);
    if (!check.ok) {
      reqLog.warn({ msg: 'url rejected', url, reason: check.error });
      return res.status(400).json({ ok: false, error: check.error });
    }

    const job = await mediaQueue.add('media-ingest', {
      url: check.url.toString(),
      ownerId: userId,
    });

    reqLog.info({
      event: 'job_enqueued',
      queue: MEDIA_QUEUE,
      jobId: job.id,
      url: check.url.toString(),
      ownerIdTail,
    });
    return res.status(202).json({ ok: true, jobId: job.id });
  } catch (err) {
    reqLog.error({ msg: 'enqueue failed', err });
    return res.status(500).json({ ok: false, error: 'Could not enqueue media job' });
  }
});

/**
 * GET /api/media/:jobId
 * Returns current state + result. Owner check: the job must belong to req.auth.userId.
 */
router.get('/:jobId', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId } = req.auth;
  const { jobId } = req.params;
  const reqLog = log.child({ route: 'GET /api/media/:jobId', jobId, ownerIdTail: userId.slice(-4) });

  try {
    const job = await mediaQueue.getJob(jobId);
    if (!job || job.data?.ownerId !== userId) {
      // Same response for missing and unowned so we don't leak existence across users.
      return res.status(404).json({ ok: false, error: 'not found' });
    }

    const state = await job.getState();
    const progress = job.progress;
    const returnvalue = job.returnvalue ?? null;
    const failedReason = job.failedReason ?? null;

    return res.json({
      ok: true,
      jobId: job.id,
      state,
      progress,
      result: returnvalue,
      failedReason,
    });
  } catch (err) {
    reqLog.error({ msg: 'status lookup failed', err });
    return res.status(500).json({ ok: false, error: 'Could not read job status' });
  }
});

export default router;
