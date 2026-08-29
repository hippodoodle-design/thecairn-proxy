import cors from 'cors';

const DEFAULTS = [
  'https://www.thecairn.app',
  'https://thecairn.app',
  'http://localhost:5173',
];

function parseAllowlist() {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return DEFAULTS;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const allowlist = new Set(parseAllowlist());

// Vercel preview deploys of the Cairn frontend get dynamic hostnames like
// https://thecairn-<hash>-hippodoodle-designs-projects.vercel.app. The
// first-taste preview (and the speak-to-Roberta brain endpoint it calls) must
// be reachable from those, so allow that org's preview pattern in addition to
// the static allowlist. Scoped to the hippodoodle-designs org — NOT all of
// *.vercel.app — so production origins stay tight.
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+-hippodoodle-designs-projects\.vercel\.app$/;
const CAIRN_VERCEL_RE = /^https:\/\/thecairn(-[a-z0-9-]+)?\.vercel\.app$/;

function isAllowedOrigin(origin) {
  if (allowlist.has(origin)) return true;
  if (VERCEL_PREVIEW_RE.test(origin)) return true;
  if (CAIRN_VERCEL_RE.test(origin)) return true;
  return false;
}

export const corsMiddleware = cors({
  origin(origin, cb) {
    // Allow same-origin / server-to-server (no Origin header).
    if (!origin) return cb(null, true);
    if (isAllowedOrigin(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  maxAge: 600,
});
