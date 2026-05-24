import { createClient } from '@supabase/supabase-js';
import { getSupabaseServiceRoleKey } from './buddy.js';

/** @type {ReturnType<typeof createClient> | null} */
let cached = null;

/**
 * Service-role Supabase client. Bypasses RLS — worker use only.
 * Cached as a module-level singleton so a single worker instance
 * shares one pooled client across jobs (important at 50k+ users).
 *
 * Wave 5c (24 May 2026): now async — the service-role key is fetched
 * via Buddy with env-var fallback. The fetched key is cached inside
 * the resulting client; subsequent getServiceClient() calls return
 * the cached client without re-fetching.
 *
 * @returns {Promise<ReturnType<typeof createClient>>}
 */
export async function getServiceClient() {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('SUPABASE_URL is not set');

  const key = await getSupabaseServiceRoleKey();

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
