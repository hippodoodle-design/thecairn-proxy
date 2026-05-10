/**
 * Enqueue a single media-ingest job onto the production cairn-media queue.
 *
 * Used for the first end-to-end production media pipeline run before the
 * frontend is wired up to POST /api/media. Bypasses the auth wrapper but
 * uses the same job shape (`{ url, ownerId }`) and queue (`cairn-media`,
 * job name `media-ingest`) that web/src/routes/media.js produces, so the
 * worker pipeline downstream is identical to the production path.
 *
 * Run with Railway env injected so REDIS_URL points at production Redis:
 *   railway service @cairn/web
 *   railway run -- node scripts/enqueue-media.js <url> <owner_id>
 */

import { buildMediaQueue, MEDIA_QUEUE } from '@cairn/shared/queue';
import { validateUrl } from '@cairn/shared/validateUrl';

const url = process.argv[2];
const ownerId = process.argv[3];

if (!url || !ownerId) {
  console.error('Usage: node scripts/enqueue-media.js <url> <owner_id>');
  process.exit(1);
}

if (!process.env.REDIS_URL) {
  console.error('REDIS_URL is not set. Run via `railway run -- node scripts/enqueue-media.js ...`');
  process.exit(1);
}

const check = await validateUrl(url);
if (!check.ok) {
  console.error(`URL rejected by validateUrl: ${check.error}`);
  process.exit(1);
}

const normalizedUrl = check.url.toString();
const queue = buildMediaQueue();

const job = await queue.add('media-ingest', {
  url: normalizedUrl,
  ownerId,
});

console.log(JSON.stringify({
  ok: true,
  queue: MEDIA_QUEUE,
  jobId: job.id,
  url: normalizedUrl,
  ownerId,
  enqueuedAt: new Date().toISOString(),
}, null, 2));

await queue.close();
process.exit(0);
