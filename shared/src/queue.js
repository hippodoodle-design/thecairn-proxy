import { Queue, QueueEvents, Worker } from 'bullmq';
import IORedis from 'ioredis';

export const DIGEST_QUEUE = 'cairn-digest';
export const MEDIA_QUEUE = 'cairn-media';
export const HARVEST_QUEUE = 'cairn-harvest';
export const REUNDERSTAND_QUEUE = 'cairn-reunderstand';
export const MODERATION_QUEUE = 'cairn-moderation';
export const INCIDENT_QUEUE = 'cairn-incident-report';

let cachedConn = null;

/**
 * Shared ioredis connection for BullMQ. BullMQ requires maxRetriesPerRequest=null
 * on the connection used by Worker; we use the same options for Queue/QueueEvents
 * so a single connection can be reused across both sides.
 */
export function getRedisConnection() {
  if (cachedConn) return cachedConn;

  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not set');

  cachedConn = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // Railway deployments can experience brief network blips; keep trying.
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });

  return cachedConn;
}

/**
 * Build a BullMQ Queue. Reuses the shared connection.
 */
export function buildQueue(name = DIGEST_QUEUE) {
  return new Queue(name, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 24 * 3600, count: 5000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
}

/**
 * Build a BullMQ Queue scoped to the cairn-media queue. Media jobs have a single
 * attempt by default — long-running ffmpeg/whisper work should not silently retry.
 */
export function buildMediaQueue() {
  return new Queue(MEDIA_QUEUE, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 24 * 3600, count: 5000 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  });
}

/**
 * Build a BullMQ QueueEvents listener. Useful for web-side status polling
 * or push-based notifications in the future.
 */
export function buildQueueEvents(name = DIGEST_QUEUE) {
  return new QueueEvents(name, { connection: getRedisConnection() });
}

/**
 * Build a BullMQ Worker. Concurrency can be tuned per deployment;
 * default 10 parallel jobs per worker process.
 */
export function buildWorker(name, processor, options = {}) {
  return new Worker(name, processor, {
    connection: getRedisConnection(),
    concurrency: options.concurrency ?? 10,
    ...options,
  });
}

/**
 * Build a BullMQ Worker for the cairn-media queue. Lower concurrency and a long
 * lock duration are appropriate for CPU-bound, long-running media jobs (ffmpeg,
 * whisper). Caller may override any option via opts.
 */
export function buildMediaWorker(processor, opts = {}) {
  const {
    concurrency = 2,
    lockDuration = 600_000,
    defaultJobOptions = {
      attempts: 1,
      removeOnComplete: { age: 24 * 3600, count: 5000 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
    ...rest
  } = opts;

  return new Worker(MEDIA_QUEUE, processor, {
    connection: getRedisConnection(),
    concurrency,
    lockDuration,
    defaultJobOptions,
    ...rest,
  });
}

/**
 * Build a BullMQ Queue scoped to the cairn-harvest queue. Two attempts by
 * default — harvest jobs can transiently fail on a network blip during yt-dlp
 * re-acquisition, and the work is short enough that one retry is cheap.
 */
export function buildHarvestQueue() {
  return new Queue(HARVEST_QUEUE, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 24 * 3600, count: 5000 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  });
}

/**
 * Build a BullMQ Worker for the cairn-harvest queue. Same concurrency / lock
 * shape as the media worker — yt-dlp + ffmpeg are CPU-bound and can run long.
 */
export function buildHarvestWorker(processor, opts = {}) {
  const {
    concurrency = 2,
    lockDuration = 600_000,
    defaultJobOptions = {
      attempts: 2,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 24 * 3600, count: 5000 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
    ...rest
  } = opts;

  return new Worker(HARVEST_QUEUE, processor, {
    connection: getRedisConnection(),
    concurrency,
    lockDuration,
    defaultJobOptions,
    ...rest,
  });
}

/**
 * Build a BullMQ Queue scoped to the cairn-reunderstand queue. Two attempts;
 * the work is expensive and we don't want a transient blip to send the user a
 * "couldn't retry" message after they explicitly opted into the cost.
 */
export function buildReunderstandQueue() {
  return new Queue(REUNDERSTAND_QUEUE, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 4000 },
      removeOnComplete: { age: 24 * 3600, count: 5000 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  });
}

/**
 * Build a BullMQ Worker for cairn-reunderstand. Single concurrency and a long
 * lock — re-understand is denser+slower than the original ingest (1-per-3s
 * frames + high-detail vision) and benefits from being serialised on the host.
 */
export function buildReunderstandWorker(processor, opts = {}) {
  const {
    concurrency = 1,
    lockDuration = 900_000,
    defaultJobOptions = {
      attempts: 2,
      backoff: { type: 'exponential', delay: 4000 },
      removeOnComplete: { age: 24 * 3600, count: 5000 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
    ...rest
  } = opts;

  return new Worker(REUNDERSTAND_QUEUE, processor, {
    connection: getRedisConnection(),
    concurrency,
    lockDuration,
    defaultJobOptions,
    ...rest,
  });
}

/**
 * cairn-moderation: user-suspension actions triggered by a CSAM match. Single
 * concurrency, three attempts — these are critical, retry-friendly, and
 * shouldn't pile up.
 */
export function buildModerationQueue() {
  return new Queue(MODERATION_QUEUE, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 30 * 24 * 3600, count: 5000 },
      removeOnFail: { age: 365 * 24 * 3600 }, // long retention for compliance trail
    },
  });
}

export function buildModerationWorker(processor, opts = {}) {
  const {
    concurrency = 1,
    lockDuration = 60_000,
    defaultJobOptions = {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 30 * 24 * 3600, count: 5000 },
      removeOnFail: { age: 365 * 24 * 3600 },
    },
    ...rest
  } = opts;

  return new Worker(MODERATION_QUEUE, processor, {
    connection: getRedisConnection(),
    concurrency,
    lockDuration,
    defaultJobOptions,
    ...rest,
  });
}

/**
 * cairn-incident-report: scaffolded reporting submissions to IWF / NCMEC.
 * Stub mode logs only; live mode kicks in when IWF_REPORTING_URL is set.
 */
export function buildIncidentQueue() {
  return new Queue(INCIDENT_QUEUE, {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 365 * 24 * 3600, count: 5000 },
      removeOnFail: { age: 365 * 24 * 3600 },
    },
  });
}

export function buildIncidentWorker(processor, opts = {}) {
  const {
    concurrency = 1,
    lockDuration = 120_000,
    defaultJobOptions = {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 365 * 24 * 3600, count: 5000 },
      removeOnFail: { age: 365 * 24 * 3600 },
    },
    ...rest
  } = opts;

  return new Worker(INCIDENT_QUEUE, processor, {
    connection: getRedisConnection(),
    concurrency,
    lockDuration,
    defaultJobOptions,
    ...rest,
  });
}
