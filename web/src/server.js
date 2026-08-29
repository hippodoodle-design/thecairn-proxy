import express from 'express';
import { corsMiddleware } from './middleware/cors.js';
import { createLogger } from '@cairn/shared/logger';
import digestRouter from './routes/digest.js';
import mediaRouter from './routes/media.js';
import ingestVideoRouter from './routes/ingest-video.js';
import mediaHarvestRouter from './routes/media-harvest.js';
import mediaReunderstandRouter from './routes/media-reunderstand.js';
import moderationRouter from './routes/moderation.js';
import r2SignRouter from './routes/r2-sign.js';
import companionsRouter, { speciesRequestsRouter } from './routes/companions.js';
import robertaVoiceRouter from './routes/roberta-voice.js';
import robertaBrainRouter from './routes/roberta-brain.js';
import bertieRouter from './routes/bertie.js';
import healthRouter from './routes/health.js';

const log = createLogger('thecairn-web');
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // Railway / Vercel style proxies; req.ip then reflects XFF.

app.use(corsMiddleware);
// Uploaded 1D pets (a child's drawing) can be up to 5 MB, which is ~6.7 MB as
// base64. Mount a larger JSON parser for that one path BEFORE the global 32kb
// parser — express.json is idempotent (skips a request whose body it already
// parsed), so the global parser below leaves this path's body untouched.
app.use('/api/companions/upload-1d', express.json({ limit: '8mb' }));
app.use(express.json({ limit: '32kb' }));

// Per-request access log. Cheap, structured.
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durMs = Number(process.hrtime.bigint() - start) / 1e6;
    log.info({
      msg: 'request',
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durMs: Math.round(durMs),
      ua: req.headers['user-agent'] || null,
    });
  });
  next();
});

app.use('/health', healthRouter);
app.use('/healthz', healthRouter);
app.use('/api/digest', digestRouter);
app.use('/api/media', mediaRouter);
app.use('/api/media', ingestVideoRouter);
app.use('/api/media', mediaHarvestRouter);
app.use('/api/media', mediaReunderstandRouter);
app.use('/api/moderation', moderationRouter);
app.use('/api/r2', r2SignRouter);
app.use('/api/companions', companionsRouter);
app.use('/api/species-requests', speciesRequestsRouter);
app.use('/api/roberta-voice', robertaVoiceRouter);
app.use('/api/roberta-brain', robertaBrainRouter);
app.use('/api/bertie', bertieRouter);

// 404 for anything unmatched.
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

// Error handler (CORS rejections land here with err.message === 'Origin not allowed').
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err && err.message === 'Origin not allowed') {
    return res.status(403).json({ ok: false, error: 'Origin not allowed' });
  }
  log.error({ msg: 'unhandled error', err, path: req.path });
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

const PORT = Number(process.env.PORT || 3001);
const server = app.listen(PORT, () => {
  log.info({ event: 'server_ready', port: PORT, env: process.env.NODE_ENV || 'development' });
});

// Graceful shutdown — let in-flight requests finish before dropping the process.
function shutdown(signal) {
  log.info({ msg: 'shutdown begin', signal });
  server.close((err) => {
    if (err) {
      log.error({ msg: 'shutdown server.close error', err });
      process.exit(1);
    }
    log.info({ msg: 'shutdown complete' });
    process.exit(0);
  });
  setTimeout(() => {
    log.warn({ msg: 'shutdown forced after 10s' });
    process.exit(1);
  }, 10_000).unref?.();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  log.error({ msg: 'unhandledRejection', err: reason instanceof Error ? reason : new Error(String(reason)) });
});
process.on('uncaughtException', (err) => {
  log.error({ msg: 'uncaughtException', err });
  process.exit(1);
});
