import { createLogger } from '@cairn/shared/logger';
import { getServiceClient } from '@cairn/shared/supabase';

const log = createLogger('thecairn-web');

/**
 * Validates a Supabase-issued access token by asking Supabase.
 * Works with any current or future signing scheme (HS256, ECC P-256 / asymmetric
 * JWTs, etc.) because verification is delegated to the Supabase server via
 * supabase.auth.getUser(token). Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 * On success attaches { userId, email, token } to req.auth.
 */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    log.warn({ event: 'auth_rejected', reason: 'missing_header' });
    return res.status(401).json({ ok: false, error: 'Missing Authorization header' });
  }

  const token = match[1].trim();
  if (!token) {
    log.warn({ event: 'auth_rejected', reason: 'missing_header' });
    return res.status(401).json({ ok: false, error: 'Missing Authorization header' });
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    log.warn({ event: 'auth_rejected', reason: 'not_configured' });
    return res.status(500).json({ ok: false, error: 'Server auth not configured' });
  }

  let supabase;
  try {
    supabase = getServiceClient();
  } catch {
    log.warn({ event: 'auth_rejected', reason: 'not_configured' });
    return res.status(500).json({ ok: false, error: 'Server auth not configured' });
  }

  let data, error;
  try {
    ({ data, error } = await supabase.auth.getUser(token));
  } catch (err) {
    log.warn({ event: 'auth_rejected', reason: 'rejected_by_supabase', supabaseError: err?.message });
    return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }

  if (error || !data?.user) {
    log.warn({ event: 'auth_rejected', reason: 'rejected_by_supabase', supabaseError: error?.message });
    return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }

  const user = data.user;
  req.auth = {
    userId: user.id,
    email: user.email || null,
    token,
  };
  next();
}
