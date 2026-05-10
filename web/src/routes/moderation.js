import { Router } from 'express';
import { getServiceClient } from '@cairn/shared/supabase';
import { createLogger } from '@cairn/shared/logger';
import { requireAuth } from '../middleware/auth.js';
import { rateLimitPerUser } from '../middleware/rateLimit.js';

const router = Router();
const log = createLogger('moderation-route');

/**
 * Crude RBAC: only the user whose id matches AMANDA_USER_ID can hit
 * moderation endpoints. Proper RBAC (role table, multi-reviewer support)
 * lands in a later phase. Until then this gate keeps moderation off the
 * default authenticated path.
 */
function requireModerator(req, res, next) {
  const allowed = process.env.AMANDA_USER_ID;
  if (!allowed) {
    log.warn({ msg: 'moderation:rbac-not-configured' });
    return res.status(503).json({ ok: false, error: 'moderation RBAC not configured' });
  }
  if (req.auth?.userId !== allowed) {
    return res.status(403).json({ ok: false, error: 'not authorised' });
  }
  return next();
}

/**
 * GET /api/moderation/queue
 * Returns pending moderation rows joined with stones/galleries info.
 */
router.get('/queue', requireAuth, requireModerator, rateLimitPerUser, async (req, res) => {
  const reqLog = log.child({ route: 'GET /api/moderation/queue' });

  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase
      .from('moderation_review_queue')
      .select(`
        id, user_id, stone_id, gallery_id, file_path, classification, confidence,
        status, created_at,
        stones:stones (id, owner_id, kind, content_url, safety_status),
        galleries:galleries (id, file_path, kind, mime_type)
      `)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      reqLog.error({ msg: 'queue read failed', err: error });
      return res.status(500).json({ ok: false, error: 'Could not read queue' });
    }

    return res.json({ ok: true, items: data ?? [] });
  } catch (err) {
    reqLog.error({ msg: 'queue threw', err });
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

/**
 * POST /api/moderation/review/:queue_id
 * body: { decision: 'approved'|'rejected', notes?: string }
 *
 * Approved: row marked approved, no further action.
 * Rejected: row marked rejected, the gallery row is hard-deleted, and the
 * R2 object is queued for deletion (deferred to a separate job since R2
 * delete touches storage and we want it auditable).
 */
router.post('/review/:queue_id', requireAuth, requireModerator, rateLimitPerUser, async (req, res) => {
  const { userId } = req.auth;
  const { queue_id } = req.params;
  const decision = String(req.body?.decision || '');
  const notes = typeof req.body?.notes === 'string' ? req.body.notes : null;
  const reqLog = log.child({ route: 'POST /api/moderation/review/:queue_id', queue_id });

  if (decision !== 'approved' && decision !== 'rejected') {
    return res.status(400).json({ ok: false, error: "decision must be 'approved' or 'rejected'" });
  }

  try {
    const supabase = getServiceClient();
    const { data: row, error: readErr } = await supabase
      .from('moderation_review_queue')
      .select('id, stone_id, gallery_id, file_path, status')
      .eq('id', queue_id)
      .single();

    if (readErr || !row) {
      return res.status(404).json({ ok: false, error: 'Review item not found' });
    }
    if (row.status !== 'pending') {
      return res.status(409).json({ ok: false, error: `already ${row.status}` });
    }

    const { error: updateErr } = await supabase
      .from('moderation_review_queue')
      .update({
        status: decision,
        reviewer_id: userId,
        reviewed_at: new Date().toISOString(),
        notes,
      })
      .eq('id', queue_id);

    if (updateErr) {
      reqLog.error({ msg: 'review update failed', err: updateErr });
      return res.status(500).json({ ok: false, error: 'Could not record decision' });
    }

    if (decision === 'rejected' && row.gallery_id) {
      // Hard-delete the gallery row. R2 deletion is intentionally not done
      // synchronously here — leaving it for a deletion job keeps the request
      // fast and the operation auditable.
      const { error: galDeleteErr } = await supabase
        .from('galleries')
        .delete()
        .eq('id', row.gallery_id);
      if (galDeleteErr) {
        reqLog.error({ msg: 'gallery delete failed', gallery_id: row.gallery_id, err: galDeleteErr });
      }
    }

    return res.json({ ok: true, queue_id, decision });
  } catch (err) {
    reqLog.error({ msg: 'review threw', err });
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

export default router;
