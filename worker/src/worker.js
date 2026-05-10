import {
  buildWorker,
  buildMediaWorker,
  buildHarvestWorker,
  buildReunderstandWorker,
  buildModerationWorker,
  buildIncidentWorker,
  DIGEST_QUEUE,
  MEDIA_QUEUE,
  HARVEST_QUEUE,
  REUNDERSTAND_QUEUE,
  MODERATION_QUEUE,
  INCIDENT_QUEUE,
  getRedisConnection,
} from '@cairn/shared/queue';
import { createLogger } from '@cairn/shared/logger';
import { setStoneStatus } from '@cairn/shared/media-pipeline';
import { getServiceClient } from '@cairn/shared/supabase';
import { urlDigest } from './jobs/urlDigest.js';
import { mediaIngest } from './jobs/mediaIngest.js';
import { mediaHarvest } from './jobs/mediaHarvest.js';
import { mediaReunderstand } from './jobs/mediaReunderstand.js';
import { mediaSuspendUser } from './jobs/mediaSuspendUser.js';
import { mediaReportIncident } from './jobs/mediaReportIncident.js';

const log = createLogger('thecairn-worker');

const concurrency = Number(process.env.WORKER_CONCURRENCY || 10);

/**
 * Phase 9c — Delta 2: on TERMINAL job failure (BullMQ has exhausted
 * retries), write media_pipeline.status='failed' on the stones row.
 * Transient mid-retry failures are NOT terminal — leave the row at
 * 'harvesting' so the next attempt overwrites cleanly.
 *
 * Used by the harvest + reunderstand workers only. mediaIngest's failed
 * handler stays log-only because the stones row may not exist on
 * transient failure (mediaIngest creates the row only at the end).
 *
 * The status write is best-effort wrapped in try/catch — a DB-side
 * failure here is logged loudly with both the original job failure and
 * the secondary status-write failure so an operator can reconstruct
 * what happened.
 */
async function markFailedIfTerminal({ job, queue, err, jobLog }) {
  const attemptsMade = job?.attemptsMade ?? 0;
  const maxAttempts = job?.opts?.attempts ?? 1;
  const isTerminal = attemptsMade >= maxAttempts;
  const stoneId = job?.data?.stone_id;

  if (!isTerminal) {
    jobLog.warn({
      msg: 'job_failed_will_retry',
      queue,
      jobId: job?.id,
      attemptsMade,
      maxAttempts,
    });
    return;
  }
  if (!stoneId) {
    jobLog.error({
      msg: 'job_failed_terminal_no_stone_id',
      queue,
      jobId: job?.id,
      attemptsMade,
      maxAttempts,
    });
    return;
  }

  try {
    const supabase = getServiceClient();
    await setStoneStatus(supabase, stoneId, 'failed');
    jobLog.error({
      msg: 'job_failed_terminal_marked',
      queue,
      jobId: job?.id,
      stoneId,
      attemptsMade,
      maxAttempts,
      originalErr: err,
    });
  } catch (statusErr) {
    jobLog.error({
      msg: 'job_failed_terminal_mark_failed',
      queue,
      jobId: job?.id,
      stoneId,
      attemptsMade,
      maxAttempts,
      originalErr: err,
      statusWriteErr: statusErr,
    });
  }
}

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

const mediaWorker = buildMediaWorker(async (job) => {
  const attempt = job.attemptsMade + 1;
  const jobLog = log.child({ jobId: job.id, jobName: job.name, attempt, queue: MEDIA_QUEUE });
  jobLog.info({ event: 'job_started', jobId: job.id, jobName: job.name, attempt });

  const start = Date.now();
  try {
    let result;
    switch (job.name) {
      case 'media-ingest':
        result = await mediaIngest(job, log);
        break;
      default:
        throw new Error(`Unknown media job: ${job.name}`);
    }
    jobLog.info({ msg: 'job returned', durationMs: Date.now() - start });
    return result;
  } catch (err) {
    jobLog.error({ event: 'job_failed', durationMs: Date.now() - start, err });
    throw err;
  }
});

mediaWorker.on('ready', () => {
  log.info({ event: 'worker_ready', queue: MEDIA_QUEUE });
});

// mediaIngest stays log-only on failure: the stones row doesn't exist
// until the very end of the job, so there's nothing to mark 'failed'
// for transient or terminal failures alike.
mediaWorker.on('failed', (job, err) => {
  log.error({
    event: 'job_failed',
    queue: MEDIA_QUEUE,
    jobId: job?.id,
    jobName: job?.name,
    attemptsMade: job?.attemptsMade,
    err,
  });
});

mediaWorker.on('error', (err) => {
  log.error({ msg: 'media worker error', err });
});

const harvestWorker = buildHarvestWorker(async (job) => {
  const attempt = job.attemptsMade + 1;
  const jobLog = log.child({ jobId: job.id, jobName: job.name, attempt, queue: HARVEST_QUEUE });
  jobLog.info({ event: 'job_started', jobId: job.id, jobName: job.name, attempt });

  const start = Date.now();
  try {
    let result;
    switch (job.name) {
      case 'media-harvest':
        result = await mediaHarvest(job, log);
        break;
      default:
        throw new Error(`Unknown harvest job: ${job.name}`);
    }
    jobLog.info({ msg: 'job returned', durationMs: Date.now() - start });
    return result;
  } catch (err) {
    jobLog.error({ event: 'job_failed', durationMs: Date.now() - start, err });
    throw err;
  }
});

harvestWorker.on('ready', () => {
  log.info({ event: 'worker_ready', queue: HARVEST_QUEUE });
});

harvestWorker.on('failed', async (job, err) => {
  const jobLog = log.child({ jobId: job?.id, jobName: job?.name, queue: HARVEST_QUEUE });
  jobLog.error({
    event: 'job_failed',
    queue: HARVEST_QUEUE,
    jobId: job?.id,
    jobName: job?.name,
    attemptsMade: job?.attemptsMade,
    err,
  });
  await markFailedIfTerminal({ job, queue: HARVEST_QUEUE, err, jobLog });
});

harvestWorker.on('error', (err) => {
  log.error({ msg: 'harvest worker error', err });
});

const reunderstandWorker = buildReunderstandWorker(async (job) => {
  const attempt = job.attemptsMade + 1;
  const jobLog = log.child({ jobId: job.id, jobName: job.name, attempt, queue: REUNDERSTAND_QUEUE });
  jobLog.info({ event: 'job_started', jobId: job.id, jobName: job.name, attempt });

  const start = Date.now();
  try {
    let result;
    switch (job.name) {
      case 'media-reunderstand':
        result = await mediaReunderstand(job, log);
        break;
      default:
        throw new Error(`Unknown reunderstand job: ${job.name}`);
    }
    jobLog.info({ msg: 'job returned', durationMs: Date.now() - start });
    return result;
  } catch (err) {
    jobLog.error({ event: 'job_failed', durationMs: Date.now() - start, err });
    throw err;
  }
});

reunderstandWorker.on('ready', () => {
  log.info({ event: 'worker_ready', queue: REUNDERSTAND_QUEUE });
});

reunderstandWorker.on('failed', async (job, err) => {
  const jobLog = log.child({ jobId: job?.id, jobName: job?.name, queue: REUNDERSTAND_QUEUE });
  jobLog.error({
    event: 'job_failed',
    queue: REUNDERSTAND_QUEUE,
    jobId: job?.id,
    jobName: job?.name,
    attemptsMade: job?.attemptsMade,
    err,
  });
  await markFailedIfTerminal({ job, queue: REUNDERSTAND_QUEUE, err, jobLog });
});

reunderstandWorker.on('error', (err) => {
  log.error({ msg: 'reunderstand worker error', err });
});

const moderationWorker = buildModerationWorker(async (job) => {
  const attempt = job.attemptsMade + 1;
  const jobLog = log.child({ jobId: job.id, jobName: job.name, attempt, queue: MODERATION_QUEUE });
  jobLog.info({ event: 'job_started', jobId: job.id, jobName: job.name, attempt });

  const start = Date.now();
  try {
    let result;
    switch (job.name) {
      case 'media-suspend-user':
        result = await mediaSuspendUser(job, log);
        break;
      default:
        throw new Error(`Unknown moderation job: ${job.name}`);
    }
    jobLog.info({ msg: 'job returned', durationMs: Date.now() - start });
    return result;
  } catch (err) {
    jobLog.error({ event: 'job_failed', durationMs: Date.now() - start, err });
    throw err;
  }
});

moderationWorker.on('ready', () => {
  log.info({ event: 'worker_ready', queue: MODERATION_QUEUE });
});
moderationWorker.on('failed', (job, err) => {
  log.error({ event: 'job_failed', queue: MODERATION_QUEUE, jobId: job?.id, jobName: job?.name, err });
});
moderationWorker.on('error', (err) => {
  log.error({ msg: 'moderation worker error', err });
});

const incidentWorker = buildIncidentWorker(async (job) => {
  const attempt = job.attemptsMade + 1;
  const jobLog = log.child({ jobId: job.id, jobName: job.name, attempt, queue: INCIDENT_QUEUE });
  jobLog.info({ event: 'job_started', jobId: job.id, jobName: job.name, attempt });

  const start = Date.now();
  try {
    let result;
    switch (job.name) {
      case 'media-report-incident':
        result = await mediaReportIncident(job, log);
        break;
      default:
        throw new Error(`Unknown incident job: ${job.name}`);
    }
    jobLog.info({ msg: 'job returned', durationMs: Date.now() - start });
    return result;
  } catch (err) {
    jobLog.error({ event: 'job_failed', durationMs: Date.now() - start, err });
    throw err;
  }
});

incidentWorker.on('ready', () => {
  log.info({ event: 'worker_ready', queue: INCIDENT_QUEUE });
});
incidentWorker.on('failed', (job, err) => {
  log.error({ event: 'job_failed', queue: INCIDENT_QUEUE, jobId: job?.id, jobName: job?.name, err });
});
incidentWorker.on('error', (err) => {
  log.error({ msg: 'incident worker error', err });
});

async function shutdown(signal) {
  log.info({ msg: 'shutdown begin', signal });
  try {
    // Stop accepting new jobs, wait for in-flight to finish (BullMQ default timeout).
    await Promise.all([
      worker.close(),
      mediaWorker.close(),
      harvestWorker.close(),
      reunderstandWorker.close(),
      moderationWorker.close(),
      incidentWorker.close(),
    ]);
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
