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

/**
 * True when a PostgREST error means "this table doesn't exist yet" — either
 * Postgres 42P01 ("relation does not exist") or PGRST205 (no entry in the
 * schema cache). Lets a job no-op gracefully when its migration hasn't been
 * applied, rather than failing on a schedule. Mirrors scripts/test-companions.js.
 */
export function isMissingTable(error) {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  return /does not exist|schema cache|could not find the table/i.test(error.message || '');
}
