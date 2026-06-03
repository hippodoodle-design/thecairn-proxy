/**
 * Cairn customer accounts + entitlements — the provider-agnostic seam.
 *
 * Pure logic, no I/O. The durable source of truth for the free-month rule lives
 * in SQL (migration 008, public.grant_free_month_if_eligible) so it cannot be
 * bypassed; this module mirrors the same rule for backend code that wants to
 * REASON about eligibility (e.g. show "you've earned a free month" copy) without
 * a round-trip, and defines the billing-provider seam that the checkout layer
 * will implement once Amanda picks Polar / Paddle / Stripe.
 *
 * NOTHING here wires a provider, holds a key, or talks to a network. The billing
 * provider decision (MoR: Polar vs Paddle vs Stripe) is deliberately open.
 */

/**
 * The billing providers the data model is prepared for. The schema stores this
 * as a nullable CHECK (not a pg enum) so adding one later is a one-line change.
 * Order is not significance — the choice is still open.
 */
export const BILLING_PROVIDERS = Object.freeze(['polar', 'paddle', 'stripe']);

/** Products whose COMPLETED PAID rescue can trigger the free month. */
export const RESCUE_PRODUCTS = Object.freeze(['byteme', 'cairnferry']);

/** The single entitlement kind this wave introduces. */
export const FREE_STORAGE_MONTH = 'free_storage_month';
/** The only source that grants it. */
export const PAID_RESCUE_CONVERSION = 'paid_rescue_conversion';

/** Case-insensitive identity match for the cross-product email key. */
function sameEmail(a, b) {
  return (
    typeof a === 'string' &&
    typeof b === 'string' &&
    a.trim().toLowerCase() === b.trim().toLowerCase()
  );
}

/**
 * The founder-locked free-month rule, as a pure predicate. Mirror of the SQL
 * function in migration 008 — keep the two in sync. Grants ONLY when BOTH:
 *   (a) the SAME verified-email identity has a COMPLETED PAID rescue
 *       (status='paid') on ByteMe OR CairnFerry, AND
 *   (b) that customer has a PAID, ACTIVE Cairn subscription.
 * Never for waiting-list leads, free users, or trial-only users.
 *
 * @param {object} input
 * @param {string} input.email - the account's verified email
 * @param {Array<{product:string,email:string,status:string}>} input.paidRescues
 *        - candidate rescue records (any product/status; filtered here)
 * @param {{tier:string,status:string}|null} input.subscription
 *        - the account's current Cairn subscription
 * @returns {{ eligible: boolean, reason: string, productPaid: string|null }}
 *        reason ∈ no_paid_rescue | no_paid_cairn_subscription | eligible
 */
export function freeMonthEligibility({ email, paidRescues = [], subscription = null } = {}) {
  const rescue = (paidRescues || []).find(
    (r) =>
      r &&
      r.status === 'paid' &&
      RESCUE_PRODUCTS.includes(r.product) &&
      sameEmail(r.email, email),
  );
  if (!rescue) {
    return { eligible: false, reason: 'no_paid_rescue', productPaid: null };
  }

  const hasPaidSub =
    subscription && subscription.tier === 'paid' && subscription.status === 'active';
  if (!hasPaidSub) {
    return { eligible: false, reason: 'no_paid_cairn_subscription', productPaid: null };
  }

  return { eligible: true, reason: 'eligible', productPaid: rescue.product };
}

/**
 * The billing-provider seam. The checkout layer implements ONE of these once a
 * provider is chosen; until then every method is an explicit, marked TODO so a
 * half-wired provider can never silently no-op a real charge.
 *
 * This is intentionally a description, not an implementation — calling any
 * method throws so a caller cannot mistake the seam for a working provider.
 *
 * @typedef {object} BillingProviderSeam
 * @property {(accountId:string, plan:string)=>Promise<{checkoutUrl:string}>} createCheckout
 * @property {(accountId:string)=>Promise<void>} applyFreeMonthCoupon
 *           realise a recorded free_storage_month entitlement as a
 *           100%-off-first-period / 1-month trial at checkout
 * @property {(event:object)=>Promise<void>} handleWebhook
 */

/** A seam stub: present so the shape is documented; throws if mistaken for real. */
export function unwiredBillingProvider() {
  const notWired = (method) => () => {
    throw new Error(
      `Cairn billing provider not chosen/wired yet — ${method}() has no implementation. ` +
        `Pick one of ${BILLING_PROVIDERS.join('|')} and implement the seam (see migration 008 TODO).`,
    );
  };
  return Object.freeze({
    provider: null,
    createCheckout: notWired('createCheckout'),
    applyFreeMonthCoupon: notWired('applyFreeMonthCoupon'),
    handleWebhook: notWired('handleWebhook'),
  });
}
