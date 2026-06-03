/**
 * Entitlement logic for The Cairn (Wave Cairn Customer Accounts, dispatch
 * ced83e2e). Pure-ish helpers over the service-role Supabase client; no Redis,
 * no provider keys.
 *
 * THE FREE-MONTH RULE (founder-locked, exact). A 'one free storage month' is
 * granted ONLY when BOTH are true:
 *   (a) the SAME customer identity (verified email) has a COMPLETED PAID rescue
 *       on EITHER ByteMe OR CairnFerry (paid_rescues.status='paid'), AND
 *   (b) that customer then starts a PAID Cairn subscription
 *       (subscriptions.tier='paid' AND status in (trialing, active)).
 * Never granted to waiting-list leads, free users, or trial-only-without-rescue.
 * Granted ONCE per customer — idempotency is enforced by the DB
 * UNIQUE(account_id, kind) guard (migration 008); a repeat attempt is a no-op.
 *
 * Recording the entitlement is this module's job. REALISING it (the actual
 * 100%-off-first-period / 1-month trial) is the billing provider's job and is
 * left as a seam in shared/src/billing — see applyFreeMonth().
 */

import { isMissingTable } from '../supabase.js';

export const FREE_MONTH = Object.freeze({
  kind: 'free_storage_month',
  source: 'paid_rescue_conversion',
});

const PG_UNIQUE_VIOLATION = '23505';

/** Lower-case + trim an email; null if not a usable address. */
export function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const norm = email.trim().toLowerCase();
  return norm.includes('@') ? norm : null;
}

function isUniqueViolation(error) {
  return error?.code === PG_UNIQUE_VIOLATION || /duplicate key value/i.test(error?.message || '');
}

/**
 * Rule (a): the earliest COMPLETED paid rescue for this email across ByteMe /
 * CairnFerry, or null. paid_rescues.email is stored lower-cased by the ingest
 * (forward contract — those paid flows are not live yet); we match on the
 * normalised address.
 *
 * @returns {Promise<{rescue?: object|null, error?: object, missingTable?: boolean}>}
 */
export async function findCompletedPaidRescue(supabase, email) {
  const norm = normalizeEmail(email);
  if (!norm) return { rescue: null };
  const { data, error } = await supabase
    .from('paid_rescues')
    .select('product, status, paid_at')
    .eq('email', norm)
    .eq('status', 'paid')
    .order('paid_at', { ascending: true, nullsFirst: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return { rescue: null, missingTable: true };
    return { error };
  }
  return { rescue: data ?? null };
}

/**
 * Rule (b): does this account have a PAID Cairn subscription? A free-month trial
 * is realised as status='trialing' tier='paid', so trialing counts as "started a
 * paid subscription".
 *
 * @returns {Promise<{paid?: boolean, error?: object, missingTable?: boolean}>}
 */
export async function hasPaidSubscription(supabase, accountId) {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('id')
    .eq('account_id', accountId)
    .eq('tier', 'paid')
    .in('status', ['trialing', 'active'])
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error)) return { paid: false, missingTable: true };
    return { error };
  }
  return { paid: !!data };
}

/**
 * Grant the free storage month IF (and only if) both halves of the founder rule
 * hold. Idempotent: a second eligible call returns { granted:false,
 * reason:'already_granted' } thanks to the UNIQUE(account_id, kind) guard.
 *
 * Returns a structured outcome rather than throwing on the expected "not
 * eligible" paths, so callers can treat it as best-effort.
 *
 * @param {object} supabase service-role client
 * @param {object} opts
 * @param {string} opts.accountId
 * @param {string} opts.email verified customer email
 * @param {object} [opts.log] optional logger (warn/info)
 * @returns {Promise<{granted: boolean, reason: string, entitlement?: object}>}
 */
export async function grantFreeMonthIfEligible(supabase, { accountId, email, log } = {}) {
  if (!accountId) return { granted: false, reason: 'no_account' };

  // (a) completed paid rescue on byteme|cairnferry
  const a = await findCompletedPaidRescue(supabase, email);
  if (a.error) {
    log?.warn?.({ msg: 'free-month: paid_rescue lookup failed', err: a.error });
    return { granted: false, reason: 'lookup_error' };
  }
  if (a.missingTable) return { granted: false, reason: 'schema_not_applied' };
  if (!a.rescue) return { granted: false, reason: 'no_paid_rescue' };

  // (b) paid Cairn subscription
  const b = await hasPaidSubscription(supabase, accountId);
  if (b.error) {
    log?.warn?.({ msg: 'free-month: subscription check failed', err: b.error });
    return { granted: false, reason: 'lookup_error' };
  }
  if (b.missingTable) return { granted: false, reason: 'schema_not_applied' };
  if (!b.paid) return { granted: false, reason: 'no_paid_subscription' };

  // Both hold — record the entitlement once. The UNIQUE guard makes a concurrent
  // / repeat grant a no-op (23505 → already_granted).
  const { data, error } = await supabase
    .from('entitlements')
    .insert({
      account_id: accountId,
      kind: FREE_MONTH.kind,
      source: FREE_MONTH.source,
      product_paid: a.rescue.product,
      quantity: 1,
    })
    .select('*')
    .single();

  if (error) {
    if (isUniqueViolation(error)) return { granted: false, reason: 'already_granted' };
    if (isMissingTable(error)) return { granted: false, reason: 'schema_not_applied' };
    log?.warn?.({ msg: 'free-month: grant insert failed', err: error });
    return { granted: false, reason: 'grant_error' };
  }

  log?.info?.({ msg: 'free-month: granted', product_paid: a.rescue.product });
  return { granted: true, reason: 'granted', entitlement: data };
  // NOTE: realising this as a 100%-off-first-period / 1-month trial is the
  // billing provider's job (shared/src/billing applyFreeMonth) — TODO until a
  // provider is wired. The entitlement row above is the durable source of truth.
}
