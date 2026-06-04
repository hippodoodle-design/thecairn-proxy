import { createLogger } from '../logger.js';

const log = createLogger('cairn-import-safety');

/**
 * Server-side known-CSAM HASH-LIST matcher for the Cairn phone-importer.
 *
 * The phone-importer matches client-computed HASHES (never media) against a
 * LICENSED known-CSAM hash list, SERVER-SIDE. The list is licensed: it MUST
 * live server-side, NEVER on-device, NEVER shipped to the client. This matcher
 * is intentionally:
 *   - operator-blind: it only ever receives hashes — no media, no human eyes,
 *     no AI classifier;
 *   - log-quiet: it logs ONLY counts, never the hash strings themselves (a
 *     hash is a pointer to known material);
 *   - FAIL-CLOSED: if the licensed list is not provisioned, NOTHING is allowed.
 *
 * BLOCKER (dispatch e1c0d2a7, 4 Jun 2026): the IWF hash-list licence/credential
 * is not yet provisioned. Until it is, every check fails closed — the importer
 * has no customer-facing arm. Flipping to live is a configuration change
 * (provide the hash-list source + credential, then wire matchHashesLive below).
 */

/**
 * True iff the licensed hash-list source is configured AND its real client is
 * wired. Today this returns false unconditionally because the IWF hash-list
 * licence has not landed and the live client (matchHashesLive) is a scaffold.
 *
 * Activation, when the licence lands, is two steps in this file + env:
 *   1. set CAIRN_IWF_HASHLIST_ENABLED=true and the source/credential env, and
 *   2. implement matchHashesLive() against the confirmed hash-list contract.
 * Both are required: a half-configured env can never fail-open.
 */
export function isHashMatchConfigured() {
  const enabled = (process.env.CAIRN_IWF_HASHLIST_ENABLED || '').trim().toLowerCase() === 'true';
  const hasSource = Boolean((process.env.CAIRN_IWF_HASHLIST_URL || '').trim());
  // LIVE_CLIENT_WIRED stays false until matchHashesLive is implemented against
  // the real, confirmed IWF hash-list contract. This is the deliberate second
  // lock that keeps a flag-only flip from fail-opening.
  const LIVE_CLIENT_WIRED = false;
  return enabled && hasSource && LIVE_CLIENT_WIRED;
}

/**
 * Match a batch of hashes against the licensed known-CSAM hash list.
 *
 * @param {string[]} hashes
 * @returns {Promise<{ allow: string[], blocked: string[], available: boolean }>}
 *   available=false means the licensed list is not provisioned/wired — the
 *   caller MUST fail closed (block all, do not store). When available=true,
 *   `allow` are hashes not on the list and `blocked` are hashes on the list.
 */
export async function matchHashes(hashes) {
  const unique = [...new Set(hashes)];

  if (!isHashMatchConfigured()) {
    // FAIL-CLOSED: nothing is allowed when the licensed matcher is absent.
    log.warn({ msg: 'hashmatch:fail-closed', reason: 'hashlist_unprovisioned', count: unique.length });
    return { allow: [], blocked: unique, available: false };
  }

  // Reached only once the licence lands AND matchHashesLive is implemented.
  return matchHashesLive(unique);
}

/**
 * LIVE seam — match against the real licensed hash list.
 *
 * NOT YET IMPLEMENTED. The exact source contract (endpoint shape, auth header,
 * hash algorithm, response fields) must be confirmed against the IWF hash-list
 * integration docs before this is wired. Until then isHashMatchConfigured()
 * returns false so this is never reached; if it somehow is, it fails closed.
 *
 * @param {string[]} hashes
 * @returns {Promise<{ allow: string[], blocked: string[], available: boolean }>}
 */
export async function matchHashesLive(hashes) {
  log.error({ msg: 'hashmatch:live-not-wired', count: hashes.length });
  return { allow: [], blocked: hashes, available: false };
}
