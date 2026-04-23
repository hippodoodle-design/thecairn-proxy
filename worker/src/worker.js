import { buildWorker, DIGEST_QUEUE, getRedisConnection } from '@cairn/shared/queue';
import { createLogger } from '@cairn/shared/logger';
import { urlDigest } from './jobs/urlDigest.js';

const log = createLogger('thecairn-worker');

const concurrency = Number(process.env.WORKER_CONCURRENCY || 10);

const worker = buildWorker(
  DIGEST_QUEUE,
  async (job) => {
    const attempt = job.attemptsMade + 1;
    const jobLog = log.child({ jobId: job.id, jobName: job.name, attempt });
    jobLog.info({ event: 'job_started', jobId: job.id, jobName: job.name, attempt });

    const start = Date.now();
    try {
      let result;
      switch (job.name) {
        case 'url-digest':
          result = await urlDigest(job, log);
          break;
        default:
          throw new Error(`Unknown job name: ${job.name}`);
      }
      jobLog.info({ msg: 'job returned', durationMs: Date.now() - start });
      return result;
    } catch (err) {
      jobLog.error({ event: 'job_failed', durationMs: Date.now() - start, err });
      throw err; // BullMQ handles retry/backoff via defaultJobOptions.
    }
  },
  { concurrency },
);

worker.on('ready', () => {
  log.info({ event: 'worker_ready', queue: DIGEST_QUEUE, concurrency });
});

worker.on('failed', (job, err) => {
  log.error({
    event: 'job_failed',
    jobId: job?.id,
    jobName: job?.name,
    attemptsMade: job?.attemptsMade,
    err,
  });
});

worker.on('error', (err) => {
  log.error({ msg: 'worker error', err });
});

async function shutdown(signal) {
  log.info({ msg: 'shutdown begin', signal });
  try {
    // Stop accepting new jobs, wait for in-flight to finish (BullMQ default timeout).
    await worker.close();
    const conn = getRedisConnection();
    await conn.quit();
    log.info({ msg: 'shutdown complete' });
    process.exit(0);
  } catch (err) {
    log.error({ msg: 'shutdown error', err });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  log.error({
    msg: 'unhandledRejection',
    err: reason instanceof Error ? reason : new Error(String(reason)),
  });
});
process.on('uncaughtException', (err) => {
  log.error({ msg: 'uncaughtException', err });
  process.exit(1);
});
