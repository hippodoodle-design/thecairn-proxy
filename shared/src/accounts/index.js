/**
 * Cairn customer-accounts logic — the account anchor, subscriptions read, the
 * cross-product free-month entitlement, and the PROVIDER-AGNOSTIC billing seam.
 *
 * Pure-ish helpers over a service-role Supabase client (the client bypasses RLS;
 * every function scopes to a userId/account_id in code). No payment provider is
 * wired here — `applyFreeMonthAtCheckout` is a clearly-marked seam.
 *
 * Schema: migration 008 (accounts / subscriptions / entitlements / paid_rescues
 * + grant_free_storage_month). Until that migration is applied these helpers
 * no-op gracefully via isMissingTable, mirroring the zoo-life crons.
 *
 * Dispatch: ced83e2e-15cd-4d71-8e65-4ac867d9105e.
 */
import { isMissingTable } from '../supabase.js';

/** The fixed set of billing providers the seam can later be wired to. The
 *  Merchant-of-Record decision (Polar / Paddle / Stripe) is still OPEN — nothing
 *  here picks one. */
export const BILLING_PROVIDERS = ['polar', 'paddle', 'stripe'];

export const FREE_MONTH = Object.freeze({
  kind: 'free_storage_month',
  source: 'paid_rescue_conversion',
});

/**
 * Ensure the signed-in customer has an account row. The 008 trigger
 * (on_auth_user_created_make_account) creates it for new sign-ups; this upsert
 * covers users created before the trigger existed and keeps the denormalised
 * verified email fresh. Idempotent.
 *
 * @returns {Promise<{ account: object|null, missingSchema: boolean }>}
 */
export async function ensureAccount(supabase, { userId, email }) {
  const { data, error } = await supabase
    .from('accounts')
    .upsert({ id: userId, email: email ?? null }, { onConflict: 'id' })
    .select('id, email, tier, status, created_at')
    .single();

  if (error) {
    if (isMissingTable(error)) return { account: null, missingSchema: true };
    throw error;
  }
  return { account: data, missingSchema: false };
}

/**
 * The customer's full account state for "land in your own private archive":
 * the account row, their live subscription (if any), and their entitlements.
 * Operator-blind — this is the customer's own data only.
 *
 * @returns {Promise<{ account, subscription, entitlements, missingSchema }>}
 */
export async function getAccountState(supabase, { userId, email }) {
  const ensured = await ensureAccount(supabase, { userId, email });
  if (ensured.missingSchema) {
    return { account: null, subscription: null, entitlements: [], missingSchema: true };
  }

  const [{ data: subs, error: subErr }, { data: ents, error: entErr }] = await Promise.all([
    supabase
      .from('subscriptions')
      .select('id, tier, storage_quota_gb, status, current_period_end, billing_provider')
      .eq('account_id', userId)
      .in('status', ['trialing', 'active', 'past_due', 'incomplete'])
      .order('created_at', { ascending: false })
      .limit(1),
    supabase
      .from('entitlements')
      .select('id, kind, source, product_paid, quantity, granted_at, consumed_at')
      .eq('account_id', userId)
      .order('granted_at', { ascending: false }),
  ]);

  if (subErr && !isMissingTable(subErr)) throw subErr;
  if (entErr && !isMissingTable(entErr)) throw entErr;

  return {
    account: ensured.account,
    subscription: subs?.[0] ?? null,
    entitlements: ents ?? [],
    missingSchema: false,
  };
}

/**
 * Land a paid-rescue record (ByteMe / CairnFerry). This is the seam the upstream
 * rescue products call when a rescue is PAID; also used by tests to exercise the
 * free-month rule. Idempotent on (product, external_ref) when external_ref set.
 *
 * NOTE: the real ByteMe/CairnFerry paid flows are not live yet — this is the
 * landing point for the moment they are.
 */
export async function recordPaidRescue(supabase, { product, email, status = 'paid', paidAt, externalRef, accountId }) {
  if (!['byteme', 'cairnferry'].includes(product)) {
    throw new Error(`recordPaidRescue: product must be byteme|cairnferry, got ${product}`);
  }
  const row = {
    product,
    email,
    status,
    paid_at: paidAt ?? (status === 'paid' ? new Date().toISOString() : null),
    external_ref: externalRef ?? null,
    account_id: accountId ?? null,
  };
  // The (product, external_ref) uniqueness guard is a PARTIAL index (only WHERE
  // external_ref IS NOT NULL), so it can only be used as an upsert conflict
  // target when external_ref is present. Without a ref, fall back to a plain
  // insert (the upstream product owns idempotency via its ref in practice).
  const builder = supabase.from('paid_rescues');
  const query = externalRef
    ? builder.upsert(row, { onConflict: 'product,external_ref', ignoreDuplicates: false })
    : builder.insert(row);
  const { data, error } = await query
    .select('id, product, email, status, paid_at')
    .single();
  if (error) {
    if (isMissingTable(error)) return { rescue: null, missingSchema: true };
    throw error;
  }
  return { rescue: data, missingSchema: false };
}

/**
 * Attempt the founder-locked free-month grant for an account. Delegates the
 * EXACT rule to the SECURITY DEFINER SQL function grant_free_storage_month so
 * the policy lives in one place (migration 008). Returns the entitlement id when
 * granted (or already present), null when the rule is not satisfied.
 *
 * The rule (recap): granted ONLY when (a) a status=paid rescue exists for the
 * account's verified email AND (b) the account has a paid Cairn subscription.
 * Idempotent — once per customer.
 */
export async function attemptFreeMonthGrant(supabase, accountId) {
  const { data, error } = await supabase.rpc('grant_free_storage_month', { p_account_id: accountId });
  if (error) {
    if (isMissingTable(error)) return { entitlementId: null, missingSchema: true };
    throw error;
  }
  return { entitlementId: data ?? null, missingSchema: false };
}

/**
 * BILLING PROVIDER SEAM — NOT WIRED.
 *
 * TODO(billing): once the Merchant-of-Record provider is chosen (Polar / Paddle
 * / Stripe), realise a granted free_storage_month entitlement as a 100%-off-
 * first-period coupon / 1-month trial at Cairn checkout via that provider's API.
 * The entitlement is already RECORDED by attemptFreeMonthGrant; this function is
 * the single place the coupon/trial application will live. It deliberately does
 * nothing today and touches no provider keys.
 *
 * @returns {{ applied: false, reason: string }}
 */
export function applyFreeMonthAtCheckout(/* { entitlement, provider, providerCustomerId } */) {
  return {
    applied: false,
    reason: 'billing-provider-not-wired: MoR decision (polar|paddle|stripe) still open',
  };
}
