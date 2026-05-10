/**
 * @typedef {Object} AcquirerMetadata
 * @property {string} platform
 * @property {string|null} title
 * @property {string|null} uploader
 * @property {number} duration_seconds
 * @property {string|null} upload_date - YYYYMMDD as yt-dlp emits it
 * @property {string} extractor - raw yt-dlp extractor name, kept for debugging
 */

/**
 * @typedef {Object} AcquirerResult
 * @property {string} file_path
 * @property {number} size_bytes
 * @property {AcquirerMetadata} metadata
 */

/**
 * @typedef {Object} AcquirerOptions
 * @property {string} workdir - directory the binding may write into
 * @property {number} [maxDurationSeconds] - hard cap; binding throws TooLongError before downloading
 *
 * @typedef {Object} AcquirerBinding
 * @property {(url: string, options: AcquirerOptions) => Promise<AcquirerResult>} acquire
 */

/**
 * Phase 2 default ceiling. A later phase swaps this for per-user wallet logic.
 */
export const DEFAULT_MAX_DURATION_SECONDS = 3600;

/**
 * Map yt-dlp's extractor identifier to our internal platform enum.
 * yt-dlp emits the lowercased extractor name (e.g. "youtube", "youtube:tab",
 * "tiktok", "instagram"). We collapse subtypes (youtube:tab, youtube:user, etc.)
 * onto the parent platform.
 *
 * @param {string} extractor
 * @returns {'youtube'|'tiktok'|'facebook'|'instagram'|'vimeo'|'x'|'unknown'}
 */
export function mapExtractorToPlatform(extractor) {
  const e = String(extractor || '').toLowerCase();
  if (e === 'youtube' || e.startsWith('youtube:')) return 'youtube';
  if (e === 'tiktok' || e.startsWith('tiktok:')) return 'tiktok';
  if (e === 'facebook' || e.startsWith('facebook:')) return 'facebook';
  if (e === 'instagram' || e.startsWith('instagram:')) return 'instagram';
  if (e === 'vimeo' || e.startsWith('vimeo:')) return 'vimeo';
  if (e === 'twitter' || e.startsWith('twitter:') || e === 'x' || e.startsWith('x:')) return 'x';
  return 'unknown';
}
