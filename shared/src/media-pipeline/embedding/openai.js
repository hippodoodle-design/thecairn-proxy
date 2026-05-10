import OpenAI from 'openai';
import { createLogger } from '../../logger.js';
import { EmbeddingError } from '../errors.js';

const log = createLogger('embedding-openai');

const MODEL = 'text-embedding-3-small';
const DIMENSIONS = 1536;

/**
 * Build an EmbeddingBinding backed by OpenAI's text-embedding-3-small.
 *
 * Lazy-init: the client is only constructed on first embed call so importing
 * this module doesn't require OPENAI_API_KEY to be present (matters for tests
 * that swap in createStubEmbedder).
 *
 * @returns {import('./index.js').EmbeddingBinding}
 */
export function createOpenAIEmbedder() {
  let client = null;
  function getClient() {
    if (client) return client;
    if (!process.env.OPENAI_API_KEY) {
      throw new EmbeddingError('OPENAI_API_KEY not set in environment');
    }
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return client;
  }

  return {
    async embed(text) {
      if (typeof text !== 'string' || text.length === 0) {
        throw new EmbeddingError('embed: text must be a non-empty string');
      }

      log.info({ msg: 'embed:start', chars: text.length });

      const openai = getClient();
      let response;
      try {
        response = await openai.embeddings.create({
          model: MODEL,
          input: text,
        });
      } catch (err) {
        const status = err?.status ?? err?.response?.status;
        if (status === 401) throw new EmbeddingError('Invalid OPENAI_API_KEY', { cause: err });
        if (status === 429) throw new EmbeddingError('Embedding API rate limit', { cause: err });
        throw new EmbeddingError(err?.message || String(err), { cause: err });
      }

      const vector = response?.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length !== DIMENSIONS) {
        throw new EmbeddingError(
          `embed: unexpected response shape (got length=${vector?.length})`,
        );
      }

      log.info({
        msg: 'embed:done',
        dimensions: vector.length,
        promptTokens: response.usage?.prompt_tokens,
      });

      return { vector, model: MODEL, dimensions: DIMENSIONS };
    },
  };
}
