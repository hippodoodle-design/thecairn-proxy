import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import { getServiceClient } from '@cairn/shared/supabase';
import { createR2Storage, createStubStorage } from '@cairn/shared/media-pipeline/storage';
import { createLogger } from '@cairn/shared/logger';
import { matchHashes } from '@cairn/shared/cairn-import/safety';
import { requireAuth } from '../middleware/auth.js';
import { rateLimitPerUser } from '../middleware/rateLimit.js';

const router = Router();
const log = createLogger('cairn-import-route');

// The phone-importer LIVE seam (thecairn-app /bring-it-home) calls these three
// JWT-auth endpoints on VITE_CAIRN_BACKEND_URL. Guardrails (dispatch e1c0d2a7):
// operator-blind; own-row RLS (owner_id = auth.uid()); hash-only safety (no
// classifiers, no human eyes); NO-DELETE (status='active' only); COPY-only
// (no source-delete server path). PR/preview only — no customer-facing arm
// until the IWF hash-list licence lands (the safety matcher fails CLOSED).

const MAX_HASHES = 500;
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB per item (phone photos/videos)
const KIND_VALUES = ['photo', 'video', 'audio', 'document', 'other'];
const MAX_NAME_LEN = 200;

/** R2 when configured (EU bucket via R2_JURISDICTION=eu), filesystem stub otherwise. */
function pickStorage() {
  if (process.env.R2_ACCOUNT_ID && process.env.R2_BUCKET) return createR2Storage();
  return createStubStorage();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
});

/** Multer wrapper that maps upload errors to clean JSON instead of a 500. */
function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ ok: false, error: 'file too large' });
      }
      log.warn({ msg: 'item:multipart-error', err: err.message });
      return res.status(400).json({ ok: false, error: 'invalid multipart upload' });
    }
    next();
  });
}

/**
 * POST /api/import/safety-match
 * body: { hashes: string[] }  ->  { allow: string[], blocked: string[] }
 *
 * Server-side, operator-blind match of client-computed hashes against the
 * LICENSED known-CSAM hash list. Receives ONLY hashes — never media, never a
 * classifier. FAIL-CLOSED: while the IWF licence is unprovisioned this returns
 * 503 with allow=[] and blocked=all (NOT fail-open).
 */
router.post('/safety-match', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId } = req.auth;
  const reqLog = log.child({ route: 'POST /api/import/safety-match', ownerIdTail: userId.slice(-4) });

  const hashes = req.body?.hashes;
  if (!Array.isArray(hashes) || hashes.length === 0 || hashes.length > MAX_HASHES) {
    return res.status(400).json({
      ok: false,
      error: `hashes must be a non-empty array of at most ${MAX_HASHES} strings`,
    });
  }
  if (!hashes.every((h) => typeof h === 'string' && h.length > 0 && h.length <= 256)) {
    return res.status(400).json({ ok: false, error: 'every hash must be a non-empty string' });
  }

  let result;
  try {
    result = await matchHashes(hashes);
  } catch (err) {
    reqLog.error({ msg: 'safety-match:threw', err });
    // Fail closed even on internal error: never allow when safety is uncertain.
    return res.status(503).json({ ok: false, error: 'safety_unavailable', allow: [], blocked: [...new Set(hashes)] });
  }

  if (!result.available) {
    reqLog.warn({ msg: 'safety-match:fail-closed', count: hashes.length });
    return res.status(503).json({ ok: false, error: 'safety_unavailable', allow: [], blocked: result.blocked });
  }

  reqLog.info({ msg: 'safety-match:done', allowed: result.allow.length, blocked: result.blocked.length });
  return res.json({ ok: true, allow: result.allow, blocked: result.blocked });
});

/**
 * POST /api/import/item
 * multipart: { file, hash, meta(JSON), stack_id? }  ->  inserted folder_items row
 *
 * COPY ingest of a single item into the user's own folder. The hash is
 * RE-CHECKED server-side (authoritative) before any store/insert; blocked or
 * unavailable => refuse. Blob -> R2 (EU). Row inserted under own-row RLS
 * (owner_id = auth.uid()), operator-blind, status='active' (NO-DELETE).
 */
router.post('/item', requireAuth, rateLimitPerUser, handleUpload, async (req, res) => {
  const { userId } = req.auth;
  const reqLog = log.child({ route: 'POST /api/import/item', ownerIdTail: userId.slice(-4) });

  const file = req.file;
  const hash = typeof req.body?.hash === 'string' ? req.body.hash.trim() : '';
  if (!file || !file.buffer?.length) {
    return res.status(400).json({ ok: false, error: 'file is required' });
  }
  if (!hash) {
    return res.status(400).json({ ok: false, error: 'hash is required' });
  }

  let meta;
  try {
    meta = req.body?.meta ? JSON.parse(req.body.meta) : {};
  } catch {
    return res.status(400).json({ ok: false, error: 'meta must be valid JSON' });
  }
  if (meta == null || typeof meta !== 'object' || Array.isArray(meta)) {
    return res.status(400).json({ ok: false, error: 'meta must be a JSON object' });
  }

  const stackId = typeof req.body?.stack_id === 'string' && req.body.stack_id.trim()
    ? req.body.stack_id.trim()
    : null;

  // 1. Authoritative server-side safety re-check BEFORE any store/insert.
  let safety;
  try {
    safety = await matchHashes([hash]);
  } catch (err) {
    reqLog.error({ msg: 'item:safety-threw', err });
    return res.status(503).json({ ok: false, error: 'safety_unavailable' });
  }
  if (!safety.available) {
    reqLog.warn({ msg: 'item:safety-unavailable-fail-closed' });
    return res.status(503).json({ ok: false, error: 'safety_unavailable' });
  }
  if (safety.blocked.includes(hash)) {
    reqLog.warn({ msg: 'item:blocked-by-safety' });
    return res.status(422).json({ ok: false, error: 'blocked' });
  }

  // 2. Normalise meta into the fixed folder_items insert shape.
  const kind = KIND_VALUES.includes(meta.kind) ? meta.kind : 'other';
  const mimeType = typeof meta.mime_type === 'string' ? meta.mime_type : (file.mimetype || null);
  const title = typeof meta.title === 'string' ? meta.title : null;
  const capturedAt = typeof meta.captured_at === 'string' ? meta.captured_at : null;

  const supabase = await getServiceClient();

  // 3. If a stack was given, confirm it belongs to this user (service role
  //    bypasses RLS, so ownership is enforced here in code).
  if (stackId) {
    const { data: stackRow, error: stackErr } = await supabase
      .from('stone_collections')
      .select('id')
      .eq('id', stackId)
      .eq('owner_id', userId)
      .maybeSingle();
    if (stackErr) {
      reqLog.error({ msg: 'item:stack-check-failed', err: stackErr });
      return res.status(500).json({ ok: false, error: 'Internal error' });
    }
    if (!stackRow) {
      return res.status(404).json({ ok: false, error: 'stack not found' });
    }
  }

  // 4. Store the blob to R2 (EU). Key is opaque + owner-scoped; no filename
  //    (which can be identifying) is carried into the key.
  const r2Key = `cairn-import/${userId}/${randomUUID()}`;
  let stored;
  try {
    stored = await pickStorage().storeBuffer({
      buffer: file.buffer,
      key: r2Key,
      contentType: mimeType || 'application/octet-stream',
    });
  } catch (err) {
    reqLog.error({ msg: 'item:r2-store-failed', err });
    return res.status(502).json({ ok: false, error: 'storage failed' });
  }

  // 5. Insert the own-row folder_items record (NO-DELETE: status='active').
  const insertRow = {
    owner_id: userId,
    source: 'manual',
    kind,
    title,
    r2_key: r2Key,
    r2_jurisdiction: (process.env.R2_JURISDICTION || 'eu'),
    mime_type: mimeType,
    size_bytes: stored.size_bytes,
    captured_at: capturedAt,
    metadata: { import: { via: 'phone-importer', hash } },
    status: 'active',
  };
  const { data: item, error: insErr } = await supabase
    .from('folder_items')
    .insert(insertRow)
    .select()
    .single();
  if (insErr) {
    reqLog.error({ msg: 'item:insert-failed', err: insErr });
    return res.status(500).json({ ok: false, error: 'insert failed' });
  }

  // 6. Optional: link into the requested stack. The blob is already saved, so a
  //    link failure is logged but does not fail the item ingest.
  if (stackId) {
    const { error: linkErr } = await supabase
      .from('stone_collection_items')
      .insert({ collection_id: stackId, folder_item_id: item.id, owner_id: userId, added_by: 'user' });
    if (linkErr) reqLog.warn({ msg: 'item:stack-link-failed', err: linkErr });
  }

  reqLog.info({ msg: 'item:stored', kind, backend: stored.backend, stacked: Boolean(stackId) });
  return res.status(201).json({ ok: true, item });
});

/**
 * POST /api/import/stack
 * body: { name }  ->  stone_collections row
 *
 * Optional grouping (e.g. 'Brought home <date>') under own-row RLS.
 */
router.post('/stack', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId } = req.auth;
  const reqLog = log.child({ route: 'POST /api/import/stack', ownerIdTail: userId.slice(-4) });

  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > MAX_NAME_LEN) {
    return res.status(400).json({ ok: false, error: `name must be a non-empty string of at most ${MAX_NAME_LEN} chars` });
  }

  const supabase = await getServiceClient();
  const { data: stack, error } = await supabase
    .from('stone_collections')
    .insert({ owner_id: userId, name })
    .select()
    .single();
  if (error) {
    reqLog.error({ msg: 'stack:insert-failed', err: error });
    return res.status(500).json({ ok: false, error: 'insert failed' });
  }

  reqLog.info({ msg: 'stack:created' });
  return res.status(201).json({ ok: true, stack });
});

export default router;
