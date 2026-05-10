import { Router } from 'express';
import { getServiceClient } from '@cairn/shared/supabase';
import { signR2Url } from '@cairn/shared/media-pipeline/storage';
import { createLogger } from '@cairn/shared/logger';
import { requireAuth } from '../middleware/auth.js';
import { rateLimitPerUser } from '../middleware/rateLimit.js';

const router = Router();
const log = createLogger('r2-sign-route');

const MAX_KEYS = 100;
const TTL_SECONDS = 21600; // 6 hours

/**
 * POST /api/r2/sign
 * body: { keys: string[] }
 *
 * Exchanges a batch of R2 object keys for time-limited signed URLs the
 * frontend can render. Ownership is enforced server-side: a key is signed
 * iff the requesting user owns either
 *   (a) a stone whose metadata.media_pipeline.peakapoo.frame_r2_key matches it, or
 *   (b) a galleries row whose file_path matches it (harvest frames + ingest peakapoos
 *       both store their R2 key in galleries.file_path).
 *
 * Keys not owned by the user — or that fail to sign for transient reasons —
 * are simply absent from the response map; the request itself still returns 200.
 * Per-key signing failures are logged with the key so they're traceable.
 */
router.post('/sign', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId } = req.auth;
  const reqLog = log.child({ route: 'POST /api/r2/sign', ownerIdTail: userId.slice(-4) });

  const keys = req.body?.keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_KEYS) {
    return res.status(400).json({
      ok: false,
      error: `keys must be a non-empty array of at most ${MAX_KEYS} strings`,
    });
  }
  if (!keys.every((k) => typeof k === 'string' && k.length > 0)) {
    return res.status(400).json({ ok: false, error: 'every key must be a non-empty string' });
  }

  // Dedupe — the response is keyed by string anyway, and downstream queries
  // are fed the same set.
  const requested = new Set(keys);
  const requestedKeys = [...requested];

  try {
    const supabase = getServiceClient();

    // Stones path: select only the JSON-path projection so we don't drag the
    // full metadata blob across the wire. Each row is { peakapoo_key: string|null }.
    const { data: stoneRows, error: stoneErr } = await supabase
      .from('stones')
      .select('peakapoo_key:metadata->media_pipeline->peakapoo->>frame_r2_key')
      .eq('owner_id', userId);

    if (stoneErr) {
      reqLog.error({ msg: 'sign:stones-query-failed', err: stoneErr });
      return res.status(500).json({ ok: false, error: 'Could not verify ownership' });
    }

    // Galleries path: column-level filter, server-side. file_path holds the
    // R2 key for both ingest peakapoos and harvest photo-from-video rows.
    const { data: galleryRows, error: galleryErr } = await supabase
      .from('galleries')
      .select('file_path')
      .eq('owner_id', userId)
      .in('file_path', requestedKeys);

    if (galleryErr) {
      reqLog.error({ msg: 'sign:galleries-query-failed', err: galleryErr });
      return res.status(500).json({ ok: false, error: 'Could not verify ownership' });
    }

    const owned = new Set();
    for (const row of stoneRows ?? []) {
      const k = row?.peakapoo_key;
      if (k && requested.has(k)) owned.add(k);
    }
    for (const row of galleryRows ?? []) {
      const k = row?.file_path;
      if (k) owned.add(k);
    }

    const urls = {};
    let signFailures = 0;

    // Sign in parallel — each is an independent presign, no remote call until
    // the URL is fetched. Per-key failure is swallowed (logged) so the batch
    // succeeds for every other key.
    const results = await Promise.all(
      [...owned].map(async (key) => {
        try {
          const url = await signR2Url(key, TTL_SECONDS);
          return { key, url };
        } catch (err) {
          reqLog.error({ msg: 'sign:per-key-failed', key, err });
          signFailures += 1;
          return null;
        }
      }),
    );

    for (const r of results) {
      if (r) urls[r.key] = r.url;
    }

    reqLog.info({
      msg: 'sign:done',
      requested: requestedKeys.length,
      owned: owned.size,
      signed: Object.keys(urls).length,
      signFailures,
    });

    return res.json({ urls });
  } catch (err) {
    reqLog.error({ msg: 'sign:threw', err });
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

export default router;
