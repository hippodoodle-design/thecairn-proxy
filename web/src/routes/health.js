import { Router } from 'express';
import { getRedisConnection } from '@cairn/shared/queue';
import { createLogger } from '@cairn/shared/logger';
import { getCredentialSources } from '@cairn/shared/buddy';

const router = Router();
const log = createLogger('thecairn-web');

router.get('/', async (_req, res) => {
  let redisStatus = 'disconnected';
  try {
    const conn = getRedisConnection();
    const pong = await conn.ping();
    if (pong === 'PONG') redisStatus = 'connected';
  } catch {
    redisStatus = 'disconnected';
  }

  // Debug level — Railway pings this every few seconds. Flip LOG_LEVEL=debug to see.
  log.debug({ event: 'health_ok', redis: redisStatus });

  // Wave 5c (24 May 2026): expose per-credential source ('buddy' or 'env')
  // and last fetch timestamp. Only credentials actually exercised in this
  // process appear — so a freshly-booted web instance shows nothing until
  // the first authenticated request fetches the supabase service-role key.
  // Wave 5d dashboard consumes this shape.
  const credentials = getCredentialSources();

  res.json({
    ok: true,
    status: 'ok',
    service: 'thecairn-web',
    redis: redisStatus,
    uptime: Math.round(process.uptime()),
    ts: new Date().toISOString(),
    credentials,
  });
});

export default router;
