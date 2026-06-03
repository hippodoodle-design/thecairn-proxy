/**
 * Provider-agnostic billing seam for The Cairn (Wave Cairn Customer Accounts,
 * dispatch ced83e2e).
 *
 * NOTHING here is wired to Polar, Paddle, or Stripe. The Merchant-of-Record /
 * provider decision is still open (Amanda). This module defines the INTERFACE
 * the rest of the Cairn talks to so a concrete provider adapter can slot in
 * later WITHOUT changing call sites:
 *
 *   - `subscriptions.billing_provider` is a nullable enum (polar|paddle|stripe).
 *   - The "one free storage month" entitlement is RECORDED in the data model now
 *     (see shared/src/entitlements). Its REALISATION as a 100%-off-first-period
 *     / 1-month trial is the provider's job — left here as a clearly-marked TODO
 *     behind `applyFreeMonth()`, which no-ops until a provider is wired.
 *
 * No provider keys are read or required by this file. When a provider is chosen,
 * add its adapter and return it from getBillingProvider() keyed off
 * CAIRN_BILLING_PROVIDER (+ secrets via Buddy/env).
 */

/** The provider names the schema's billing_provider enum allows. */
export const BILLING_PROVIDERS = ['polar', 'paddle', 'stripe'];

/** Thrown when a flow needs a billing provider but none is wired yet. */
export class BillingNotConfiguredError extends Error {
  constructor(operation) {
    super(`Billing provider not configured — cannot ${operation}. Choose Polar/Paddle/Stripe and wire its adapter.`);
    this.name = 'BillingNotConfiguredError';
    this.operation = operation;
    this.code = 'BILLING_NOT_CONFIGURED';
  }
}

/**
 * The null adapter: a complete, safe no-op implementation of the provider
 * interface. Checkout genuinely cannot happen without a provider, so
 * createCheckoutSession throws; the free-month realisation degrades gracefully
 * (returns {applied:false}) so the entitlement can still be RECORDED without a
 * provider present.
 */
export const nullBillingProvider = {
  name: null,
  configured: false,

  /**
   * Begin a paid Cairn subscription checkout. No provider → genuinely can't.
   * @returns {Promise<{url: string, provider: string}>}
   */
  async createCheckoutSession() {
    throw new BillingNotConfiguredError('createCheckoutSession');
  },

  /**
   * Realise a recorded `free_storage_month` entitlement at checkout as a
   * 100%-off-first-period / 1-month trial.
   *
   * TODO(provider): translate the entitlement into the provider's coupon/trial
   * primitive (e.g. a 100%-off-once coupon or a trial_period_days=30 on the
   * subscription). The entitlement is the durable source of truth — recorded by
   * shared/src/entitlements regardless of provider; this only APPLIES it.
   *
   * No-ops until a provider is wired so callers can record intent without
   * branching on provider presence.
   * @returns {Promise<{applied: boolean, reason: string}>}
   */
  async applyFreeMonth() {
    return { applied: false, reason: 'no_provider' };
  },
};

/**
 * Resolve the active billing provider adapter. Until an adapter is built, even a
 * named CAIRN_BILLING_PROVIDER falls through to the null adapter (so nothing
 * breaks before the integration lands) — but an UNKNOWN name is a config error.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function getBillingProvider(env = process.env) {
  const name = env.CAIRN_BILLING_PROVIDER || null;
  if (name && !BILLING_PROVIDERS.includes(name)) {
    throw new Error(`Unknown CAIRN_BILLING_PROVIDER "${name}" — expected one of ${BILLING_PROVIDERS.join(', ')}`);
  }
  // TODO(provider): when an adapter exists, `switch (name) { case 'polar': ... }`
  // and return it. Until then, the null adapter is the only implementation.
  return nullBillingProvider;
}
