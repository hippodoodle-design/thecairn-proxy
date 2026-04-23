import { Router } from 'express';
import { getRedisConnection } from '@cairn/shared/queue';
import { createLogger } from '@cairn/shared/logger';

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

  res.json({
    ok: true,
    service: 'thecairn-web',
    redis: redisStatus,
    uptime: Math.round(process.uptime()),
    ts: new Date().toISOString(),
  });
});

export default router;
