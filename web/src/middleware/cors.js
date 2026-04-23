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

export const corsMiddleware = cors({
  origin(origin, cb) {
    // Allow same-origin / server-to-server (no Origin header).
    if (!origin) return cb(null, true);
    if (allowlist.has(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type'],
  maxAge: 600,
});
