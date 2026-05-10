/**
 * Embedding binding interface.
 *
 * @typedef {Object} EmbeddingResult
 * @property {number[]} vector
 * @property {string} model
 * @property {number} dimensions
 *
 * @typedef {Object} EmbeddingBinding
 * @property {(text: string) => Promise<EmbeddingResult>} embed
 */

const STUB_DIMENSIONS = 1536;

/**
 * Compose the source text used to embed an UnderstandingRecord.
 *
 * The transcript is intentionally excluded — chatter would dominate visual
 * understanding for talky videos. The understander already distilled the
 * signal we want; embed that.
 *
 * @param {Pick<import('../schema.js').UnderstandingRecord, 'summary'|'visual_notes'|'suggested_tags'>} record
 * @returns {string|null} null if there is nothing to embed
 */
export function composeEmbeddingText(record) {
  const tags = Array.isArray(record?.suggested_tags) ? record.suggested_tags.join(', ') : '';
  const parts = [record?.summary, record?.visual_notes, tags]
    .map((s) => (s == null ? '' : String(s).trim()))
    .filter(Boolean);
  if (parts.length === 0) return null;
  return parts.join('\n');
}

/**
 * Stub embedder for tests that need a deterministic, no-cost vector. Returns
 * 1536 zeros (matching the production model's dimensionality) so callers can
 * shape-check results without burning OpenAI credit.
 *
 * @returns {EmbeddingBinding}
 */
export function createStubEmbedder() {
  return {
    async embed(_text) {
      return {
        vector: new Array(STUB_DIMENSIONS).fill(0),
        model: 'stub-zeros',
        dimensions: STUB_DIMENSIONS,
      };
    },
  };
}

export { createOpenAIEmbedder } from './openai.js';
