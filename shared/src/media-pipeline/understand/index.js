/**
 * Multimodal understanding binding interface.
 *
 * @typedef {Object} ExtractedFrame
 * @property {number} index - 0-based position in chronological order
 * @property {number} timestamp_ms - timestamp in source video
 * @property {string} file_path - path to the .jpg on disk
 *
 * @typedef {Object} UnderstanderInput
 * @property {ExtractedFrame[]} frames
 * @property {import('../schema.js').Transcript|null} transcript
 * @property {{ duration_seconds: number, title?: string|null, uploader?: string|null }} sourceMetadata
 *
 * @typedef {Object} HarvestCandidateRaw
 * @property {number} frame_index
 * @property {string} reasoning
 *
 * @typedef {Object} UnderstanderResult
 * @property {string|null} visual_notes
 * @property {string|null} summary
 * @property {string[]} suggested_tags
 * @property {import('../schema.js').VideoCategory} video_category
 * @property {number|null} peakapoo_frame_index - integer 0..frames.length-1, or null if no frame chosen
 * @property {string|null} peakapoo_reasoning
 * @property {HarvestCandidateRaw[]} harvest_candidates - up to 15 ranked candidates; always [] for non-personal
 *
 * @typedef {Object} UnderstanderBinding
 * @property {(input: UnderstanderInput, options?: { vision_detail?: 'low'|'high' }) => Promise<UnderstanderResult>} understand
 */

/**
 * Stub understander — returns minimal defaults. Useful for tests that want to
 * bypass the GPT-4o vision call and assert on the rest of the pipeline.
 *
 * @returns {UnderstanderBinding}
 */
export function createStubUnderstander() {
  return {
    async understand(_input, _options) {
      return {
        visual_notes: null,
        summary: null,
        suggested_tags: [],
        video_category: 'other',
        peakapoo_frame_index: null,
        peakapoo_reasoning: null,
        harvest_candidates: [],
      };
    },
  };
}

export { createGpt4oUnderstander } from './gpt4o.js';
