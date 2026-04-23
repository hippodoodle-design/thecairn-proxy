/**
 * Cairn logger.
 *
 * Two output modes:
 *   - pretty (default): emoji-prefixed single-line format for humans reading Railway logs
 *   - json (LOG_FORMAT=json): single-line JSON for log aggregators (Logtail, Datadog, etc.)
 *
 * Event-driven: pass { event: 'stone_landed', ...fields } and the logger picks an emoji
 * and (for stone_landed) a warmer phrasing. Unnamed events render with a neutral bullet.
 *
 * Public interface (stable):
 *   const log = createLogger('thecairn-web');
 *   log.info({ event: 'server_ready', port });
 *   log.warn({ event: 'rate_limited', ownerIdTail });
 *   log.error({ msg: 'boom', err });
 *   const child = log.child({ jobId }); child.info({ event: 'job_started' });
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const EVENT_EMOJI = {
  stone_landed: '🪨',
  url_fetched: '🌐',
  job_enqueued: '📥',
  job_started: '🚀',
  job_failed: '⚠️',
  job_retrying: '🔁',
  auth_rejected: '🔒',
  rate_limited: '🚦',
  health_ok: '✅',
  server_ready: '💛',
  worker_ready: '💛',
};
const UNKNOWN_EMOJI = '•';

function currentMinLevel() {
  const raw = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[raw] ?? LEVELS.info;
}

function isJsonMode() {
  return (process.env.LOG_FORMAT || '').toLowerCase() === 'json';
}

function serializeError(err) {
  if (!(err instanceof Error)) return err;
  return { name: err.name, message: err.message, stack: err.stack };
}

/**
 * Normalise the user-supplied payload. Accepts:
 *   - an Error              -> { err: {...} }
 *   - a string              -> { msg: '...' }
 *   - a plain object        -> the object (with any err field serialised)
 *   - null/undefined        -> {}
 */
function normalise(fields) {
  if (fields == null) return {};
  if (fields instanceof Error) return { err: serializeError(fields) };
  if (typeof fields === 'string') return { msg: fields };
  if (typeof fields !== 'object') return { value: fields };
  if (fields.err instanceof Error) {
    return { ...fields, err: serializeError(fields.err) };
  }
  return { ...fields };
}

/**
 * One-line safe: strip newlines/tabs, collapse whitespace, truncate.
 */
function singleLine(value, maxLen = 120) {
  if (typeof value !== 'string') return value;
  const cleaned = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1) + '…';
}

function formatPretty(ts, service, level, payload) {
  const { event, ...rest } = payload;
  const emoji = EVENT_EMOJI[event] || UNKNOWN_EMOJI;
  const label = event || '-';

  if (event === 'stone_landed') {
    const title = singleLine(rest.title ?? '', 120);
    const siteName = singleLine(rest.siteName ?? 'unknown', 60);
    const durationMs = rest.durationMs ?? '?';
    const { title: _t, siteName: _s, durationMs: _d, ...tail } = rest;
    const tailStr = Object.keys(tail).length ? ' ' + JSON.stringify(tail) : '';
    return `${emoji} ${ts} [${service}] Stone laid — '${title}' from ${siteName} (${durationMs}ms)${tailStr}`;
  }

  const restStr = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
  return `${emoji} ${ts} [${service}] ${label}${restStr}`;
}

function emit(service, level, fields) {
  if (LEVELS[level] < currentMinLevel()) return;

  const ts = new Date().toISOString();
  const payload = normalise(fields);

  let line;
  if (isJsonMode()) {
    line = JSON.stringify({ ts, level, service, ...payload });
  } else {
    line = formatPretty(ts, service, level, payload);
  }

  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(line + '\n');
}

export function createLogger(service) {
  const make = (extra) => ({
    debug: (fields) => emit(service, 'debug', { ...extra, ...normalise(fields) }),
    info: (fields) => emit(service, 'info', { ...extra, ...normalise(fields) }),
    warn: (fields) => emit(service, 'warn', { ...extra, ...normalise(fields) }),
    error: (fields) => emit(service, 'error', { ...extra, ...normalise(fields) }),
    child(more) {
      return make({ ...extra, ...(more || {}) });
    },
  });
  return make({});
}
