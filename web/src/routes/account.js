import { Router } from 'express';
import { getServiceClient } from '@cairn/shared/supabase';
import { createLogger } from '@cairn/shared/logger';
import {
  getAccountState,
  attemptFreeMonthGrant,
  applyFreeMonthAtCheckout,
  BILLING_PROVIDERS,
} from '@cairn/shared/accounts';
import { requireAuth } from '../middleware/auth.js';
import { rateLimitPerUser } from '../middleware/rateLimit.js';

const log = createLogger('account-route');
const router = Router();

/**
 * GET /api/account/me
 * The signed-in customer's own account: their account row, live subscription
 * (if any), and entitlements. This is "land in your own private archive" — it
 * returns ONLY the caller's data (operator-blind). Sign-in itself is passwordless
 * Supabase magic-link, done on the client; the backend trusts the verified token
 * (see middleware/auth.js) and ensures the account anchor exists here.
 */
router.get('/me', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId, email } = req.auth;
  const reqLog = log.child({ route: 'GET /api/account/me', ownerIdTail: userId.slice(-4) });
  try {
    const supabase = await getServiceClient();
    const state = await getAccountState(supabase, { userId, email });
    if (state.missingSchema) {
      // Accounts migration 008 not applied yet — answer honestly without 500ing.
      return res.json({ ok: true, ready: false, account: null, subscription: null, entitlements: [] });
    }
    return res.json({
      ok: true,
      ready: true,
      account: state.account,
      subscription: state.subscription,
      entitlements: state.entitlements,
    });
  } catch (err) {
    reqLog.error({ msg: 'account/me failed', err });
    return res.status(500).json({ ok: false, error: 'Could not load your account' });
  }
});

/**
 * POST /api/account/subscription/start  — BILLING SEAM (no provider wired).
 * body: { provider?, providerCustomerId?, providerSubscriptionId?, storageQuotaGb? }
 *
 * Records that this customer has STARTED A PAID Cairn subscription (rule b of the
 * free-month interlock) and then attempts the founder-locked free-month grant.
 * Provider is OPTIONAL and provider-agnostic — when the MoR provider is later
 * chosen this endpoint becomes the place its webhook/confirmation writes through.
 * No provider keys are used; nothing here charges a card.
 */
router.post('/subscription/start', requireAuth, rateLimitPerUser, async (req, res) => {
  const { userId, email } = req.auth;
  const reqLog = log.child({ route: 'POST /api/account/subscription/start', ownerIdTail: userId.slice(-4) });

  const { provider, providerCustomerId, providerSubscriptionId, storageQuotaGb } = req.body ?? {};
  if (provider != null && !BILLING_PROVIDERS.includes(provider)) {
    return res.status(400).json({ ok: false, error: `provider must be one of ${BILLING_PROVIDERS.join(', ')} or omitted` });
  }
  if (storageQuotaGb != null && (!Number.isInteger(storageQuotaGb) || storageQuotaGb < 0)) {
    return res.status(400).json({ ok: false, error: 'storageQuotaGb must be a non-negative integer' });
  }

  try {
    const supabase = await getServiceClient();

    // Ensure the account anchor exists first (foreign key + grant rule depend on it).
    const state = await getAccountState(supabase, { userId, email });
    if (state.missingSchema) {
      return res.status(409).json({ ok: false, error: 'accounts not set up yet — migration 008 pending' });
    }

    // Record the PAID subscription (the interlock). One live row per account
    // (partial unique index in 008) — upsert by account_id.
    const subRow = {
      account_id: userId,
      tier: 'paid',
      status: 'active',
      storage_quota_gb: storageQuotaGb ?? 0,
      billing_provider: provider ?? null,
      provider_customer_id: providerCustomerId ?? null,
      provider_subscription_id: providerSubscriptionId ?? null,
    };
    const { error: subErr } = await supabase
      .from('subscriptions')
      .upsert(subRow, { onConflict: 'account_id' });
    if (subErr) {
      reqLog.error({ msg: 'subscription upsert failed', err: subErr });
      return res.status(500).json({ ok: false, error: 'Could not start your subscription' });
    }

    // Attempt the founder-locked free-month grant now both legs may be true.
    const grant = await attemptFreeMonthGrant(supabase, userId);
    // Realising the grant as a coupon/trial is deliberately NOT wired (seam).
    const checkout = applyFreeMonthAtCheckout();

    reqLog.info({ msg: 'subscription started', granted: !!grant.entitlementId, provider: provider ?? null });
    return res.status(201).json({
      ok: true,
      subscription: { tier: 'paid', status: 'active' },
      freeMonth: {
        granted: !!grant.entitlementId,
        entitlementId: grant.entitlementId,
        // Truthful seam disclosure to the caller/UI.
        appliedAtCheckout: checkout.applied,
        note: checkout.reason,
      },
    });
  } catch (err) {
    reqLog.error({ msg: 'subscription/start threw', err });
    return res.status(500).json({ ok: false, error: 'Could not start your subscription' });
  }
});

export default router;
