import { Router } from 'express';
import { getServiceClient } from '@cairn/shared/supabase';
import { createLogger } from '@cairn/shared/logger';
import { grantFreeMonthIfEligible } from '@cairn/shared/entitlements';
import { requireAuth } from '../middleware/auth.js';
import { rateLimitPerUser } from '../middleware/rateLimit.js';

const log = createLogger('account-route');

/**
 * Ensure the customer's account row exists (idempotent) and return it. Keeps the
 * denormalised email fresh from the verified auth identity. Account creation is
 * "land in your own private archive" — it happens on the first authenticated
 * call, no separate sign-up step. Service role bypasses RLS; we scope by the
 * authed user id.
 */
async function ensureAccount(supabase, userId, email) {
  const norm = typeof email === 'string' ? email.trim().toLowerCase() : null;
  const { data, error } = await supabase
    .from('accounts')
    .upsert({ id: userId, email: norm }, { onConflict: 'id' })
    .select('id, email, tier, status, created_at, updated_at')
    .single();
  return { account: data ?? null, error };
}

const router = Router();

/**
 * GET /api/account
 * The signed-in customer's account home: ensures their account row exists, then
 * returns it alongside their subscription(s) and entitlements. Operator-blind by
 * construction — this only ever returns the caller's OWN account, never content.
 *
 * Opportunistically attempts the free-month grant when the account already has a
 * paid subscription, so the cross-product perk self-heals even before a billing
 * webhook is wired. Best-effort: a grant failure never fails the request.
 */
router.get('/', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId, email } = req.auth;
  const reqLog = log.child({ route: 'GET /api/account', ownerIdTail: userId.slice(-4) });
  try {
    const supabase = await getServiceClient();

    const { account, error: accErr } = await ensureAccount(supabase, userId, email);
    if (accErr) {
      reqLog.error({ msg: 'account: ensure failed', err: accErr });
      return res.status(500).json({ ok: false, error: 'Could not load your account' });
    }

    const [{ data: subs, error: subErr }, { data: ents, error: entErr }] = await Promise.all([
      supabase
        .from('subscriptions')
        .select('id, tier, storage_quota_gb, status, current_period_end, billing_provider')
        .eq('account_id', userId)
        .order('created_at', { ascending: false }),
      supabase
        .from('entitlements')
        .select('id, kind, source, product_paid, quantity, granted_at, consumed_at')
        .eq('account_id', userId)
        .order('granted_at', { ascending: false }),
    ]);
    if (subErr) reqLog.warn({ msg: 'account: subscriptions read failed', err: subErr });
    if (entErr) reqLog.warn({ msg: 'account: entitlements read failed', err: entErr });

    const subscriptions = subs ?? [];
    const hasPaid = subscriptions.some(
      (s) => s.tier === 'paid' && (s.status === 'active' || s.status === 'trialing'),
    );

    // Self-heal the free-month grant if they're already paid (best-effort).
    if (hasPaid) {
      const grant = await grantFreeMonthIfEligible(supabase, { accountId: userId, email, log: reqLog });
      if (grant.granted) reqLog.info({ msg: 'account: free-month granted on read' });
    }

    return res.json({
      ok: true,
      account,
      subscriptions,
      entitlements: ents ?? [],
    });
  } catch (err) {
    reqLog.error({ msg: 'account threw', err });
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

/**
 * POST /api/account/claim-free-month
 * The checkout-time / post-payment trigger for the cross-product free month.
 * Evaluates the founder rule and RECORDS the entitlement if eligible (idempotent).
 *
 * The actual coupon / 100%-off-first-period realisation is the billing provider's
 * job (shared/src/billing applyFreeMonth) — a TODO until a provider is wired.
 * This endpoint is the durable record; a future billing webhook should call the
 * same grantFreeMonthIfEligible when a subscription flips to paid.
 */
router.post('/claim-free-month', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId, email } = req.auth;
  const reqLog = log.child({ route: 'POST /api/account/claim-free-month', ownerIdTail: userId.slice(-4) });
  try {
    const supabase = await getServiceClient();
    // Make sure the account row exists before granting against it.
    const { error: accErr } = await ensureAccount(supabase, userId, email);
    if (accErr) {
      reqLog.error({ msg: 'claim-free-month: ensure account failed', err: accErr });
      return res.status(500).json({ ok: false, error: 'Internal error' });
    }

    const result = await grantFreeMonthIfEligible(supabase, { accountId: userId, email, log: reqLog });
    // 'granted' and 'already_granted' are both success-shaped for the caller;
    // the rest are "not eligible (yet)" and reported as ok:true + granted:false.
    return res.json({ ok: true, granted: result.granted, reason: result.reason });
  } catch (err) {
    reqLog.error({ msg: 'claim-free-month threw', err });
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

export default router;
