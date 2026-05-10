import { Router } from 'express';
import { buildHarvestQueue, HARVEST_QUEUE } from '@cairn/shared/queue';
import { getServiceClient } from '@cairn/shared/supabase';
import { setStoneStatus } from '@cairn/shared/media-pipeline';
import { createLogger } from '@cairn/shared/logger';
import { requireAuth } from '../middleware/auth.js';
import { rateLimitPerUser } from '../middleware/rateLimit.js';

const router = Router();
const log = createLogger('media-harvest-route');
const harvestQueue = buildHarvestQueue();

const ALLOWED_COUNTS = new Set([5, 10, 15]);

// Phase 9c — Delta 2: stones with these statuses already have a
// harvest or reunderstand job in flight; refuse to enqueue another.
// 'failed' and 'complete' are both ok — the user can retry/redo.
const BUSY_STATUSES = new Set(['pending', 'harvesting']);

/**
 * POST /api/media/:stone_id/harvest
 * body: { count: 5 | 10 | 15 }
 *
 * Validates stone is a video with non-empty harvest_candidates, then enqueues
 * a harvest job. The actual frame extraction + storage + galleries inserts
 * happen asynchronously in the worker.
 *
 * Phase 9c — Delta 2:
 *   - 409 'busy' if media_pipeline.status is 'pending' or 'harvesting' —
 *     prevents the latent harvest+reunderstand concurrency bug.
 *   - On successful enqueue, writes status='pending'. The worker overwrites
 *     to 'harvesting' when it picks the job up, then 'complete' on success
 *     (or 'failed' on terminal failure, written by the worker.js failed
 *     handler). The pending→harvesting flip is best-effort: if the
 *     setStoneStatus call here fails, we still return 202 because the
 *     worker will overwrite anyway. The race window is small.
 */
router.post('/:stone_id/harvest', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId } = req.auth;
  const { stone_id } = req.params;
  const reqLog = log.child({ route: 'POST /api/media/:stone_id/harvest', stone_id, ownerIdTail: userId.slice(-4) });

  try {
    const count = Number(req.body?.count);
    if (!ALLOWED_COUNTS.has(count)) {
      return res.status(400).json({ ok: false, error: 'count must be 5, 10, or 15' });
    }

    const supabase = getServiceClient();
    const { data: stone, error: stoneErr } = await supabase
      .from('stones')
      .select('id, owner_id, kind, metadata')
      .eq('id', stone_id)
      .single();

    if (stoneErr || !stone) {
      return res.status(404).json({ ok: false, error: 'Stone not found' });
    }
    if (stone.owner_id !== userId) {
      // Don't leak existence across users — same shape as not-found.
      return res.status(404).json({ ok: false, error: 'Stone not found' });
    }
    if (stone.kind !== 'video') {
      return res.status(409).json({ ok: false, error: `Stone is kind=${stone.kind}, expected 'video'` });
    }
    const candidates = stone?.metadata?.media_pipeline?.harvest_candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return res.status(409).json({
        ok: false,
        error: 'Stone has no harvest_candidates (likely a non-personal video)',
      });
    }

    // Phase 9c — Delta 2: refuse if a worker is already on this stone.
    const currentStatus = stone?.metadata?.media_pipeline?.status;
    if (BUSY_STATUSES.has(currentStatus)) {
      reqLog.info({ msg: 'harvest:busy-rejected', stone_id, currentStatus });
      return res.status(409).json({
        ok: false,
        error: 'busy',
        message: 'This stone is already being worked on. Please wait.',
      });
    }

    const job = await harvestQueue.add('media-harvest', {
      stone_id,
      count,
      requested_by_owner_id: userId,
    });

    // Phase 9c — Delta 2: mark 'pending' immediately. The worker will
    // overwrite to 'harvesting' the moment it picks the job up. Best-effort:
    // log and continue if the status write itself fails — the worker's
    // overwrite makes this self-healing within seconds.
    try {
      await setStoneStatus(supabase, stone_id, 'pending');
    } catch (statusErr) {
      reqLog.error({
        msg: 'harvest:set-pending-failed',
        stone_id,
        jobId: job.id,
        err: statusErr,
      });
    }

    reqLog.info({
      event: 'job_enqueued',
      queue: HARVEST_QUEUE,
      jobId: job.id,
      stone_id,
      count,
      availableCandidates: candidates.length,
    });

    return res.status(202).json({
      ok: true,
      job_id: job.id,
      stone_id,
      count_requested: count,
    });
  } catch (err) {
    reqLog.error({ msg: 'enqueue failed', err });
    return res.status(500).json({ ok: false, error: 'Could not enqueue harvest job' });
  }
});

export default router;
