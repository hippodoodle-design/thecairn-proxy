import { Router } from 'express';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getServiceClient } from '@cairn/shared/supabase';
import { createLogger } from '@cairn/shared/logger';
import { createSafetyScanner } from '@cairn/shared/media-pipeline';
import { createR2Storage, createStubStorage } from '@cairn/shared/media-pipeline/storage';
import { drawPersonality, drawUploadedPersonality } from '@cairn/shared/companions';
import { requireAuth } from '../middleware/auth.js';
import { rateLimitPerUser } from '../middleware/rateLimit.js';

const log = createLogger('companions-route');

const DIMENSIONS = ['1d', '2d', '3d'];
const ACCESSORY_SLOTS = ['collar', 'jersey', 'shorts', 'none'];

// Uploaded 1D pets: a child's drawing. Keep the surface tiny + safe.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB
const UPLOAD_TYPES = {
  'image/png': 'png',
  'image/svg+xml': 'svg',
};

/**
 * Storage backend selector. Real R2 when configured; the filesystem stub
 * otherwise (matches the media-pipeline convention so dev works without R2
 * credentials). R2 needs R2_ACCOUNT_ID + R2_BUCKET (+ Buddy/env secret creds).
 */
function pickStorage() {
  if (process.env.R2_ACCOUNT_ID && process.env.R2_BUCKET) return createR2Storage();
  return createStubStorage();
}

/**
 * Best-effort append to the companion audit log. A failed event write never
 * fails the user-facing request — the lifecycle action already succeeded; the
 * audit row is secondary. Failures are logged so they're traceable.
 */
async function emitEvent(supabase, reqLog, userCompanionId, event, payload = {}) {
  try {
    const { error } = await supabase
      .from('companion_events')
      .insert({ user_companion_id: userCompanionId, event, payload });
    if (error) reqLog.warn({ msg: 'companion_event:insert-failed', event, err: error });
  } catch (err) {
    reqLog.warn({ msg: 'companion_event:threw', event, err });
  }
}

/** Validate an accessory payload: null, or { slot, style? } with a known slot. */
function validateAccessory(accessory) {
  if (accessory == null) return { ok: true, value: null };
  if (typeof accessory !== 'object' || Array.isArray(accessory)) {
    return { ok: false, error: 'accessory must be an object or null' };
  }
  if (accessory.slot != null && !ACCESSORY_SLOTS.includes(accessory.slot)) {
    return { ok: false, error: `accessory.slot must be one of ${ACCESSORY_SLOTS.join(', ')}` };
  }
  return { ok: true, value: accessory };
}

/** Load a user's own companion row by id, or null. Service role bypasses RLS,
 *  so ownership is enforced here by filtering on user_id. */
async function loadOwnedCompanion(supabase, userId, id) {
  const { data, error } = await supabase
    .from('user_companions')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return { error };
  return { row: data ?? null };
}

const router = Router();

/**
 * GET /api/companions
 * The pickable registry — live species only. Public-ish data, but served
 * behind auth like the rest of the Cairn API.
 */
router.get('/', requireAuth, rateLimitPerUser, async (req, res) => {
  const reqLog = log.child({ route: 'GET /api/companions' });
  try {
    const supabase = await getServiceClient();
    const { data, error } = await supabase
      .from('companions')
      .select('id, slug, display_name, dimensions_available, default_accessory_slots, asset_paths, status')
      .eq('status', 'live')
      .order('display_name', { ascending: true });
    if (error) {
      reqLog.error({ msg: 'registry read failed', err: error });
      return res.status(500).json({ ok: false, error: 'Could not load companions' });
    }
    return res.json({ ok: true, companions: data ?? [] });
  } catch (err) {
    reqLog.error({ msg: 'registry threw', err });
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

/**
 * GET /api/companions/mine
 * Every companion this user has ever had — active, in the Zoo, or retired.
 * Retired pets are kept indefinitely; they're the user's memory.
 */
router.get('/mine', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId } = req.auth;
  const reqLog = log.child({ route: 'GET /api/companions/mine', ownerIdTail: userId.slice(-4) });
  try {
    const supabase = await getServiceClient();
    const { data, error } = await supabase
      .from('user_companions')
      .select('*, companion:companions (slug, display_name, asset_paths, dimensions_available)')
      .eq('user_id', userId)
      .order('chosen_at', { ascending: false });
    if (error) {
      reqLog.error({ msg: 'mine read failed', err: error });
      return res.status(500).json({ ok: false, error: 'Could not load your companions' });
    }
    return res.json({ ok: true, companions: data ?? [] });
  } catch (err) {
    reqLog.error({ msg: 'mine threw', err });
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

/**
 * POST /api/companions/pick
 * body: { companion_id, dimension?, name?, accessory? }
 * User picks a companion from the registry. Creates a user_companion + a
 * 'picked' event (plus 'named'/'accessory_changed' when those are set).
 */
router.post('/pick', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId } = req.auth;
  const reqLog = log.child({ route: 'POST /api/companions/pick', ownerIdTail: userId.slice(-4) });

  const { companion_id, dimension, name, accessory } = req.body ?? {};
  if (typeof companion_id !== 'string' || !companion_id) {
    return res.status(400).json({ ok: false, error: 'companion_id is required' });
  }
  if (name != null && typeof name !== 'string') {
    return res.status(400).json({ ok: false, error: 'name must be a string' });
  }
  const acc = validateAccessory(accessory);
  if (!acc.ok) return res.status(400).json({ ok: false, error: acc.error });

  try {
    const supabase = await getServiceClient();

    const { data: companion, error: cErr } = await supabase
      .from('companions')
      .select('id, dimensions_available, status, personality_distribution')
      .eq('id', companion_id)
      .maybeSingle();
    if (cErr) {
      reqLog.error({ msg: 'pick: companion lookup failed', err: cErr });
      return res.status(500).json({ ok: false, error: 'Internal error' });
    }
    if (!companion || companion.status !== 'live') {
      return res.status(404).json({ ok: false, error: 'companion not found' });
    }

    let preferred = dimension ?? '2d';
    if (!DIMENSIONS.includes(preferred)) {
      return res.status(400).json({ ok: false, error: `dimension must be one of ${DIMENSIONS.join(', ')}` });
    }
    if (!(companion.dimensions_available ?? []).includes(preferred)) {
      return res.status(400).json({ ok: false, error: `that companion is not available in ${preferred}` });
    }

    // You don't choose your pet's personality — you meet it. Drawn once, here,
    // from the species distribution; never taken from the request. Fixed after.
    const personality = drawPersonality(companion.personality_distribution);

    const { data: row, error: insErr } = await supabase
      .from('user_companions')
      .insert({
        user_id: userId,
        companion_id,
        is_user_uploaded: false,
        custom_name: name ?? null,
        accessory: acc.value,
        preferred_dimension: preferred,
        personality_traits: personality,
        last_active_at: new Date().toISOString(),
        status: 'active',
      })
      .select('*')
      .single();
    if (insErr) {
      reqLog.error({ msg: 'pick: insert failed', err: insErr });
      return res.status(500).json({ ok: false, error: 'Could not pick that companion' });
    }

    await emitEvent(supabase, reqLog, row.id, 'picked', { companion_id, dimension: preferred });
    if (name) await emitEvent(supabase, reqLog, row.id, 'named', { name });
    if (acc.value) await emitEvent(supabase, reqLog, row.id, 'accessory_changed', { accessory: acc.value });

    reqLog.info({ msg: 'pick: done', userCompanionId: row.id });
    return res.status(201).json({ ok: true, companion: row });
  } catch (err) {
    reqLog.error({ msg: 'pick threw', err });
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

/**
 * POST /api/companions/upload-1d
 * body: { image_base64, content_type, name?, accessory? }
 * The magic move: a user uploads a child's drawing and it becomes a unique-to-
 * them 1D companion. The image runs through the existing Cairn safety pipeline
 * (IWF CSAM hash-match + Cloudflare NSFW). A CSAM match is rejected with a kind
 * message and NO row is created. The wobble of the drawing is the feature — we
 * never auto-smooth it.
 *
 * NOTE: requires a large-body JSON parser mounted ahead of the global 32kb one
 * in server.js (see app.use('/api/companions/upload-1d', ...)).
 */
router.post('/upload-1d', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId } = req.auth;
  const reqLog = log.child({ route: 'POST /api/companions/upload-1d', ownerIdTail: userId.slice(-4) });

  const { image_base64, content_type, name, accessory } = req.body ?? {};
  if (typeof image_base64 !== 'string' || !image_base64) {
    return res.status(400).json({ ok: false, error: 'image_base64 is required' });
  }
  const ext = UPLOAD_TYPES[content_type];
  if (!ext) {
    return res.status(400).json({ ok: false, error: 'content_type must be image/png or image/svg+xml' });
  }
  if (name != null && typeof name !== 'string') {
    return res.status(400).json({ ok: false, error: 'name must be a string' });
  }
  const acc = validateAccessory(accessory);
  if (!acc.ok) return res.status(400).json({ ok: false, error: acc.error });

  let bytes;
  try {
    bytes = Buffer.from(image_base64, 'base64');
  } catch {
    return res.status(400).json({ ok: false, error: 'image_base64 is not valid base64' });
  }
  if (bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) {
    return res.status(400).json({ ok: false, error: 'image must be between 1 byte and 5 MB' });
  }

  // SVG carries an XSS risk (embedded <script>, event handlers, javascript: URLs).
  // Lightweight rejection of obviously-dangerous markup here; a full server-side
  // SVG sanitizer (e.g. DOMPurify) is a recommended follow-up before these are
  // ever served inline rather than via <img>.
  if (ext === 'svg') {
    const svgText = bytes.toString('utf8').toLowerCase();
    if (svgText.includes('<script') || svgText.includes('javascript:') || /\son\w+\s*=/.test(svgText)) {
      reqLog.warn({ msg: 'upload-1d: svg rejected for active content' });
      return res.status(422).json({ ok: false, error: "we couldn't add this one — try a different drawing" });
    }
  }

  const tmpDir = mkdtempSync(path.join(tmpdir(), 'cairn-1d-'));
  const tmpFile = path.join(tmpDir, `upload.${ext}`);
  try {
    writeFileSync(tmpFile, bytes);

    // Safety pipeline — same scanner the media pipeline uses. CSAM is the hard
    // gate; NSFW is advisory but for a user-facing 1D pet we reject flagged too.
    const scanner = createSafetyScanner();
    const safety = await scanner.scan(tmpFile);
    if (safety.classification === 'csam_match' || safety.classification === 'flagged') {
      reqLog.warn({ msg: 'upload-1d: rejected by safety', classification: safety.classification });
      return res.status(422).json({ ok: false, error: "we couldn't add this one — try a different drawing" });
    }

    const storage = pickStorage();
    const key = `companions/${userId}/${randomUUID()}.${ext}`;
    const stored = await storage.storeObject({ filePath: tmpFile, key, contentType: content_type });

    const supabase = await getServiceClient();
    const { data: row, error: insErr } = await supabase
      .from('user_companions')
      .insert({
        user_id: userId,
        companion_id: null,
        is_user_uploaded: true,
        user_uploaded_asset_path: stored.key,
        custom_name: name ?? null,
        accessory: acc.value,
        preferred_dimension: '1d', // a child's drawing is inherently 1D
        personality_traits: drawUploadedPersonality(), // uploaded pets get a charming generic spread
        last_active_at: new Date().toISOString(),
        status: 'active',
      })
      .select('*')
      .single();
    if (insErr) {
      reqLog.error({ msg: 'upload-1d: insert failed', err: insErr });
      return res.status(500).json({ ok: false, error: 'Could not add your drawing' });
    }

    await emitEvent(supabase, reqLog, row.id, 'uploaded_1d', { asset_path: stored.key });
    if (name) await emitEvent(supabase, reqLog, row.id, 'named', { name });
    if (acc.value) await emitEvent(supabase, reqLog, row.id, 'accessory_changed', { accessory: acc.value });

    reqLog.info({ msg: 'upload-1d: done', userCompanionId: row.id, backend: stored.backend });
    return res.status(201).json({ ok: true, companion: row });
  } catch (err) {
    reqLog.error({ msg: 'upload-1d threw', err });
    return res.status(500).json({ ok: false, error: 'Internal error' });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

/**
 * POST /api/companions/:id/update
 * body: { name?, accessory?, dimension? }
 * Change name / accessory / dimension. Identity persists across dimension
 * switches. Emits the matching events. Choices Stay Open — everything here is
 * undoable by calling again.
 */
router.post('/:id/update', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId } = req.auth;
  const { id } = req.params;
  const reqLog = log.child({ route: 'POST /api/companions/:id/update', ownerIdTail: userId.slice(-4) });

  const { name, accessory, dimension } = req.body ?? {};
  if (name === undefined && accessory === undefined && dimension === undefined) {
    return res.status(400).json({ ok: false, error: 'nothing to update' });
  }
  if (name != null && typeof name !== 'string') {
    return res.status(400).json({ ok: false, error: 'name must be a string' });
  }
  if (dimension !== undefined && !DIMENSIONS.includes(dimension)) {
    return res.status(400).json({ ok: false, error: `dimension must be one of ${DIMENSIONS.join(', ')}` });
  }
  const acc = accessory === undefined ? null : validateAccessory(accessory);
  if (acc && !acc.ok) return res.status(400).json({ ok: false, error: acc.error });

  try {
    const supabase = await getServiceClient();
    const { row, error: loadErr } = await loadOwnedCompanion(supabase, userId, id);
    if (loadErr) {
      reqLog.error({ msg: 'update: load failed', err: loadErr });
      return res.status(500).json({ ok: false, error: 'Internal error' });
    }
    if (!row) return res.status(404).json({ ok: false, error: 'companion not found' });

    const patch = {};
    if (name !== undefined) patch.custom_name = name;
    if (accessory !== undefined) patch.accessory = acc.value;
    if (dimension !== undefined) patch.preferred_dimension = dimension;

    const { data: updated, error: updErr } = await supabase
      .from('user_companions')
      .update(patch)
      .eq('id', id)
      .eq('user_id', userId)
      .select('*')
      .single();
    if (updErr) {
      reqLog.error({ msg: 'update: write failed', err: updErr });
      return res.status(500).json({ ok: false, error: 'Could not update your companion' });
    }

    if (name !== undefined) await emitEvent(supabase, reqLog, id, 'named', { name });
    if (accessory !== undefined) await emitEvent(supabase, reqLog, id, 'accessory_changed', { accessory: acc.value });
    if (dimension !== undefined) await emitEvent(supabase, reqLog, id, 'dimension_changed', { dimension });

    return res.json({ ok: true, companion: updated });
  } catch (err) {
    reqLog.error({ msg: 'update threw', err });
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

/** Shared status-transition handler for return-to-zoo / leave-zoo / retire. */
function makeTransition({ routeName, event, patch }) {
  return async (req, res) => {
    const { userId } = req.auth;
    const { id } = req.params;
    const reqLog = log.child({ route: routeName, ownerIdTail: userId.slice(-4) });
    try {
      const supabase = await getServiceClient();
      const { row, error: loadErr } = await loadOwnedCompanion(supabase, userId, id);
      if (loadErr) {
        reqLog.error({ msg: 'transition: load failed', err: loadErr });
        return res.status(500).json({ ok: false, error: 'Internal error' });
      }
      if (!row) return res.status(404).json({ ok: false, error: 'companion not found' });

      const { data: updated, error: updErr } = await supabase
        .from('user_companions')
        .update(patch())
        .eq('id', id)
        .eq('user_id', userId)
        .select('*')
        .single();
      if (updErr) {
        reqLog.error({ msg: 'transition: write failed', err: updErr });
        return res.status(500).json({ ok: false, error: 'Could not update your companion' });
      }

      await emitEvent(supabase, reqLog, id, event, {});
      return res.json({ ok: true, companion: updated });
    } catch (err) {
      reqLog.error({ msg: 'transition threw', err });
      return res.status(500).json({ ok: false, error: 'Internal error' });
    }
  };
}

// The Goodbye Wave: device closes, the companion pads back to the Zoo. Safe.
router.post('/:id/return-to-zoo', requireAuth, rateLimitPerUser, makeTransition({
  routeName: 'POST /api/companions/:id/return-to-zoo',
  event: 'returned_to_zoo',
  patch: () => ({ status: 'in_zoo', in_zoo_at: new Date().toISOString() }),
}));

// Welcome back: session starts, the companion leaves the Zoo to be with the user.
router.post('/:id/leave-zoo', requireAuth, rateLimitPerUser, makeTransition({
  routeName: 'POST /api/companions/:id/leave-zoo',
  event: 'left_zoo',
  patch: () => ({ status: 'active', last_active_at: new Date().toISOString() }),
}));

// The user moves on. The pet isn't lost — it stays in the Zoo, named + dressed,
// and can be switched back to anytime.
router.post('/:id/retire', requireAuth, rateLimitPerUser, makeTransition({
  routeName: 'POST /api/companions/:id/retire',
  event: 'retired',
  patch: () => ({ status: 'retired', in_zoo_at: new Date().toISOString() }),
}));

/**
 * Species requests live at their own mount (/api/species-requests). Any authed
 * user may submit; reads are team-only (enforced by RLS — no authenticated
 * SELECT grant).
 */
const speciesRequestsRouter = Router();

speciesRequestsRouter.post('/', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId } = req.auth;
  const reqLog = log.child({ route: 'POST /api/species-requests', ownerIdTail: userId.slice(-4) });

  const { species_requested, reason, cultural_significance } = req.body ?? {};
  if (typeof species_requested !== 'string' || !species_requested.trim()) {
    return res.status(400).json({ ok: false, error: 'species_requested is required' });
  }
  if (reason != null && typeof reason !== 'string') {
    return res.status(400).json({ ok: false, error: 'reason must be a string' });
  }
  if (cultural_significance != null && typeof cultural_significance !== 'string') {
    return res.status(400).json({ ok: false, error: 'cultural_significance must be a string' });
  }

  try {
    const supabase = await getServiceClient();
    const { data, error } = await supabase
      .from('species_requests')
      .insert({
        user_id: userId,
        species_requested: species_requested.trim(),
        reason: reason ?? null,
        cultural_significance: cultural_significance ?? null,
        status: 'new',
      })
      .select('id, submitted_at, status')
      .single();
    if (error) {
      reqLog.error({ msg: 'species-request: insert failed', err: error });
      return res.status(500).json({ ok: false, error: 'Could not submit your request' });
    }
    reqLog.info({ msg: 'species-request: submitted', requestId: data.id });
    return res.status(201).json({ ok: true, request: data });
  } catch (err) {
    reqLog.error({ msg: 'species-request threw', err });
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

export default router;
export { speciesRequestsRouter };
