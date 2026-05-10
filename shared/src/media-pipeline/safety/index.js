import { createLogger } from '../../logger.js';
import { SafetyError } from '../errors.js';
import { createIwfStub, createIwfLive } from './iwf.js';
import { createNsfwLive, createNsfwSkip } from './nsfw.js';

const log = createLogger('safety-scanner');

/**
 * @typedef {Object} SafetyResult
 * @property {'safe'|'flagged'|'csam_match'} classification
 * @property {{ matched: boolean, hash?: string|null, source?: string }} csam
 * @property {{ flagged: boolean, confidence: number, label: string, error?: string }|null} nsfw
 * @property {string} scanned_at - ISO timestamp
 * @property {number} scan_duration_ms
 *
 * @typedef {Object} SafetyScanner
 * @property {(filePath: string) => Promise<SafetyResult>} scan
 */

function pickIwfBinding() {
  if (process.env.IWF_API_URL && process.env.IWF_API_KEY) return createIwfLive();
  return createIwfStub();
}

function pickNsfwBinding() {
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) return createNsfwLive();
  return createNsfwSkip();
}

/**
 * Compose a SafetyScanner from IWF + NSFW bindings.
 *
 * Both checks run in parallel via Promise.all. If CSAM is matched, the
 * scanner returns classification='csam_match' immediately — the caller is
 * expected to throw SafetyError and skip the storage write. NSFW result is
 * preserved when present but treated as advisory: callers store flagged
 * images and queue them for review.
 *
 * @param {{ iwf?: import('./iwf.js').IwfBinding, nsfw?: import('./nsfw.js').NsfwBinding }} [options]
 * @returns {SafetyScanner}
 */
export function createSafetyScanner(options = {}) {
  const iwf = options.iwf ?? pickIwfBinding();
  const nsfw = options.nsfw ?? pickNsfwBinding();

  return {
    async scan(filePath) {
      const start = Date.now();
      log.info({ msg: 'safety:scan-start', filePath });

      // CSAM check is the hard gate; NSFW is advisory. Run both in parallel
      // for the common 'safe' path; on a CSAM match the NSFW result is
      // preserved (could be useful in the incident record) but the
      // classification dominates.
      const [iwfResult, nsfwResult] = await Promise.all([
        iwf.scan(filePath).catch((err) => {
          // IWF binding errors are fatal — treat as a config_error.
          throw err instanceof SafetyError
            ? err
            : new SafetyError(`iwf scan threw: ${err?.message || err}`, {
                classification: 'config_error',
                cause: err,
              });
        }),
        nsfw.scan(filePath).catch((err) => {
          // NSFW errors don't fail the scan — soft-flag remember? Return null.
          log.error({ msg: 'safety:nsfw-threw', err });
          return null;
        }),
      ]);

      const scanned_at = new Date().toISOString();
      const scan_duration_ms = Date.now() - start;

      const csam = {
        matched: iwfResult?.matched === true,
        hash: iwfResult?.hash ?? null,
        source: iwfResult?.source ?? 'unknown',
      };

      let classification;
      if (csam.matched) classification = 'csam_match';
      else if (nsfwResult?.flagged === true) classification = 'flagged';
      else classification = 'safe';

      const result = {
        classification,
        csam,
        nsfw: nsfwResult ?? null,
        scanned_at,
        scan_duration_ms,
      };

      log.info({
        msg: 'safety:scan-done',
        classification,
        csamMatched: csam.matched,
        nsfwFlagged: nsfwResult?.flagged ?? null,
        nsfwConfidence: nsfwResult?.confidence ?? null,
        durationMs: scan_duration_ms,
      });

      return result;
    },
  };
}

export { createIwfStub, createIwfLive } from './iwf.js';
export { createNsfwLive, createNsfwSkip } from './nsfw.js';

/**
 * Helper: scan a frame, throw on CSAM match, otherwise write to storage and
 * return the storage result alongside the safety result. Used by every code
 * path that wants to put bytes into R2 — pipeline peakapoo, harvest frames,
 * future direct uploads.
 *
 * @param {Object} args
 * @param {SafetyScanner} args.scanner
 * @param {import('../storage/index.js').StorageBinding} args.storage
 * @param {string} args.filePath
 * @param {Object} [args.storeOptions]
 * @returns {Promise<{ stored: { key: string, size_bytes: number, backend: string }, safety: SafetyResult }>}
 */
export async function scanThenStoreFrame({ scanner, storage, filePath, storeOptions = {} }) {
  const safety = await scanner.scan(filePath);

  if (safety.classification === 'csam_match') {
    log.error({
      msg: 'safety:scan-then-store-blocked',
      source: safety.csam.source,
      hash: safety.csam.hash,
      filePath,
    });
    throw new SafetyError('csam-detected', {
      classification: 'csam_match',
      details: {
        hash: safety.csam.hash,
        source: safety.csam.source,
        scanned_at: safety.scanned_at,
      },
    });
  }

  const stored = await storage.storeFrame(filePath, storeOptions);
  return { stored, safety };
}
