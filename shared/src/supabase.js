import { createClient } from '@supabase/supabase-js';

let cached = null;

/**
 * Service-role Supabase client. Bypasses RLS — worker use only.
 * Cached as a module-level singleton so a single worker instance
 * shares one pooled client across jobs (important at 50k+ users).
 */
export function getServiceClient() {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error('SUPABASE_URL is not set');
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');

  cached = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: { 'x-cairn-service': 'thecairn-worker' },
    },
  });

  return cached;
}
