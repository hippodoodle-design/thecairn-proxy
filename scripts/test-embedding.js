/**
 * Standalone Phase 7 embedding test.
 *
 * Usage:
 *   node --env-file=.env scripts/test-embedding.js
 *
 * Builds a sample UnderstandingRecord-shaped object, composes its embedding
 * source text, calls OpenAI's text-embedding-3-small, and verifies the output
 * shape (1536 floats). Prints a few summary stats and the approximate cost.
 */

import {
  composeEmbeddingText,
  createOpenAIEmbedder,
} from '../shared/src/media-pipeline/embedding/index.js';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

const PRICE_PER_M_TOKENS = 0.020; // text-embedding-3-small (Jan 2026)

const sampleRecord = {
  summary: 'A young man shares a brief observation about elephants at a zoo, highlighting their long trunks.',
  visual_notes: 'A young person in a red and black jacket is speaking in front of a zoo enclosure with elephants visible in the background. His demeanor is casual and conversational.',
  suggested_tags: ['zoo', 'elephants', 'casual', 'vlog', 'wildlife'],
};

let exitCode = 0;
try {
  const text = composeEmbeddingText(sampleRecord);
  if (!text) {
    console.error(`${RED}✗${RESET} composeEmbeddingText returned null on a populated record`);
    process.exit(1);
  }
  console.log(`${BOLD}embedding source text${RESET} (${text.length} chars):`);
  console.log(`${DIM}  ${text.replace(/\n/g, '\n  ')}${RESET}`);
  console.log('');

  const embedder = createOpenAIEmbedder();
  const start = Date.now();
  const result = await embedder.embed(text);
  const ms = Date.now() - start;

  if (!Array.isArray(result.vector) || result.vector.length !== 1536) {
    console.error(`${RED}✗${RESET} expected 1536-d vector, got ${result.vector?.length}`);
    exitCode = 1;
  }
  const allFloats = result.vector.every((v) => typeof v === 'number' && Number.isFinite(v));
  if (!allFloats) {
    console.error(`${RED}✗${RESET} vector contains non-finite values`);
    exitCode = 1;
  }

  const magnitude = Math.sqrt(result.vector.reduce((s, v) => s + v * v, 0));
  const head = result.vector.slice(0, 5).map((v) => v.toFixed(6));

  console.log(`${GREEN}✓${RESET} embedded — model=${result.model}, dimensions=${result.dimensions} (${ms}ms)`);
  console.log(`${DIM}  first 5 dimensions: [${head.join(', ')}]${RESET}`);
  console.log(`${DIM}  magnitude: ${magnitude.toFixed(6)}${RESET}`);

  // Approximate cost. text-embedding-3-small at ~50 tokens for the sample.
  const approxTokens = Math.ceil(text.length / 4);
  const approxCost = (approxTokens / 1_000_000) * PRICE_PER_M_TOKENS;
  console.log(`${DIM}  approx tokens: ${approxTokens}, cost ≈ $${approxCost.toFixed(6)}${RESET}`);
} catch (err) {
  console.error(`\n${RED}✗${RESET} ${err?.name || 'Error'}: ${err?.message || err}`);
  if (err?.cause) {
    console.error(`${DIM}  cause: ${String(err.cause?.message || err.cause).slice(0, 400)}${RESET}`);
  }
  exitCode = 1;
}

process.exit(exitCode);
