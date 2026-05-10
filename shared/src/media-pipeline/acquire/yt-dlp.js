import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import youtubeDl from 'youtube-dl-exec';
import { createLogger } from '../../logger.js';
import {
  AccessDeniedError,
  MediaPipelineError,
  SourceUnavailableError,
  TooLongError,
} from '../errors.js';
import { DEFAULT_MAX_DURATION_SECONDS, mapExtractorToPlatform } from './index.js';

const log = createLogger('acquire-yt-dlp');

/**
 * Best-effort message extraction from a youtube-dl-exec rejection. The library
 * surfaces yt-dlp's stderr on the err.stderr property and the exit message on
 * err.message — combine both since classifications appear in either.
 */
function errorText(err) {
  const parts = [];
  if (err?.stderr) parts.push(String(err.stderr));
  if (err?.message) parts.push(String(err.message));
  if (parts.length === 0 && err) parts.push(String(err));
  return parts.join('\n');
}

function classifyError(err, sourceUrl) {
  const text = errorText(err);
  const lower = text.toLowerCase();

  if (
    lower.includes('private video') ||
    lower.includes('video unavailable') ||
    lower.includes('has been removed') ||
    lower.includes('video has been deleted') ||
    lower.includes('this video is not available') ||
    lower.includes('video does not exist') ||
    lower.includes('http error 404') ||
    lower.includes('incomplete youtube id') ||
    lower.includes('unable to extract')
  ) {
    return new SourceUnavailableError(sourceUrl, { cause: err });
  }

  if (
    lower.includes('sign in to confirm') ||
    lower.includes('login required') ||
    lower.includes('authentication required') ||
    lower.includes('not available in your country') ||
    lower.includes('geo restricted') ||
    lower.includes('age-restricted') ||
    lower.includes('members-only')
  ) {
    return new AccessDeniedError(sourceUrl, text.slice(0, 200), { cause: err });
  }

  return new MediaPipelineError(`yt-dlp failed: ${text.slice(0, 200)}`, { cause: err });
}

/**
 * Build an AcquirerBinding backed by yt-dlp (via youtube-dl-exec).
 *
 * Two-step flow per call:
 *   A. metadata-only probe (skipDownload + dumpSingleJson) — gets duration cheaply
 *   B. duration check — throws TooLongError BEFORE any bytes are downloaded
 *   C. download to options.workdir using id-based output template
 *
 * @returns {import('./index.js').AcquirerBinding}
 */
export function createYtDlpAcquirer() {
  return {
    async acquire(url, options = {}) {
      const workdir = options.workdir;
      const maxDurationSeconds = options.maxDurationSeconds ?? DEFAULT_MAX_DURATION_SECONDS;

      if (!workdir) throw new MediaPipelineError('acquire: workdir is required');

      await mkdir(workdir, { recursive: true });
      log.info({ msg: 'acquire:start', url });

      // Step A — metadata only
      let info;
      try {
        info = await youtubeDl(url, {
          dumpSingleJson: true,
          skipDownload: true,
          noPlaylist: true,
          noWarnings: true,
        });
      } catch (err) {
        const classified = classifyError(err, url);
        log.error({ msg: 'acquire:metadata-failed', url, errName: classified.name, errMsg: classified.message });
        throw classified;
      }

      const duration = Number(info?.duration ?? 0);
      const extractor = String(info?.extractor || info?.extractor_key || 'unknown');
      const title = info?.title ?? null;
      const uploader = info?.uploader ?? info?.channel ?? info?.uploader_id ?? null;
      const upload_date = info?.upload_date ?? null;
      const id = info?.id;

      if (!id) {
        throw new MediaPipelineError(
          `acquire: yt-dlp metadata did not include an id for ${url}`,
        );
      }

      // Step B — duration check (fail before download)
      if (duration > maxDurationSeconds) {
        log.info({ msg: 'acquire:too-long', url, durationSeconds: duration, capSeconds: maxDurationSeconds });
        throw new TooLongError(url, duration, maxDurationSeconds);
      }

      // Step C — download to workdir
      const outputTemplate = join(workdir, '%(id)s.%(ext)s');
      try {
        await youtubeDl(url, {
          output: outputTemplate,
          noPlaylist: true,
          noWarnings: true,
          // Prefer single-file formats so we don't require ffmpeg to mux.
          format: 'best',
        });
      } catch (err) {
        const classified = classifyError(err, url);
        log.error({ msg: 'acquire:download-failed', url, errName: classified.name, errMsg: classified.message });
        throw classified;
      }

      const files = await readdir(workdir);
      const match = files.find((f) => f.startsWith(`${id}.`));
      if (!match) {
        throw new MediaPipelineError(
          `acquire: yt-dlp succeeded but no output file found for id=${id} in ${workdir}`,
        );
      }
      const file_path = join(workdir, match);
      const stats = await stat(file_path);

      log.info({
        msg: 'acquire:done',
        url,
        platform: mapExtractorToPlatform(extractor),
        durationSeconds: duration,
        sizeBytes: stats.size,
      });

      return {
        file_path,
        size_bytes: stats.size,
        metadata: {
          platform: mapExtractorToPlatform(extractor),
          title,
          uploader,
          duration_seconds: duration,
          upload_date,
          extractor,
        },
      };
    },
  };
}
