import { createReadStream, statSync, existsSync } from 'node:fs';
import OpenAI from 'openai';
import { createLogger } from '../../logger.js';
import { TranscriptionError } from '../errors.js';

const log = createLogger('transcribe-whisper');

const WHISPER_UPLOAD_CAP_BYTES = 25 * 1024 * 1024;

/**
 * Build a TranscriberBinding backed by OpenAI's Whisper API.
 *
 * The OpenAI client is constructed lazily on first call so module import does
 * not require OPENAI_API_KEY to be set (matters for tests that swap in stubs).
 *
 * @returns {import('./index.js').TranscriberBinding}
 */
export function createWhisperTranscriber() {
  let client = null;
  function getClient() {
    if (client) return client;
    if (!process.env.OPENAI_API_KEY) {
      throw new TranscriptionError('OPENAI_API_KEY not set in environment');
    }
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return client;
  }

  return {
    async transcribe(audioPath, _options) {
      if (!existsSync(audioPath)) {
        throw new TranscriptionError(`Audio file not found: ${audioPath}`);
      }
      const sizeBytes = statSync(audioPath).size;
      if (sizeBytes > WHISPER_UPLOAD_CAP_BYTES) {
        throw new TranscriptionError(
          `Audio exceeds Whisper 25 MB limit: ${sizeBytes} bytes`,
        );
      }

      log.info({ msg: 'transcribe:start', audioPath, sizeBytes });

      const openai = getClient();
      let response;
      try {
        response = await openai.audio.transcriptions.create({
          file: createReadStream(audioPath),
          model: 'whisper-1',
          response_format: 'verbose_json',
        });
      } catch (err) {
        const status = err?.status ?? err?.response?.status;
        if (status === 401) {
          throw new TranscriptionError('Invalid OPENAI_API_KEY', { cause: err });
        }
        if (status === 429) {
          throw new TranscriptionError('Whisper API rate limit', { cause: err });
        }
        const msg = err?.message || String(err);
        throw new TranscriptionError(msg, { cause: err });
      }

      const segments = Array.isArray(response.segments) ? response.segments : [];
      const transcript = {
        language: response.language ?? 'unknown',
        segments: segments.map((s) => ({
          start_ms: Math.round((s.start ?? 0) * 1000),
          end_ms: Math.round((s.end ?? 0) * 1000),
          text: String(s.text ?? '').trim(),
        })),
        full_text: String(response.text ?? '').trim(),
      };

      log.info({
        msg: 'transcribe:done',
        language: transcript.language,
        segmentCount: transcript.segments.length,
        fullTextChars: transcript.full_text.length,
      });

      return transcript;
    },
  };
}
