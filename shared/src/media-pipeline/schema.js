/**
 * @typedef {Object} TranscriptSegment
 * @property {number} start_ms
 * @property {number} end_ms
 * @property {string} text
 */

/**
 * @typedef {Object} Transcript
 * @property {string} language - ISO language code or 'unknown'
 * @property {TranscriptSegment[]} segments
 * @property {string} full_text
 */

/**
 * @typedef {Object} SafetyResult
 * @property {'safe'|'flagged'|'csam_match'} classification
 * @property {{ matched: boolean, hash?: string|null, source?: string }} csam
 * @property {{ flagged: boolean, confidence: number, label: string, error?: string }|null} nsfw
 * @property {string} scanned_at - ISO timestamp
 * @property {number} scan_duration_ms
 */

/**
 * @typedef {Object} Peakapoo
 * @property {string|null} frame_r2_key - R2 object key where the chosen frame is stored; null until Phase 5 writes it
 * @property {number} frame_timestamp_ms - timestamp in source video
 * @property {string|null} why_this_frame - brief LLM reasoning, useful for surfacing later
 * @property {SafetyResult|null} safety - Phase 8 IWF + NSFW scan outcome attached at storage time
 */

/**
 * @typedef {Object} HarvestCandidate
 * @property {number} frame_index - 0-based position in the ingest-time frames array
 * @property {number} timestamp_ms - timestamp in source video; resolved from frames at ingest time
 * @property {string} reasoning - brief why-this-moment string from the understander
 */

/**
 * @typedef {('personal'|'fitness'|'food'|'music'|'art'|'lecture'|'other')} VideoCategory
 *
 * Drives downstream UX. 'personal' enables the harvest-more (5/10/15 frames) offer.
 * Other categories receive the auto-peakapoo only.
 */

/**
 * @typedef {('complete'|'weak')} UnderstandingStatus
 *
 * 'weak' marks understandings the model couldn't pull a confident read on
 * (e.g. very low signal, censored content, dark frames). 'weak' stones can be
 * offered a one-time re-understand pass with denser frames and high-detail
 * vision; 'complete' stones don't need it.
 */

/**
 * @typedef {Object} ProcessingMeta
 * @property {string} completed_at - ISO timestamp
 * @property {string} pipeline_version
 * @property {string[]} errors - non-fatal errors encountered during processing
 */

/**
 * @typedef {Object} UnderstandingRecord
 *
 * The structured understanding record produced by the media pipeline.
 * Persisted at stones.metadata.media_pipeline. The embedding column on
 * stones is the indexed source of truth for similarity search; the embedding
 * field here is a redundant preview kept for inspection / debug parity.
 *
 * @property {string} source_url
 * @property {string} platform - youtube|tiktok|facebook|instagram|local-file|unknown
 * @property {number} duration_seconds
 * @property {string|null} title
 * @property {string|null} uploader
 * @property {string} language
 * @property {VideoCategory} video_category
 * @property {Transcript|null} transcript
 * @property {string|null} visual_notes
 * @property {string[]} suggested_tags
 * @property {string|null} summary
 * @property {Peakapoo|null} peakapoo
 * @property {HarvestCandidate[]} harvest_candidates - empty unless personal
 * @property {number[]|null} embedding - 1536-d preview; column is the indexed copy
 * @property {UnderstandingStatus} understanding_status
 * @property {boolean} reunderstand_attempted - true after a re-understand has run
 * @property {ProcessingMeta} processing
 */

export const PIPELINE_VERSION = 'v0.8.0-safety-rails';

/**
 * Decide whether an understanding came back strong enough to surface, or
 * should be offered a re-understand pass. The rule is intentionally narrow —
 * the goal is to catch genuinely empty results, not punish low-information
 * but valid videos (a clean shot of a sunset is allowed to be 'other' with a
 * thin summary).
 *
 * @param {Pick<UnderstandingRecord, 'video_category'|'summary'|'visual_notes'>} record
 * @returns {UnderstandingStatus}
 */
export function deriveUnderstandingStatus(record) {
  const summaryEmpty = !record?.summary || String(record.summary).trim().length === 0;
  const notesEmpty = !record?.visual_notes || String(record.visual_notes).trim().length === 0;
  if (record?.video_category === 'other' && summaryEmpty && notesEmpty) return 'weak';
  return 'complete';
}

/**
 * Build a stub UnderstandingRecord. Used as the starting shape; the pipeline
 * overlays real values on top as each phase comes online.
 * @param {string} sourceUrl
 * @returns {UnderstandingRecord}
 */
export function buildStubUnderstandingRecord(sourceUrl) {
  return {
    source_url: sourceUrl,
    platform: 'unknown',
    duration_seconds: 0,
    title: null,
    uploader: null,
    language: 'unknown',
    video_category: 'other',
    transcript: null,
    visual_notes: null,
    suggested_tags: [],
    summary: null,
    peakapoo: null,
    harvest_candidates: [],
    embedding: null,
    understanding_status: 'weak',
    reunderstand_attempted: false,
    processing: {
      completed_at: new Date().toISOString(),
      pipeline_version: PIPELINE_VERSION,
      errors: [],
    },
  };
}
