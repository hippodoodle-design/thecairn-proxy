import jwt from 'jsonwebtoken';
import { createLogger } from '@cairn/shared/logger';

const log = createLogger('thecairn-web');

/**
 * Validates a Supabase-issued access token. Supabase signs user JWTs with
 * HS256 using the project's JWT secret (Settings -> API -> JWT Settings).
 * On success attaches { userId, email, token } to req.auth.
 */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    log.warn({ event: 'auth_rejected', reason: 'missing_header' });
    return res.status(401).json({ ok: false, error: 'Missing Authorization header' });
  }

  const token = match[1].trim();
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    // Fail closed — never accept unsigned tokens in prod.
    log.warn({ event: 'auth_rejected', reason: 'not_configured' });
    return res.status(500).json({ ok: false, error: 'Server auth not configured' });
  }

  let payload;
  try {
    payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch {
    log.warn({ event: 'auth_rejected', reason: 'invalid_token' });
    return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }

  const userId = payload?.sub;
  if (!userId) {
    log.warn({ event: 'auth_rejected', reason: 'missing_subject' });
    return res.status(401).json({ ok: false, error: 'Invalid token: missing subject' });
  }

  req.auth = {
    userId,
    email: payload.email || null,
    token,
  };
  next();
}
