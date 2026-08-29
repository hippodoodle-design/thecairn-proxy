/**
 * Smoke test for Roberta's brain seam — runs a few REAL turns against the live
 * cheap-but-warm model and prints her replies, per-turn token usage, and the
 * USD cost so we can report ACTUAL test spend.
 *
 * Run from repo root:  node --env-file=.env scripts/test-roberta-brain.mjs
 *
 * Cost: a handful of short turns on gpt-4o-mini ≈ a fraction of a US cent total.
 */
import { converse, BRAIN_MODEL, BRAIN_PROVIDER } from '../shared/src/robertaBrain.js';

const TURNS = [
  { userText: "I came here because I miss my mum. I don't really know what to say.", personName: null },
  { userText: 'She used to make this terrible tea but I would give anything for a cup of it now.', personName: null },
  { userText: 'Do you think she knew how much I loved her?', personName: null },
];

async function main() {
  console.log(`\n=== Roberta brain smoke test ===`);
  console.log(`provider=${BRAIN_PROVIDER}  model=${BRAIN_MODEL}\n`);

  const history = [];
  let totalUsd = 0;
  let totalPrompt = 0;
  let totalCompletion = 0;

  for (const [i, turn] of TURNS.entries()) {
    process.stdout.write(`USER  ▸ ${turn.userText}\n`);
    const { reply, usage, cost } = await converse({ ...turn, history });
    console.log(`ROBERTA ▸ ${reply}`);
    console.log(
      `        [tokens in=${usage.promptTokens} out=${usage.completionTokens}  cost=$${cost.usd.toFixed(6)}${
        cost.priceKnown ? '' : ' (price est.)'
      }]\n`,
    );
    history.push({ role: 'user', content: turn.userText });
    history.push({ role: 'assistant', content: reply });
    totalUsd += cost.usd;
    totalPrompt += usage.promptTokens;
    totalCompletion += usage.completionTokens;
  }

  const avg = totalUsd / TURNS.length;
  console.log('=== totals ===');
  console.log(`turns:            ${TURNS.length}`);
  console.log(`prompt tokens:    ${totalPrompt}`);
  console.log(`completion tokens:${totalCompletion}`);
  console.log(`LLM test spend:   $${totalUsd.toFixed(6)}`);
  console.log(`avg per turn:     $${avg.toFixed(6)}  (LLM only; voice-in is free, voice-out billed separately by ElevenLabs)`);
}

main().catch((err) => {
  console.error('test failed:', err?.message || err);
  process.exit(1);
});
