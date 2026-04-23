import { Queue, QueueEvents, Worker } from 'bullmq';
import IORedis from 'ioredis';

export const DIGEST_QUEUE = 'cairn-digest';

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
