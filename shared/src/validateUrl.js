import dns from 'node:dns/promises';
import net from 'node:net';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * True if an IPv4 address is in a private/loopback/link-local/CGNAT/reserved range.
 */
function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;

  if (a === 10) return true;                                  // 10.0.0.0/8
  if (a === 127) return true;                                 // loopback
  if (a === 0) return true;                                   // 0.0.0.0/8
  if (a === 169 && b === 254) return true;                    // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16/12
  if (a === 192 && b === 168) return true;                    // 192.168/16
  if (a === 192 && b === 0 && parts[2] === 0) return true;    // 192.0.0.0/24
  if (a === 192 && b === 0 && parts[2] === 2) return true;    // TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true;       // benchmarking
  if (a === 198 && b === 51 && parts[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return true;  // TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT
  if (a >= 224) return true;                                  // multicast + reserved
  return false;
}

/**
 * True if an IPv6 address is loopback, link-local, ULA, or otherwise reserved.
 */
function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fe80::')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;        // ULA fc00::/7
  if (lower.startsWith('ff')) return true;                                  // multicast
  // IPv4-mapped (::ffff:a.b.c.d) — evaluate the inner IPv4
  const mapped = lower.match(/^::ffff:([0-9.]+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

/**
 * Validate a URL for safe outbound fetch (SSRF-guarded).
 * - Protocol must be http or https
 * - Hostname must resolve to a non-private, non-loopback, non-link-local address
 * - All resolved addresses are checked (defense against DNS-rebinding with multi-answer A records)
 *
 * Returns { ok: true, url, host, addresses } or { ok: false, error }.
 */
export async function validateUrl(input) {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, error: 'URL is required' };
  }
  if (input.length > 2048) {
    return { ok: false, error: 'URL is too long' };
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, error: 'URL is not valid' };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, error: 'Only http and https URLs are allowed' };
  }

  const hostname = parsed.hostname;
  if (!hostname) return { ok: false, error: 'URL has no host' };

  // Literal IP in hostname — check directly, no DNS lookup.
  const literal = net.isIP(hostname);
  if (literal === 4) {
    if (isPrivateIPv4(hostname)) return { ok: false, error: 'URL points to a private network' };
    return { ok: true, url: parsed, host: hostname, addresses: [hostname] };
  }
  if (literal === 6) {
    const stripped = hostname.replace(/^\[|\]$/g, '');
    if (isPrivateIPv6(stripped)) return { ok: false, error: 'URL points to a private network' };
    return { ok: true, url: parsed, host: hostname, addresses: [stripped] };
  }

  // Refuse obviously-local hostnames without a DNS round trip.
  const lowerHost = hostname.toLowerCase();
  if (
    lowerHost === 'localhost' ||
    lowerHost.endsWith('.localhost') ||
    lowerHost.endsWith('.local') ||
    lowerHost.endsWith('.internal')
  ) {
    return { ok: false, error: 'URL points to a private network' };
  }

  let answers;
  try {
    answers = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return { ok: false, error: 'URL host could not be resolved' };
  }

  if (!answers || answers.length === 0) {
    return { ok: false, error: 'URL host could not be resolved' };
  }

  for (const { address, family } of answers) {
    if (family === 4 && isPrivateIPv4(address)) {
      return { ok: false, error: 'URL points to a private network' };
    }
    if (family === 6 && isPrivateIPv6(address)) {
      return { ok: false, error: 'URL points to a private network' };
    }
  }

  return {
    ok: true,
    url: parsed,
    host: hostname,
    addresses: answers.map((a) => a.address),
  };
}
