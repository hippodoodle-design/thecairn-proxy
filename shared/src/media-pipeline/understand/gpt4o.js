import { readFileSync } from 'node:fs';
import OpenAI from 'openai';
import { createLogger } from '../../logger.js';
import { UnderstandingError } from '../errors.js';

const log = createLogger('understand-gpt4o');

const ALLOWED_CATEGORIES = new Set([
  'personal', 'fitness', 'food', 'music', 'art', 'lecture', 'other',
]);

const MAX_HARVEST_CANDIDATES = 15;

const SYSTEM_PROMPT = `You are an assistant for Cairn, a personal memory keeper. Users save short videos as memories — moments they want to revisit later.

Your job: read the frames and (when present) the spoken transcript of a video, then produce structured understanding of it.

Categories — pick exactly ONE for video_category:
- personal:  human moments — gatherings, kids, candid life, travel, reactions
- fitness:   workouts, exercise, sports, athletic form
- food:      cooking, plating, eating, recipes, restaurants
- music:     performances, concerts, instrumental practice, music videos
- art:       painting, drawing, sculpture, craft, creative process
- lecture:   talks, tutorials, explanations, classroom-style content
- other:     anything that doesn't clearly fit the above

Peakapoo (the held-still moment): identify the SINGLE frame most worth keeping as a still photograph. The character of the choice depends on category:
- personal: a smile, a held look, a candid expression, the eyes-meeting moment
- fitness:  peak form, the apex of a movement, the focused face
- food:     the plated dish, the first bite, the proud reveal
- music:    the climactic note, a held vocal, the hands at work
- art:      the completed work, a focused stroke
- lecture:  a clear board/slide moment, a confident gesture
- other:    whatever is most visually evocative

Harvest candidates (only when video_category is 'personal'):
- Populate harvest_candidates with up to 15 ranked frame indices that are DISTINCT keepable moments — different smiles, different laughs, different held looks, different angles, different beats of a memory.
- Do NOT repeat near-duplicates: if two adjacent frames look the same, pick one.
- Rank best-first; the first item should be the strongest second-best behind the peakapoo.
- The peakapoo's own frame_index can appear in this list.
- For ANY non-personal category (fitness/food/music/art/lecture/other), set harvest_candidates to []. The single peakapoo is the right answer for those.

Output JSON with EXACTLY these fields and nothing else:
{
  "visual_notes": string | null,
  "summary": string | null,
  "suggested_tags": string[],
  "video_category": "personal" | "fitness" | "food" | "music" | "art" | "lecture" | "other",
  "peakapoo_frame_index": number | null,
  "peakapoo_reasoning": string | null,
  "harvest_candidates": [ { "frame_index": number, "reasoning": string } ]
}

- visual_notes: 1-3 sentences describing what's visible (people, place, action, mood).
- summary: 1-2 sentences capturing the moment overall.
- suggested_tags: 3-7 lowercase, single-word-ish tags.
- peakapoo_frame_index: integer 0..N-1 where N is the number of frames provided. Null only if no frame is meaningfully better than the others.
- peakapoo_reasoning: 1 sentence on why that frame, in the voice of the category description above.
- harvest_candidates: array as described above; [] for non-personal videos.`;

function defaultsResult() {
  return {
    visual_notes: null,
    summary: null,
    suggested_tags: [],
    video_category: 'other',
    peakapoo_frame_index: null,
    peakapoo_reasoning: null,
    harvest_candidates: [],
  };
}

function coerceHarvestCandidates(raw, frameCount, category) {
  if (category !== 'personal') return [];
  if (!Array.isArray(raw)) return [];

  const seenIndices = new Set();
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const idx = item.frame_index;
    if (!Number.isInteger(idx) || idx < 0 || idx >= frameCount) continue;
    if (seenIndices.has(idx)) continue;
    const reasoning = typeof item.reasoning === 'string' ? item.reasoning : '';
    out.push({ frame_index: idx, reasoning });
    seenIndices.add(idx);
    if (out.length >= MAX_HARVEST_CANDIDATES) break;
  }
  return out;
}

function coerceResult(parsed, frameCount) {
  const tags = Array.isArray(parsed?.suggested_tags)
    ? parsed.suggested_tags.filter((t) => typeof t === 'string').slice(0, 12)
    : [];
  const category = ALLOWED_CATEGORIES.has(parsed?.video_category)
    ? parsed.video_category
    : 'other';
  const idx = Number.isInteger(parsed?.peakapoo_frame_index)
    && parsed.peakapoo_frame_index >= 0
    && parsed.peakapoo_frame_index < frameCount
      ? parsed.peakapoo_frame_index
      : null;
  return {
    visual_notes: typeof parsed?.visual_notes === 'string' ? parsed.visual_notes : null,
    summary: typeof parsed?.summary === 'string' ? parsed.summary : null,
    suggested_tags: tags,
    video_category: category,
    peakapoo_frame_index: idx,
    peakapoo_reasoning: typeof parsed?.peakapoo_reasoning === 'string' ? parsed.peakapoo_reasoning : null,
    harvest_candidates: coerceHarvestCandidates(parsed?.harvest_candidates, frameCount, category),
  };
}

/**
 * Build an UnderstanderBinding backed by GPT-4o vision.
 *
 * Uses image_url blocks with detail:'low' so each image is a fixed ~85 input
 * tokens (≈ $0.005 each). Frames are sent as data URLs (base64-encoded JPG)
 * so we don't need a public URL or signed S3 link.
 *
 * @returns {import('./index.js').UnderstanderBinding}
 */
export function createGpt4oUnderstander() {
  let client = null;
  function getClient() {
    if (client) return client;
    if (!process.env.OPENAI_API_KEY) {
      throw new UnderstandingError('OPENAI_API_KEY not set in environment');
    }
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return client;
  }

  return {
    async understand(input, options = {}) {
      const { frames, transcript, sourceMetadata = {} } = input || {};
      const visionDetail = options.vision_detail === 'high' ? 'high' : 'low';

      if (!frames || frames.length === 0) {
        log.info({ msg: 'understand:no-frames' });
        return defaultsResult();
      }

      const intro = [];
      intro.push(`Source: ${sourceMetadata.duration_seconds ?? '?'} seconds long.`);
      if (sourceMetadata.title) intro.push(`Title: ${sourceMetadata.title}`);
      if (sourceMetadata.uploader) intro.push(`Uploader: ${sourceMetadata.uploader}`);
      intro.push(
        `I will show you ${frames.length} frame${frames.length === 1 ? '' : 's'} from this video, in chronological order.`,
      );
      intro.push('');
      intro.push('Transcript:');
      intro.push(transcript?.full_text ? transcript.full_text : '[no transcript available]');

      const userParts = [{ type: 'text', text: intro.join('\n') }];

      for (const frame of frames) {
        userParts.push({
          type: 'text',
          text: `Frame ${frame.index} at ${frame.timestamp_ms}ms:`,
        });
        const data = readFileSync(frame.file_path);
        userParts.push({
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${data.toString('base64')}`,
            detail: visionDetail,
          },
        });
      }

      log.info({
        msg: 'understand:start',
        frames: frames.length,
        transcriptChars: transcript?.full_text?.length ?? 0,
        visionDetail,
      });

      const openai = getClient();
      let response;
      try {
        response = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userParts },
          ],
          response_format: { type: 'json_object' },
          max_tokens: 1200,
        });
      } catch (err) {
        const status = err?.status ?? err?.response?.status;
        if (status === 401) throw new UnderstandingError('Invalid OPENAI_API_KEY', { cause: err });
        if (status === 429) throw new UnderstandingError('GPT-4o rate limit', { cause: err });
        const msg = err?.message || String(err);
        throw new UnderstandingError(msg, { cause: err });
      }

      const content = response?.choices?.[0]?.message?.content || '';
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (err) {
        log.warn({
          msg: 'understand:parse-failed',
          err: err.message,
          contentTail: content.slice(-200),
        });
        return defaultsResult();
      }

      const result = coerceResult(parsed, frames.length);

      log.info({
        msg: 'understand:done',
        category: result.video_category,
        peakapooIdx: result.peakapoo_frame_index,
        tagsCount: result.suggested_tags.length,
        harvestCount: result.harvest_candidates.length,
        promptTokens: response.usage?.prompt_tokens,
        completionTokens: response.usage?.completion_tokens,
      });

      return result;
    },
  };
}
