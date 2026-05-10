import { Router } from 'express';
import { buildReunderstandQueue, REUNDERSTAND_QUEUE } from '@cairn/shared/queue';
import { getServiceClient } from '@cairn/shared/supabase';
import { setStoneStatus } from '@cairn/shared/media-pipeline';
import { createLogger } from '@cairn/shared/logger';
import { requireAuth } from '../middleware/auth.js';
import { rateLimitPerUser } from '../middleware/rateLimit.js';

const router = Router();
const log = createLogger('media-reunderstand-route');
const reunderstandQueue = buildReunderstandQueue();

const ESTIMATED_COST_USD = 0.08;

// Phase 9c — Delta 2: stones with these statuses already have a
// harvest or reunderstand job in flight; refuse to enqueue another.
const BUSY_STATUSES = new Set(['pending', 'harvesting']);

/**
 * POST /api/media/:stone_id/reunderstand
 * body: { confirmed_cost?: boolean }  (optional explicit confirmation)
 *
 * Validates that the stone is a video with a 'weak' understanding that hasn't
 * been retried before, then enqueues a denser, higher-detail re-understanding
 * pass on the user's opt-in. Costs roughly 8x the original ingest.
 *
 * Phase 9c — Delta 2:
 *   - 409 'busy' if media_pipeline.status is 'pending' or 'harvesting' —
 *     prevents the latent harvest+reunderstand concurrency bug.
 *   - On successful enqueue, writes status='pending'. The worker overwrites
 *     to 'harvesting' when it picks the job up, then 'complete' on success
 *     (or 'failed' on terminal failure, written by the worker.js failed
 *     handler). The pending→harvesting flip is best-effort: if the
 *     setStoneStatus call here fails, we still return 202 because the
 *     worker will overwrite anyway.
 */
router.post('/:stone_id/reunderstand', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId } = req.auth;
  const { stone_id } = req.params;
  const reqLog = log.child({ route: 'POST /api/media/:stone_id/reunderstand', stone_id, ownerIdTail: userId.slice(-4) });

  try {
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

    const mp = stone?.metadata?.media_pipeline;
    if (!mp) {
      return res.status(409).json({ ok: false, error: 'Stone has no media_pipeline metadata' });
    }
    if (mp.understanding_status !== 'weak') {
      return res.status(409).json({
        ok: false,
        error: "this video's understanding is already complete; nothing to retry",
      });
    }
    if (mp.reunderstand_attempted === true) {
      return res.status(409).json({
        ok: false,
        error: 'this video has already been re-analysed; further attempts not currently offered',
      });
    }

    // Phase 9c — Delta 2: refuse if a worker is already on this stone.
    if (BUSY_STATUSES.has(mp.status)) {
      reqLog.info({ msg: 'reunderstand:busy-rejected', stone_id, currentStatus: mp.status });
      return res.status(409).json({
        ok: false,
        error: 'busy',
        message: 'This stone is already being worked on. Please wait.',
      });
    }

    const job = await reunderstandQueue.add('media-reunderstand', {
      stone_id,
      requested_by_owner_id: userId,
    });

    // Phase 9c — Delta 2: mark 'pending' immediately. The worker will
    // overwrite to 'harvesting' the moment it picks the job up. Best-effort:
    // log and continue if the status write itself fails.
    try {
      await setStoneStatus(supabase, stone_id, 'pending');
    } catch (statusErr) {
      reqLog.error({
        msg: 'reunderstand:set-pending-failed',
        stone_id,
        jobId: job.id,
        err: statusErr,
      });
    }

    reqLog.info({
      event: 'job_enqueued',
      queue: REUNDERSTAND_QUEUE,
      jobId: job.id,
      stone_id,
    });

    return res.status(202).json({
      ok: true,
      job_id: job.id,
      stone_id,
      estimated_cost_usd: ESTIMATED_COST_USD,
    });
  } catch (err) {
    reqLog.error({ msg: 'enqueue failed', err });
    return res.status(500).json({ ok: false, error: 'Could not enqueue reunderstand job' });
  }
});

export default router;
