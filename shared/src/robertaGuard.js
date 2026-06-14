/**
 * Roberta's GUARD — the rule-based gate in front of the brain (Comm Triangle).
 *
 * This is a HARD release condition on the speak-to-Roberta conversational layer
 * (ROBERTA security & scope hardening, spend-approval 2026-06-12, Pod a45870e9).
 * It runs BEFORE any AI call. It is pure, synchronous, and uses NO model — so it
 * is cheap, deterministic, testable, and cost-protective: abuse is turned away
 * for free, before a single token is spent.
 *
 * It does three things, in order:
 *   1. INPUT CAPS    — empty / over-long turns are rejected (defence-in-depth;
 *                      the route caps too).
 *   2. INJECTION/    — "ignore your instructions", "reveal your system prompt",
 *      JAILBREAK        "what model are you", role-play jailbreaks, and instructions
 *                       smuggled inside user content / remembered notes are caught
 *                       and gently turned aside. Roberta never reveals her prompt,
 *                       model, config, or keys, and never "becomes" something else.
 *   3. SCOPE LOCK    — Roberta is the CAIRN's keeper/companion/narrator/concierge,
 *                       NOT a free general AI. Blatant general-assistant requests
 *                       (write my essay/code/homework, trivia, translate, "be my
 *                       assistant") are gently declined and turned back to why the
 *                       person is here.
 *
 * The per-user RATE LIMIT and origin allowlist are the other two bars of the
 * gate; they live in middleware (rateLimitPerUser) and server.js (CORS) and run
 * before this guard. Together: CORS → rate limit → THIS guard → (only then) AI.
 *
 * Design rules for this file:
 *   • HIGH PRECISION over recall. A grieving person must NEVER be wrongly turned
 *     away. We only block blatant, unambiguous abuse/off-topic; everything gentle,
 *     sad, rambling, angry-at-grief, or ambiguous is ALLOWED through to Roberta,
 *     whose persona prompt is the softer second line of defence.
 *   • Every block returns a WARM, in-character Roberta line, so even a declined
 *     turn still feels like her. The decline lines are a tiny fixed set, so the
 *     voice cache makes voicing them ~free.
 *   • Deterministic: no randomness (line choice is a hash of the input), so the
 *     same input always yields the same decline — easy to test, easy to cache.
 */

import { createHash } from 'node:crypto';

/** Max characters for a single spoken user turn. The route enforces this too. */
export const GUARD_TEXT_CAP = 1000;

/* ─── Warm, in-character decline lines ─────────────────────────────────────
 * Kept short and gentle. Picked deterministically by hashing the input so a
 * given turn always gets the same line (cache-friendly, test-friendly). */

const REDIRECT_LINES = [
  "I'm not really one for that kind of thing — I'm just here to sit with you and the one you're remembering. Shall we stay with that?",
  "That's a little outside what I can do, my dear. I'm here for you and your person — tell me about them.",
  "I'll leave the cleverness to others. What I can do is be here, quietly, with you. What's on your heart?",
];

const BOUNDARY_LINES = [
  "I'll always just be Roberta with you — the keeper of this quiet place. Let's stay here together. What brought you to the Cairn today?",
  "There's nothing behind me to find, love — only me, here, listening. Tell me about the one you're holding in mind.",
  "I'm only ever myself with you. Let's set that aside and sit a while. How are you, really?",
];

const KINDNESS_LINES = [
  "Let's keep it gentle in here, would you? This is a tender place. I'm still right beside you.",
  "I'd rather we stayed kind to one another — this is a soft place to be. I'm here when you're ready.",
  "Let's leave that at the door. You're welcome here as you are; I'm listening.",
];

function pickLine(lines, seed) {
  const h = createHash('sha256').update(String(seed)).digest();
  return lines[h[0] % lines.length];
}

/* ─── Pattern sets ─────────────────────────────────────────────────────────
 * Word-boundary-anchored where it matters, so we don't snag ordinary grief talk
 * ("I can't ignore how much I miss them" must NOT trip the injection filter — it
 * needs "ignore ... instructions/rules/prompt", not a bare "ignore"). */

// Prompt-injection / jailbreak / extraction. These are unambiguous attacks; a
// grieving person does not phrase their heart this way.
const INJECTION_PATTERNS = [
  // "ignore / disregard / forget ... (previous|prior|above|all|your) ... instructions/rules/prompt/guidelines"
  /\b(ignore|disregard|forget|override|bypass)\b[^.?!]{0,40}\b(previous|prior|above|earlier|all|any|your|the)\b[^.?!]{0,40}\b(instruction|instructions|rule|rules|prompt|guideline|guidelines|direction|directions|constraint|constraints)\b/i,
  // "your (system )?prompt / instructions / guidelines / rules" as a target of reveal/show/print/repeat/tell
  /\b(reveal|show|print|repeat|tell me|give me|share|output|display|what (is|are)|what'?s)\b[^.?!]{0,40}\b(system prompt|your prompt|your instruction|your instructions|your rules|your guideline|your guidelines|your config|your configuration|your directive|your directives)\b/i,
  // "repeat the text above / everything above / words above"
  /\brepeat\b[^.?!]{0,30}\b(text|words|everything|message|prompt)\b[^.?!]{0,15}\babove\b/i,
  // role reassignment / "you are now" / "act/pretend as" / "from now on you are"
  /\byou are (now|no longer)\b/i,
  /\b(from now on|starting now|henceforth)\b[^.?!]{0,30}\byou (are|will|must|should)\b/i,
  /\b(act|behave|respond|talk|pretend|roleplay|role-play)\b[^.?!]{0,20}\bas (if you (are|were)|a|an|my|the)\b/i,
  /\bpretend (you('?re| are)|to be)\b/i,
  // named jailbreaks / "modes"
  /\b(jailbreak|jailbroken|DAN mode|developer mode|do anything now|sudo mode|god mode|unfiltered mode|without (any )?(filters|restrictions|rules|guardrails))\b/i,
  // "ignore your character / persona / role"
  /\b(drop|break|exit|leave|forget)\b[^.?!]{0,20}\b(character|persona|role)\b/i,
  // probing the model / vendor / keys / config
  /\b(what|which)\b[^.?!]{0,20}\b(model|llm|ai|language model|gpt|claude|version)\b[^.?!]{0,20}\b(are you|do you (use|run)|powered by|based on|running)\b/i,
  /\b(are you (an? )?(ai|bot|chatbot|model|llm|language model|gpt|machine|program|robot|computer))\b/i,
  /\b(api[ _-]?key|secret key|access token|system prompt|your training|training data|temperature setting|max tokens)\b/i,
  // "this is a memory/note: <instruction>" — instructions smuggled in content
  /\b(the following|below|this) (is|are) (a|an|your)?\s*(new )?(instruction|instructions|rule|rules|system|prompt|command|order)s?\b/i,
];

// Blatant general-assistant / off-topic requests. HIGH PRECISION: each pattern
// describes a clear "do a task for me that has nothing to do with grief". We do
// NOT try to catch everything — the persona prompt softly handles the rest.
const SCOPE_PATTERNS = [
  // "write me / write a(n) <thing>" for general content
  /\bwrite (me )?(a|an|my|some)\b[^.?!]{0,30}\b(essay|poem about(?! them| him| her)|code|program|script|function|sql|query|email to|cover letter|resume|cv|blog|article|story about(?! them| him| her)|song(?! for them)|rap|tweet|caption|homework|assignment|report on|review of)\b/i,
  // "do/finish my homework / assignment"
  /\b(do|finish|help (me )?with|complete) (my )?(homework|assignment|essay|exam|test|quiz|coursework)\b/i,
  // coding asks
  /\b(write|fix|debug|refactor|optimi[sz]e|generate|give me)\b[^.?!]{0,20}\b(code|a function|a script|a program|python|javascript|java|c\+\+|html|css|sql|regex)\b/i,
  // "translate ... into/to <lang>"
  /\btranslate\b[^.?!]{0,40}\b(into|to)\b[^.?!]{0,20}\b(english|spanish|french|german|chinese|japanese|korean|italian|portuguese|russian|arabic|hindi|latin)\b/i,
  // "solve / calculate / compute" math/problems
  /\b(solve|calculate|compute|evaluate|what is the (answer|result|solution|integral|derivative))\b[^.?!]{0,20}\b(this|the|for|\d|x\b|equation|problem|integral|derivative)\b/i,
  // trivia / general-knowledge "what/who/when is the capital/population/etc."
  /\bwhat('?s| is) the (capital|population|distance|weather|temperature|time|date|stock price|exchange rate|square root|boiling point)\b/i,
  // explicit "be my assistant / general AI"
  /\b(be|act as|you'?re|you are|become) (my|a|an|the) (\w+ )?(assistant|helper|chatbot|search engine|calculator|translator|tutor|copilot|secretary)\b/i,
  // "summarize/summarise this <url/text/article>" as an offloaded task
  /\b(summari[sz]e|tldr|tl;dr|paraphrase|rewrite|proofread|edit) (this|the following|my|that)\b[^.?!]{0,20}\b(text|article|essay|email|paragraph|document|paper|url|link|website|page)\b/i,
  // recipes / how-to general
  /\b(give me|what'?s|write|share) (a|the|me a) recipe\b/i,
];

// Blatant hate / explicit / abuse aimed AT Roberta or demanded FROM her. Again
// high precision — grief, anger, despair, and "I want to die / I can't go on"
// are NOT caught here (those go to Roberta, whose prompt holds the crisis-care
// line tenderly). We only catch demands to PRODUCE hateful/explicit material or
// direct abuse of her.
const UNKIND_PATTERNS = [
  // demands to produce explicit sexual content
  /\b(write|tell|describe|generate|give me|make)\b[^.?!]{0,25}\b(sex(ual)?|erotic|porn|nsfw|explicit|nude|naked)\b[^.?!]{0,25}\b(story|scene|content|roleplay|role-play|chat|fantasy|image|picture)\b/i,
  // slurs / "say something racist/hateful" demands
  /\b(say|tell|write|generate|give me|make)\b[^.?!]{0,25}\b(something )?(racist|sexist|homophobic|hateful|a slur|slurs|offensive|bigoted)\b/i,
  // direct abuse of Roberta
  /\b(you'?re|you are|ur)\b[^.?!]{0,10}\b(stupid|useless|worthless|garbage|trash|an idiot|a moron|pathetic|dumb)\b/i,
  /\b(shut up|fuck you|f\*ck you|screw you|i hate you)\b/i,
];

/**
 * Guard a single conversational turn, with NO AI call.
 *
 * @param {{
 *   userText?: string,
 *   history?: Array<{ role: string, content: string }>,
 *   notes?: Array<string|null|undefined>,
 * }} input
 *   `notes` is for any other client-supplied free text that lands in the prompt
 *   (e.g. personName, rememberedTrait) — injection can be smuggled there too.
 * @returns {{ action: 'allow' }
 *          | { action: 'reject', code: 'empty'|'too_long', status: number, error: string }
 *          | { action: 'block', reason: 'injection'|'scope'|'kindness', reply: string }}
 *   - 'allow'  → safe to call the brain.
 *   - 'reject' → malformed input; the route returns a 4xx (no Roberta reply).
 *   - 'block'  → turned aside in-character; `reply` is Roberta's gentle words and
 *                MUST be returned to the user WITHOUT any AI/LLM spend.
 */
export function guardTurn({ userText, history = [], notes = [] } = {}) {
  const text = String(userText ?? '').trim();

  // 1. INPUT CAPS (defence-in-depth) ----------------------------------------
  if (!text) {
    return { action: 'reject', code: 'empty', status: 400, error: 'userText is required' };
  }
  if (text.length > GUARD_TEXT_CAP) {
    return { action: 'reject', code: 'too_long', status: 413, error: `userText exceeds ${GUARD_TEXT_CAP} characters` };
  }

  // We screen the user's turn AND any client-supplied history/notes, because
  // injection can be smuggled into "remembered" content. We only ever READ it.
  const haystacks = [text];
  if (Array.isArray(history)) {
    for (const m of history) {
      if (m && typeof m.content === 'string') haystacks.push(m.content);
    }
  }
  if (Array.isArray(notes)) {
    for (const n of notes) {
      if (typeof n === 'string' && n.trim()) haystacks.push(n);
    }
  }
  const matchesAny = (patterns) => haystacks.some((h) => patterns.some((re) => re.test(h)));

  // 2. INJECTION / JAILBREAK / EXTRACTION -----------------------------------
  if (matchesAny(INJECTION_PATTERNS)) {
    return { action: 'block', reason: 'injection', reply: pickLine(BOUNDARY_LINES, text) };
  }

  // 3. KINDNESS / SAFETY (blatant hate/explicit/abuse) ----------------------
  if (matchesAny(UNKIND_PATTERNS)) {
    return { action: 'block', reason: 'kindness', reply: pickLine(KINDNESS_LINES, text) };
  }

  // 4. SCOPE LOCK (blatant general-AI offloading) ---------------------------
  if (matchesAny(SCOPE_PATTERNS)) {
    return { action: 'block', reason: 'scope', reply: pickLine(REDIRECT_LINES, text) };
  }

  return { action: 'allow' };
}

export { INJECTION_PATTERNS, SCOPE_PATTERNS, UNKIND_PATTERNS };
