/**
 * Transcription binding interface.
 *
 * @typedef {Object} TranscriberBinding
 * @property {(audioPath: string, options?: { language?: string }) => Promise<import('../schema.js').Transcript|null>} transcribe
 *
 * The binding takes a path to an audio file rather than a buffer — streaming
 * keeps memory flat for long-form audio. Phase 1's stub kept its own arity for
 * test scaffolding; Phase 3 ships the real Whisper binding alongside it.
 */

/**
 * Stub transcriber — returns null. Useful for tests that want to bypass the
 * Whisper API and assert on the rest of the pipeline.
 *
 * @returns {TranscriberBinding}
 */
export function createStubTranscriber() {
  return {
    async transcribe(_audioPath, _options) {
      return null;
    },
  };
}

export { createWhisperTranscriber } from './whisper-openai.js';
