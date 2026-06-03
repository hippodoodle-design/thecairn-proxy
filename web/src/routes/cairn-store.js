import { Router } from 'express';
import { getServiceClient } from '@cairn/shared/supabase';
import { createLogger } from '@cairn/shared/logger';
import {
  depositBatch,
  listFolder,
  trashItem,
  restoreItem,
  renameItem,
  createStone,
  renameStone,
  copyToStone,
  removeFromStone,
  undoLast,
} from '@cairn/shared/storage-spine';
import { requireAuth } from '../middleware/auth.js';
import { rateLimitPerUser } from '../middleware/rateLimit.js';

const log = createLogger('cairn-store-route');
const router = Router();

const ADDED_BY = ['user', 'roberta'];

/** Map a helper's not-found/permission reason to an HTTP response. */
function sendReason(res, result) {
  if (result.missingSchema) {
    return res.status(409).json({ ok: false, error: 'storage spine not set up yet — migration 009 pending' });
  }
  if (result.ok) return null;
  const map = { not_found: 404, item_not_found: 404, stone_not_found: 404 };
  return res.status(map[result.reason] ?? 400).json({ ok: false, error: result.reason ?? 'failed' });
}

// ===========================================================================
// DEPOSIT — service-to-service (HippoDelivery → Cairn). NOT a user endpoint.
// Protected by a shared deposit secret. This is the cairnward.js deposit
// contract landing point (see @cairn/shared/storage-spine for the shape).
//
// SEAM: when CAIRN_DEPOSIT_SECRET is unset the endpoint is "not wired" (501) —
// it never accepts an unauthenticated deposit. Real service auth (mTLS / signed
// handoff from HippoDelivery) is a later hardening pass.
// ===========================================================================
router.post('/deposit', async (req, res) => {
  const secret = process.env.CAIRN_DEPOSIT_SECRET;
  if (!secret) {
    return res.status(501).json({ ok: false, error: 'deposit not wired (CAIRN_DEPOSIT_SECRET unset)' });
  }
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (provided !== secret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const { ownerId, batchId, items } = req.body ?? {};
  if (typeof ownerId !== 'string' || !ownerId) {
    return res.status(400).json({ ok: false, error: 'ownerId is required' });
  }
  if (!Array.isArray(items)) {
    return res.status(400).json({ ok: false, error: 'items must be an array' });
  }
  try {
    const supabase = await getServiceClient();
    const result = await depositBatch(supabase, { ownerId, batchId, items });
    if (result.missingSchema) {
      return res.status(409).json({ ok: false, error: 'storage spine not set up yet — migration 009 pending' });
    }
    log.info({ msg: 'deposit landed', ownerIdTail: ownerId.slice(-4), inserted: result.inserted.length, skipped: result.skipped });
    return res.status(201).json({ ok: true, inserted: result.inserted.length, skipped: result.skipped });
  } catch (err) {
    log.error({ msg: 'deposit failed', err });
    return res.status(500).json({ ok: false, error: 'deposit failed' });
  }
});

// ===========================================================================
// FOLDER — the account's canonical store. Own data only (operator-blind).
// ===========================================================================
router.get('/folder', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId } = req.auth;
  const includeTrashed = req.query.trashed === '1' || req.query.trashed === 'true';
  try {
    const supabase = await getServiceClient();
    const result = await listFolder(supabase, userId, { includeTrashed });
    if (result.missingSchema) return res.json({ ok: true, ready: false, items: [] });
    return res.json({ ok: true, ready: true, items: result.items });
  } catch (err) {
    log.error({ msg: 'folder list failed', err });
    return res.status(500).json({ ok: false, error: 'Could not load your folder' });
  }
});

router.post('/folder/:id/trash', requireAuth, rateLimitPerUser, async (req, res) => {
  try {
    const supabase = await getServiceClient();
    const r = await trashItem(supabase, req.auth.userId, req.params.id);
    const bad = sendReason(res, r); if (bad) return bad;
    return res.json({ ok: true });
  } catch (err) { log.error({ msg: 'trash failed', err }); return res.status(500).json({ ok: false, error: 'Internal error' }); }
});

router.post('/folder/:id/restore', requireAuth, rateLimitPerUser, async (req, res) => {
  try {
    const supabase = await getServiceClient();
    const r = await restoreItem(supabase, req.auth.userId, req.params.id);
    const bad = sendReason(res, r); if (bad) return bad;
    return res.json({ ok: true });
  } catch (err) { log.error({ msg: 'restore failed', err }); return res.status(500).json({ ok: false, error: 'Internal error' }); }
});

router.post('/folder/:id/rename', requireAuth, rateLimitPerUser, async (req, res) => {
  const { title } = req.body ?? {};
  if (typeof title !== 'string') return res.status(400).json({ ok: false, error: 'title must be a string' });
  try {
    const supabase = await getServiceClient();
    const r = await renameItem(supabase, req.auth.userId, req.params.id, title);
    const bad = sendReason(res, r); if (bad) return bad;
    return res.json({ ok: true });
  } catch (err) { log.error({ msg: 'rename item failed', err }); return res.status(500).json({ ok: false, error: 'Internal error' }); }
});

// ===========================================================================
// STONES — named collections over folder items. Own data only.
// ===========================================================================
router.get('/stones', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId } = req.auth;
  try {
    const supabase = await getServiceClient();
    const { data, error } = await supabase
      .from('stone_collections')
      .select('id, name, cover_folder_item_id, position, created_at, items:stone_collection_items(count)')
      .eq('owner_id', userId)
      .order('position', { ascending: true });
    if (error) {
      // Treat missing schema as "not ready" rather than 500.
      if (/does not exist|schema cache|could not find the table/i.test(error.message || '') || ['42P01', 'PGRST205'].includes(error.code)) {
        return res.json({ ok: true, ready: false, stones: [] });
      }
      throw error;
    }
    return res.json({ ok: true, ready: true, stones: data ?? [] });
  } catch (err) {
    log.error({ msg: 'stones list failed', err });
    return res.status(500).json({ ok: false, error: 'Could not load your stones' });
  }
});

router.post('/stones', requireAuth, rateLimitPerUser, async (req, res) => {
  const { name } = req.body ?? {};
  if (name != null && typeof name !== 'string') return res.status(400).json({ ok: false, error: 'name must be a string' });
  try {
    const supabase = await getServiceClient();
    const r = await createStone(supabase, req.auth.userId, { name });
    if (r.missingSchema) return res.status(409).json({ ok: false, error: 'storage spine not set up yet — migration 009 pending' });
    return res.status(201).json({ ok: true, stone: r.stone });
  } catch (err) { log.error({ msg: 'create stone failed', err }); return res.status(500).json({ ok: false, error: 'Could not create the stone' }); }
});

router.post('/stones/:id/rename', requireAuth, rateLimitPerUser, async (req, res) => {
  const { name } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ ok: false, error: 'name is required' });
  try {
    const supabase = await getServiceClient();
    const r = await renameStone(supabase, req.auth.userId, req.params.id, name.trim());
    const bad = sendReason(res, r); if (bad) return bad;
    return res.json({ ok: true });
  } catch (err) { log.error({ msg: 'rename stone failed', err }); return res.status(500).json({ ok: false, error: 'Internal error' }); }
});

router.get('/stones/:id/items', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId } = req.auth;
  try {
    const supabase = await getServiceClient();
    const { data, error } = await supabase
      .from('stone_collection_items')
      .select('id, position, added_by, added_at, item:folder_items(id, kind, title, r2_key, mime_type, status)')
      .eq('owner_id', userId)
      .eq('collection_id', req.params.id)
      .order('position', { ascending: true });
    if (error) throw error;
    return res.json({ ok: true, items: data ?? [] });
  } catch (err) {
    log.error({ msg: 'stone items failed', err });
    return res.status(500).json({ ok: false, error: 'Could not load that stone' });
  }
});

router.post('/stones/:id/items', requireAuth, rateLimitPerUser, async (req, res) => {
  const { folderItemId, addedBy } = req.body ?? {};
  if (typeof folderItemId !== 'string' || !folderItemId) return res.status(400).json({ ok: false, error: 'folderItemId is required' });
  if (addedBy != null && !ADDED_BY.includes(addedBy)) return res.status(400).json({ ok: false, error: `addedBy must be one of ${ADDED_BY.join(', ')}` });
  try {
    const supabase = await getServiceClient();
    const r = await copyToStone(supabase, req.auth.userId, { collectionId: req.params.id, folderItemId, addedBy: addedBy ?? 'user' });
    const bad = sendReason(res, r); if (bad) return bad;
    return res.status(201).json({ ok: true, membershipId: r.membershipId ?? null, alreadyPresent: !!r.alreadyPresent });
  } catch (err) { log.error({ msg: 'copy to stone failed', err }); return res.status(500).json({ ok: false, error: 'Could not add to the stone' }); }
});

router.delete('/stones/:id/items/:folderItemId', requireAuth, rateLimitPerUser, async (req, res) => {
  try {
    const supabase = await getServiceClient();
    const r = await removeFromStone(supabase, req.auth.userId, { collectionId: req.params.id, folderItemId: req.params.folderItemId });
    const bad = sendReason(res, r); if (bad) return bad;
    return res.json({ ok: true });
  } catch (err) { log.error({ msg: 'remove from stone failed', err }); return res.status(500).json({ ok: false, error: 'Internal error' }); }
});

// ===========================================================================
// UNDO SPINE — pop the most recent reversible op (own account).
// ===========================================================================
router.post('/undo', requireAuth, rateLimitPerUser, async (req, res) => {
  try {
    const supabase = await getServiceClient();
    const r = await undoLast(supabase, req.auth.userId);
    if (r.missingSchema) return res.status(409).json({ ok: false, error: 'storage spine not set up yet — migration 009 pending' });
    if (!r.undone) return res.json({ ok: true, undone: null, message: 'nothing to undo' });
    return res.json({ ok: true, undone: r.undone });
  } catch (err) { log.error({ msg: 'undo failed', err }); return res.status(500).json({ ok: false, error: 'Could not undo' }); }
});

router.get('/undo', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId } = req.auth;
  try {
    const supabase = await getServiceClient();
    const { data, error } = await supabase
      .from('undo_log')
      .select('id, op, target_table, target_id, undone_at, created_at')
      .eq('owner_id', userId)
      .order('seq', { ascending: false })
      .limit(20);
    if (error) throw error;
    return res.json({ ok: true, stack: data ?? [] });
  } catch (err) {
    log.error({ msg: 'undo stack failed', err });
    return res.status(500).json({ ok: false, error: 'Could not load undo history' });
  }
});

export default router;
