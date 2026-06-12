/**
 * llm.js — Roberta's "brain": a CHEAP-but-warm chat completion.
 *
 * Cost doctrine (board-program item 7): Roberta's replies are gentle, warm and
 * in-character — they do NOT need a frontier model. We use a low-cost model and
 * a tight token budget. The model is configurable via CAIRN_BRAIN_MODEL so it
 * can be swapped (e.g. to claude-haiku-4-5 once an Anthropic key is seeded)
 * without a code change.
 *
 * We reuse the proxy's existing OpenAI credential (openai-api-key-thecairn /
 * OPENAI_API_KEY, already wired via Buddy) so this endpoint adds NO new LLM
 * credential — it ships working on what's already present. Default model
 * gpt-4o-mini: cheap (~$0.15/1M input, $0.60/1M output) and warm enough for a
 * gentle persona behind a strong system prompt.
 */

import OpenAI from 'openai';
import { createLogger } from '../logger.js';
import { getOpenAIApiKey } from '../buddy.js';

const log = createLogger('cairn-brain-llm');

export const DEFAULT_MODEL = process.env.CAIRN_BRAIN_MODEL || 'gpt-4o-mini';

// Keep replies short + warm. Roberta is brief by character, and short replies
// are cheaper on both the LLM and (downstream) the ElevenLabs character budget.
const MAX_OUTPUT_TOKENS = 160;
const TEMPERATURE = 0.7;

// Rough $/token for the default model, for the preview-phase cost estimate.
// Only used to populate `metered.turnCost`; not billing-grade.
const PRICING = {
  'gpt-4o-mini': { inPerM: 0.15, outPerM: 0.60 },
  'gpt-4o': { inPerM: 2.5, outPerM: 10 },
};

/** Estimate a turn's LLM cost in USD from token usage. */
export function estimateLlmCostUsd(model, promptTokens = 0, completionTokens = 0) {
  const p = PRICING[model] || PRICING['gpt-4o-mini'];
  return (promptTokens * p.inPerM + completionTokens * p.outPerM) / 1_000_000;
}

let client = null;
async function getClient() {
  if (client) return client;
  const apiKey = await getOpenAIApiKey();
  client = new OpenAI({ apiKey });
  return client;
}

/**
 * Generate Roberta's reply.
 *
 * @param {Object} args
 * @param {string} args.systemPrompt
 * @param {Array<{role:'user'|'assistant', content:string}>} args.history  last ≤8 turns
 * @param {string} args.userText
 * @returns {Promise<{ reply: string, model: string, promptTokens: number, completionTokens: number, costUsd: number }>}
 */
export async function generateReply({ systemPrompt, history = [], userText }) {
  const model = DEFAULT_MODEL;
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-8)
      .map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userText },
  ];

  const openai = await getClient();
  let response;
  try {
    response = await openai.chat.completions.create({
      model,
      messages,
      temperature: TEMPERATURE,
      max_tokens: MAX_OUTPUT_TOKENS,
    });
  } catch (err) {
    const status = err?.status ?? err?.response?.status;
    if (status === 401) {
      const e = new Error('Invalid OpenAI API key for Roberta brain');
      e.code = 'llm_auth';
      throw e;
    }
    if (status === 429) {
      const e = new Error('Roberta brain rate-limited upstream');
      e.code = 'llm_rate_limit';
      throw e;
    }
    const e = new Error(err?.message || String(err));
    e.code = 'llm_error';
    throw e;
  }

  const reply = (response?.choices?.[0]?.message?.content || '').trim();
  const promptTokens = response?.usage?.prompt_tokens ?? 0;
  const completionTokens = response?.usage?.completion_tokens ?? 0;
  const costUsd = estimateLlmCostUsd(model, promptTokens, completionTokens);

  log.info({ msg: 'brain:reply', model, promptTokens, completionTokens, chars: reply.length });

  return { reply, model, promptTokens, completionTokens, costUsd };
}
