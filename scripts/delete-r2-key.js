/**
 * Delete a single R2 object by key.
 *
 * Reuses the worker-side S3Client config (jurisdiction-aware endpoint via
 * R2_JURISDICTION) so the right account+region+endpoint are addressed.
 * Used for ad-hoc cleanup of orphan objects (e.g. frames written before a
 * downstream pipeline step failed).
 *
 * Run with worker-scoped env injected:
 *   railway run --service @cairn/worker -- node scripts/delete-r2-key.js <key>
 *
 * Reports the DeleteObject httpStatusCode (R2 returns 204 on success
 * regardless of whether the key existed). For a stronger assertion, HEAD the
 * key before + after via scripts/verify-r2-keys.js.
 */

import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';

const key = process.argv[2];
if (!key) {
  console.error('Usage: node scripts/delete-r2-key.js <key>');
  process.exit(1);
}

const REQUIRED = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`MISSING_ENV: ${missing.join(', ')}`);
  process.exit(1);
}

const j = (process.env.R2_JURISDICTION || '').trim().toLowerCase();
const sub = j === 'eu' ? '.eu' : (j === 'fedramp' ? '.fedramp' : '');
const endpoint = `https://${process.env.R2_ACCOUNT_ID}${sub}.r2.cloudflarestorage.com`;

const s3 = new S3Client({
  region: 'auto',
  endpoint,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: false,
});

console.log(`endpoint=${endpoint}`);
console.log(`bucket=${process.env.R2_BUCKET}`);
console.log(`key=${key}`);
console.log('');

try {
  const res = await s3.send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
  }));
  console.log(`DeleteObject httpStatusCode=${res.$metadata?.httpStatusCode ?? '(none)'}`);
  console.log(`requestId=${res.$metadata?.requestId ?? '(none)'}`);
  process.exit(0);
} catch (err) {
  console.log('FAILED');
  console.log(`  err.name                       = ${err?.name}`);
  console.log(`  err.Code                       = ${err?.Code}`);
  console.log(`  err.message                    = ${err?.message}`);
  console.log(`  err.$metadata?.httpStatusCode  = ${err?.$metadata?.httpStatusCode}`);
  process.exit(1);
}
