import { readFile } from 'node:fs/promises';
import { request } from 'undici';
import { createLogger } from '../../logger.js';
import { SafetyError } from '../errors.js';

const log = createLogger('safety-iwf');

const IWF_TIMEOUT_MS = 5000;

/**
 * @typedef {Object} IwfScanResult
 * @property {boolean} matched
 * @property {string|null} hash
 * @property {string} source - 'iwf' | 'stub'
 * @property {boolean} [stubbed]
 *
 * @typedef {Object} IwfBinding
 * @property {(filePath: string) => Promise<IwfScanResult>} scan
 */

/**
 * Stub IWF binding — always returns no-match. Used when IWF_API_URL /
 * IWF_API_KEY are not yet configured. Logs every call so we can see the
 * scan path is exercised in dev.
 *
 * @returns {IwfBinding}
 */
export function createIwfStub() {
  return {
    async scan(filePath) {
      log.info({ msg: 'iwf-stub:scan', filePath, matched: false });
      return { matched: false, hash: null, source: 'stub', stubbed: true };
    },
  };
}

/**
 * Live IWF binding. Sends the image to the IWF Image Intercept endpoint via
 * HTTPS POST with the configured API key. Returns { matched, hash, source }.
 *
 * NOTE — scaffolded for real activation when Amanda's IWF Image Intercept
 * approval lands. The exact request shape (multipart vs raw, hash header
 * names, response fields) MUST be confirmed against IWF integration docs
 * before flipping a flag in production. Until then this binding is
 * env-guarded; missing creds means the stub is used instead.
 *
 * @returns {IwfBinding}
 */
export function createIwfLive() {
  const url = process.env.IWF_API_URL;
  const apiKey = process.env.IWF_API_KEY;
  if (!url || !apiKey) {
    throw new SafetyError('IWF_API_URL or IWF_API_KEY missing', { classification: 'config_error' });
  }

  return {
    async scan(filePath) {
      const start = Date.now();
      const body = await readFile(filePath);

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), IWF_TIMEOUT_MS);
      try {
        const res = await request(url, {
          method: 'POST',
          signal: ac.signal,
          headers: {
            'authorization': `Bearer ${apiKey}`,
            'content-type': 'application/octet-stream',
            'accept': 'application/json',
            // TODO confirm IWF expects 'X-Image-SHA256' or similar — placeholder.
          },
          body,
        });

        const status = res.statusCode;
        const text = await res.body.text();
        const ms = Date.now() - start;

        if (status === 401 || status === 403) {
          throw new SafetyError('IWF credentials rejected', {
            classification: 'config_error',
            cause: new Error(`status=${status}: ${text.slice(0, 200)}`),
          });
        }
        if (status >= 500) {
          // Don't block on IWF outage — log loudly. CSAM is a hard floor; an
          // upstream failure means we treat as not-matched but flag for ops.
          log.error({ msg: 'iwf-live:5xx', status, durationMs: ms });
          return { matched: false, hash: null, source: 'iwf', error: `status=${status}` };
        }
        if (status < 200 || status >= 300) {
          throw new SafetyError(`IWF non-2xx ${status}`, {
            classification: 'config_error',
            cause: new Error(text.slice(0, 200)),
          });
        }

        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          log.error({ msg: 'iwf-live:parse-failed', tail: text.slice(-200) });
          throw new SafetyError('IWF response not JSON', { classification: 'config_error', cause: err });
        }

        // TODO confirm field names against IWF spec when integrating live.
        const matched = parsed?.matched === true || parsed?.match === true;
        const hash = parsed?.hash ?? parsed?.matched_hash ?? null;
        log.info({ msg: 'iwf-live:scan', matched, durationMs: ms });
        return { matched, hash, source: 'iwf' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
