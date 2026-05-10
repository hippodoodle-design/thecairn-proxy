import { readFile } from 'node:fs/promises';
import { request } from 'undici';
import { createLogger } from '../../logger.js';

const log = createLogger('safety-nsfw');

const NSFW_TIMEOUT_MS = 5000;
// Cloudflare Workers AI binary NSFW classifier; outputs labels 'normal' / 'nsfw'.
const DEFAULT_MODEL = '@cf/falconsai/nsfw_image_detection';
const DEFAULT_THRESHOLD = 0.7;

/**
 * @typedef {Object} NsfwScanResult
 * @property {boolean} flagged
 * @property {number} confidence - 0..1; the score for the unsafe label
 * @property {string} label - the unsafe label name (or 'error' / 'skipped')
 * @property {string} [error]
 *
 * @typedef {Object} NsfwBinding
 * @property {(filePath: string) => Promise<NsfwScanResult|null>} scan
 */

/**
 * Skip binding — used when Cloudflare creds are absent. Returns null and
 * emits a single warning on first call so dev environments don't get spammed.
 *
 * @returns {NsfwBinding}
 */
export function createNsfwSkip() {
  let warned = false;
  return {
    async scan(_filePath) {
      if (!warned) {
        log.warn({
          msg: 'nsfw-skip:no-credentials',
          note: 'CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN missing — NSFW classification skipped',
        });
        warned = true;
      }
      return null;
    },
  };
}

/**
 * Live NSFW binding via Cloudflare Workers AI.
 *
 * Defence-in-depth, soft-flag only: a 5xx from Cloudflare is logged loudly but
 * does NOT block the image write — CSAM is the legal floor (handled by the
 * IWF binding); NSFW is convenience moderation, and an upstream outage must
 * not become a denial-of-service for the user's photo library.
 *
 * @returns {NsfwBinding}
 */
export function createNsfwLive(options = {}) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN missing');
  }

  const model = options.model ?? DEFAULT_MODEL;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;

  return {
    async scan(filePath) {
      const start = Date.now();
      let bytes;
      try {
        bytes = await readFile(filePath);
      } catch (err) {
        log.error({ msg: 'nsfw-live:read-failed', filePath, err });
        return { flagged: false, confidence: 0, label: 'error', error: err.message };
      }

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), NSFW_TIMEOUT_MS);
      try {
        const res = await request(url, {
          method: 'POST',
          signal: ac.signal,
          headers: {
            'authorization': `Bearer ${apiToken}`,
            'content-type': 'application/json',
            'accept': 'application/json',
          },
          body: JSON.stringify({ image: Array.from(bytes) }),
        });

        const status = res.statusCode;
        const text = await res.body.text();
        const ms = Date.now() - start;

        if (status >= 500) {
          // Soft-flag means: do NOT block writes on Cloudflare outage. The CSAM
          // path is the legal floor; this is defence-in-depth.
          log.error({ msg: 'nsfw-live:5xx', status, durationMs: ms });
          return { flagged: false, confidence: 0, label: 'error', error: `status=${status}` };
        }
        if (status === 401 || status === 403) {
          log.error({ msg: 'nsfw-live:auth-rejected', status });
          return { flagged: false, confidence: 0, label: 'error', error: `status=${status}` };
        }
        if (status < 200 || status >= 300) {
          log.error({ msg: 'nsfw-live:non-2xx', status, tail: text.slice(0, 200) });
          return { flagged: false, confidence: 0, label: 'error', error: `status=${status}` };
        }

        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          log.error({ msg: 'nsfw-live:parse-failed', tail: text.slice(-200) });
          return { flagged: false, confidence: 0, label: 'error', error: 'parse_failed' };
        }

        // Cloudflare wraps results in { result: [...], success, errors, messages }
        // Falconsai's NSFW model returns labels normal / nsfw with scores summing to 1.
        const items = Array.isArray(parsed?.result)
          ? parsed.result
          : Array.isArray(parsed?.result?.values)
            ? parsed.result.values
            : [];

        const unsafe = items.find((x) => /^(nsfw|porn|adult|explicit)$/i.test(String(x?.label || '')));
        const confidence = unsafe ? Number(unsafe.score ?? unsafe.confidence ?? 0) : 0;
        const label = unsafe ? String(unsafe.label) : 'normal';
        const flagged = confidence > threshold;

        log.info({ msg: 'nsfw-live:scan', label, confidence, flagged, durationMs: ms });

        return { flagged, confidence, label };
      } catch (err) {
        log.error({ msg: 'nsfw-live:threw', err });
        return { flagged: false, confidence: 0, label: 'error', error: err?.message || String(err) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
