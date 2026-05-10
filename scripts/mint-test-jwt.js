/**
 * Mint a short-lived HS256 Supabase-shaped JWT for end-to-end testing of
 * authenticated proxy endpoints (e.g. POST /api/r2/sign).
 *
 * Reads SUPABASE_JWT_SECRET from env and prints the resulting token to
 * stdout. No other output — safe to capture in a shell variable:
 *
 *   JWT=$(railway run --service @cairn/web -- node scripts/mint-test-jwt.js)
 *
 * Token claims:
 *   sub  = <user_id arg, defaults to Amanda's primary id>
 *   aud  = "authenticated"
 *   role = "authenticated"
 *   iss  = "supabase"
 *   exp  = now + 300s (5 minutes)
 *
 * The web auth middleware verifies via supabase.auth.getUser(token), which
 * accepts HS256 tokens signed with the project's JWT secret as long as the
 * legacy HS256 verification path is still enabled on the Supabase project.
 */

import jwt from 'jsonwebtoken';

const DEFAULT_SUB = 'baa53360-5eab-45bc-9c3e-f84de67b06e3';

const sub = process.argv[2] || DEFAULT_SUB;
const secret = process.env.SUPABASE_JWT_SECRET;

if (!secret) {
  console.error('SUPABASE_JWT_SECRET not set');
  process.exit(1);
}

const token = jwt.sign(
  {
    sub,
    aud: 'authenticated',
    role: 'authenticated',
    iss: 'supabase',
  },
  secret,
  { algorithm: 'HS256', expiresIn: '5m' },
);

process.stdout.write(token);
