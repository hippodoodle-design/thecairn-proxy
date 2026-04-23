import { Router } from 'express';
import { buildQueue, DIGEST_QUEUE } from '@cairn/shared/queue';
import { validateUrl } from '@cairn/shared/validateUrl';
import { createLogger } from '@cairn/shared/logger';
import { requireAuth } from '../middleware/auth.js';
import { rateLimitPerUser } from '../middleware/rateLimit.js';

const router = Router();
const log = createLogger('thecairn-web');
const queue = buildQueue(DIGEST_QUEUE);

/**
 * POST /api/digest
 * body: { url: string }
 * Enqueues a url-digest job for the authenticated user and returns a jobId.
 */
router.post('/', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId } = req.auth;
  const ownerIdTail = userId.slice(-4);
  const reqLog = log.child({ route: 'POST /api/digest', ownerIdTail });

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

    const job = await queue.add(
      'url-digest',
      {
        kind: 'url',
        url: check.url.toString(),
        ownerId: userId,
      },
      {
        // Per-job overrides would go here; defaults come from buildQueue.
      },
    );

    reqLog.info({
      event: 'job_enqueued',
      jobId: job.id,
      url: check.url.toString(),
      ownerIdTail,
    });
    return res.status(202).json({ ok: true, jobId: job.id });
  } catch (err) {
    reqLog.error({ msg: 'enqueue failed', err });
    return res.status(500).json({ ok: false, error: 'Could not enqueue digest job' });
  }
});

/**
 * GET /api/digest/:jobId
 * Returns current state + result. Owner check: the job must belong to req.auth.userId.
 */
router.get('/:jobId', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId } = req.auth;
  const { jobId } = req.params;
  const reqLog = log.child({ route: 'GET /api/digest/:jobId', jobId, ownerIdTail: userId.slice(-4) });

  try {
    const job = await queue.getJob(jobId);
    if (!job) {
      return res.status(404).json({ ok: false, error: 'Job not found' });
    }
    if (job.data?.ownerId !== userId) {
      // Same response shape as not-found so we don't leak job existence across users.
      return res.status(404).json({ ok: false, error: 'Job not found' });
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
      error: failedReason,
    });
  } catch (err) {
    reqLog.error({ msg: 'status lookup failed', err });
    return res.status(500).json({ ok: false, error: 'Could not read job status' });
  }
});

export default router;
