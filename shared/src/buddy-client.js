/**
 * buddy-client — vendored from hippobridge/lib/buddy-client.ts on 2026-05-24
 * (Wave 5c). ESM JS conversion with JSDoc types. Keep API identical to the
 * source so future re-vendors are a clean overwrite.
 *
 * Fetches credentials from HippoBuddy at runtime instead of hardcoding API
 * keys. Zero runtime dependencies, native fetch/Map only. Works in
 * Cloudflare Workers, Node 19+, and modern browsers.
 *
 *   const buddy = new BuddyClient({ url, bootstrapToken });
 *   const key = await buddy.get('supabase-thecairn-service-role');
 *
 * Cache: 5 min fresh, 30 min stale-while-revalidate (configurable). Stale
 * reads return the cached value AND kick off a background refresh that is
 * never awaited. The library never logs the credential value it fetches.
 */

/**
 * @typedef {Object} BuddyClientOptions
 * @property {string} url
 * @property {string} bootstrapToken
 * @property {'prod'|'staging'|'dev'} [environment]
 * @property {number} [cacheTtlMs]
 * @property {number} [staleWhileRevalidateMs]
 * @property {typeof fetch} [fetchImpl]
 */

/**
 * @typedef {'unauthorized'|'not_found'|'denied_scope'|'master_key_missing'|'network'|'decrypt_error'|'unknown'} BuddyErrorCode
 */

export class BuddyError extends Error {
  /**
   * @param {BuddyErrorCode} code
   * @param {number|null} httpStatus
   * @param {string} message
   */
  constructor(code, httpStatus, message) {
    super(message);
    this.name = 'BuddyError';
    /** @type {BuddyErrorCode} */
    this.code = code;
    /** @type {number|null} */
    this.httpStatus = httpStatus;
  }
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [100, 400, 1600];

// Failure-cache TTLs — avoid hammering Buddy on persistent client-side
// errors but keep them short enough that token rotation, scope edits, or
// credential creation propagate fast. Transient failures aren't cached.
/** @type {Record<BuddyErrorCode, number>} */
const ERROR_TTL_MS = {
  unauthorized: 10_000,
  denied_scope: 30_000,
  not_found: 60_000,
  master_key_missing: 0,
  network: 0,
  decrypt_error: 0,
  unknown: 0,
};

export class BuddyClient {
  /** @param {BuddyClientOptions} opts */
  constructor(opts) {
    this.url = opts.url.replace(/\/+$/, '');
    this.token = opts.bootstrapToken;
    this.defaultEnv = opts.environment ?? 'prod';
    this.cacheTtlMs = opts.cacheTtlMs ?? 5 * 60 * 1000;
    this.swrMs = opts.staleWhileRevalidateMs ?? 30 * 60 * 1000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    /** @type {Map<string, { kind: 'success', value: string, fetchedAt: number } | { kind: 'error', error: BuddyError, fetchedAt: number, ttlMs: number }>} */
    this.cache = new Map();
  }

  /**
   * @param {string} name
   * @param {{ environment?: string, forceRefresh?: boolean }} [opts]
   * @returns {Promise<string>}
   */
  async get(name, opts = {}) {
    const env = opts.environment ?? this.defaultEnv;
    const key = `${name}::${env}`;
    const entry = opts.forceRefresh ? undefined : this.cache.get(key);
    if (entry) {
      const age = Date.now() - entry.fetchedAt;
      if (entry.kind === 'success') {
        if (age < this.cacheTtlMs) return entry.value;
        if (age < this.swrMs) {
          this.fetchAndCache(name, env, key).catch(() => {});
          return entry.value;
        }
      } else if (age < entry.ttlMs) {
        throw entry.error;
      }
    }
    return this.fetchAndCache(name, env, key);
  }

  /** @param {string} name @param {{ environment?: string }} [opts] */
  invalidate(name, opts = {}) {
    this.cache.delete(`${name}::${opts.environment ?? this.defaultEnv}`);
  }

  clear() {
    this.cache.clear();
  }

  /** @private */
  async fetchAndCache(name, env, key) {
    try {
      const value = await this.fetchWithRetry(name, env);
      this.cache.set(key, { kind: 'success', value, fetchedAt: Date.now() });
      return value;
    } catch (err) {
      const error = err instanceof BuddyError ? err : new BuddyError('unknown', null, String(err));
      const ttlMs = ERROR_TTL_MS[error.code];
      if (ttlMs > 0) {
        this.cache.set(key, { kind: 'error', error, fetchedAt: Date.now(), ttlMs });
      }
      throw error;
    }
  }

  /** @private */
  async fetchWithRetry(name, env) {
    const url = `${this.url}/buddy/v2/service-credentials/by-name/${encodeURIComponent(name)}?environment=${encodeURIComponent(env)}`;
    /** @type {BuddyError | null} */
    let lastError = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
      /** @type {Response} */
      let res;
      try {
        res = await this.fetchImpl(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
        });
      } catch (e) {
        lastError = new BuddyError('network', null, `fetch failed: ${/** @type {Error} */ (e).message}`);
        continue;
      }
      if (res.status === 200) {
        const body = /** @type {{ value?: unknown }} */ (await res.json());
        if (typeof body.value !== 'string') {
          throw new BuddyError('unknown', 200, 'response missing "value" string');
        }
        return body.value;
      }
      if (res.status === 401) throw new BuddyError('unauthorized', 401, await msgFrom(res, 'unauthorized'));
      if (res.status === 403) throw new BuddyError('denied_scope', 403, await msgFrom(res, 'denied_scope'));
      if (res.status === 404) throw new BuddyError('not_found', 404, await msgFrom(res, 'not_found'));
      if (res.status >= 500 && res.status < 600) {
        const body = await safeJson(res);
        /** @type {BuddyErrorCode} */
        const code = body?.error === 'master_key_missing' ? 'master_key_missing' : 'network';
        lastError = new BuddyError(code, res.status, `buddy returned ${res.status}`);
        continue;
      }
      throw new BuddyError('unknown', res.status, `buddy returned ${res.status}`);
    }
    throw lastError ?? new BuddyError('unknown', null, 'retry loop exhausted without error');
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** @param {Response} res */
async function safeJson(res) {
  try {
    return /** @type {{ error?: string } | null} */ (await res.clone().json());
  } catch {
    return null;
  }
}

/** @param {Response} res @param {string} fallback */
async function msgFrom(res, fallback) {
  const body = /** @type {{ error?: string, message?: string } | null} */ (await safeJson(res));
  if (body && typeof body.error === 'string') {
    return typeof body.message === 'string' ? `${body.error}: ${body.message}` : body.error;
  }
  return fallback;
}
