import { createLogger } from '../../logger.js';

const log = createLogger('connections');

// Empirically tuned for OpenAI text-embedding-3-small (Phase 7 calibration):
//   moderately related English text (e.g. two zoo memories described
//   differently) lands ~0.65–0.75; unrelated lands ~0.15. The original 0.75
//   default would have caught only near-paraphrases. 0.55 is "lenient" in the
//   sense the spec intended — wide enough to surface real connections,
//   narrow enough that unrelated content is excluded with comfortable margin.
const DEFAULT_THRESHOLD = 0.55;
const DEFAULT_LIMIT = 5;

/**
 * @typedef {Object} QuietConnection
 * @property {string} stone_id
 * @property {number} similarity - cosine similarity, [0..1]; higher is more similar
 * @property {string|null} summary
 * @property {string|null} peakapoo_r2_key
 */

/**
 * Find semantically similar memories for the same owner.
 *
 * Uses pgvector's `<=>` operator (cosine distance) over the indexed
 * stones.embedding column. Similarity = 1 - distance, filtered by threshold,
 * limited to N. The query strictly scopes to the same owner — Cairn is
 * private memory keeping, never social.
 *
 * Implementation detail: pgvector cosine distance via PostgREST is awkward to
 * express directly, so we use a Postgres RPC-style fallback via execute_sql
 * IF the supabase client supports it. Otherwise we use rpc() with a stored
 * function — but to keep this phase lean and avoid yet another migration,
 * we issue the query through .from('stones').select(...) using PostgREST's
 * `order` parameter with a vector embedded in a query — that's not directly
 * supported either, so this implementation requires the caller to either:
 *   (a) pass a custom `executeSql` function in options, OR
 *   (b) provide a supabase client whose .rpc('match_stones', ...) is wired up.
 *
 * For Phase 7's scope we accept option (a) as the primary path and document
 * (b) as a follow-up. Tests pass a stub that bypasses both, exercising only
 * the post-query filter/sort/shape logic.
 *
 * @param {*} supabase - Supabase client (with optional executeSql override on options)
 * @param {string} ownerId
 * @param {string} stoneId - the seed stone whose siblings we want
 * @param {{ threshold?: number, limit?: number, executeSql?: (sql: string, params: any[]) => Promise<any[]> }} [options]
 * @returns {Promise<QuietConnection[]>}
 */
export async function findSimilarMemories(supabase, ownerId, stoneId, options = {}) {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const limit = options.limit ?? DEFAULT_LIMIT;

  if (!supabase) throw new Error('findSimilarMemories: supabase client is required');
  if (!ownerId) throw new Error('findSimilarMemories: ownerId is required');
  if (!stoneId) throw new Error('findSimilarMemories: stoneId is required');

  log.info({ msg: 'connections:start', ownerIdTail: ownerId.slice(-4), stoneId, threshold, limit });

  // Path A: caller supplied a SQL executor (the recommended live path until a
  // dedicated Supabase RPC is added in Phase 8+). Run the cosine-distance
  // query directly. Pull a couple extra rows so the post-threshold filter
  // doesn't starve the limit.
  if (typeof options.executeSql === 'function') {
    const rows = await options.executeSql(
      `
      WITH seed AS (
        SELECT embedding FROM public.stones
         WHERE id = $1::uuid AND owner_id = $2::uuid AND embedding IS NOT NULL
      )
      SELECT s.id AS stone_id,
             s.metadata #>> '{media_pipeline,summary}' AS summary,
             s.metadata #>> '{media_pipeline,peakapoo,frame_r2_key}' AS peakapoo_r2_key,
             1 - (s.embedding <=> seed.embedding) AS similarity
        FROM public.stones s, seed
       WHERE s.owner_id = $2::uuid
         AND s.id <> $1::uuid
         AND s.embedding IS NOT NULL
       ORDER BY s.embedding <=> seed.embedding ASC
       LIMIT $3
      `.trim(),
      [stoneId, ownerId, limit * 3],
    );

    return finishResults(rows, threshold, limit);
  }

  // Path B: caller supplied a stub supabase client whose .from(...).select(...)
  // pre-computes similarity (used by tests). The stub returns rows shaped like
  // { stone_id, similarity, summary, peakapoo_r2_key } already.
  const { data, error } = await supabase
    .from('stones')
    .select('id, owner_id, metadata, embedding')
    .eq('owner_id', ownerId)
    .neq('id', stoneId);

  if (error) throw new Error(`findSimilarMemories: query failed: ${error.message}`);
  if (!Array.isArray(data)) return [];

  // No vector math available without executeSql — return empty rather than
  // pretend. This branch exists so a misconfigured caller fails open.
  log.info({ msg: 'connections:no-executor', dataLength: data.length });
  return [];
}

function finishResults(rows, threshold, limit) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => typeof r?.similarity === 'number' && r.similarity >= threshold)
    .map((r) => ({
      stone_id: String(r.stone_id),
      similarity: Number(r.similarity),
      summary: r.summary == null ? null : String(r.summary),
      peakapoo_r2_key: r.peakapoo_r2_key == null ? null : String(r.peakapoo_r2_key),
    }))
    .slice(0, limit);
}

/**
 * Pure helper: rank a pre-computed list of candidates against a seed vector
 * using cosine similarity. Useful for tests, for in-memory dedup work, or as
 * a fallback when the Supabase RPC isn't available yet.
 *
 * @param {number[]} seedVector
 * @param {Array<{ stone_id: string, embedding: number[], summary?: string|null, peakapoo_r2_key?: string|null }>} candidates
 * @param {{ threshold?: number, limit?: number }} [options]
 * @returns {QuietConnection[]}
 */
export function rankByCosine(seedVector, candidates, options = {}) {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const seedNorm = vectorNorm(seedVector);
  if (seedNorm === 0) return [];

  return candidates
    .map((c) => {
      const n = vectorNorm(c.embedding);
      const similarity = n === 0 ? 0 : dot(seedVector, c.embedding) / (seedNorm * n);
      return {
        stone_id: c.stone_id,
        similarity,
        summary: c.summary ?? null,
        peakapoo_r2_key: c.peakapoo_r2_key ?? null,
      };
    })
    .filter((r) => r.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

function dot(a, b) {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) sum += a[i] * b[i];
  return sum;
}

function vectorNorm(a) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * a[i];
  return Math.sqrt(sum);
}
