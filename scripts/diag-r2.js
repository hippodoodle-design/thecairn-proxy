/**
 * R2 credentials diagnostic.
 *
 * Sends a real PutObject (then DeleteObject on success) against R2 using the
 * same S3Client config the worker's storage binding uses, including
 * jurisdiction-aware endpoint selection (R2_JURISDICTION). Surfaces the raw
 * AWS SDK error fields so we can tell which of {InvalidAccessKeyId,
 * SignatureDoesNotMatch, AccessDenied, NoSuchBucket} we're hitting.
 *
 * Run with worker-scoped env injected:
 *   railway run --service @cairn/worker -- node scripts/diag-r2.js
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const REQUIRED = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`MISSING_ENV: ${missing.join(', ')}`);
  process.exit(1);
}

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET;
const jurisdictionRaw = process.env.R2_JURISDICTION || '';

// Mirror the worker's resolveR2Endpoint logic (shared/src/media-pipeline/storage/r2.js).
function resolveR2Endpoint(acct) {
  const j = jurisdictionRaw.trim().toLowerCase();
  if (j === 'eu')      return `https://${acct}.eu.r2.cloudflarestorage.com`;
  if (j === 'fedramp') return `https://${acct}.fedramp.r2.cloudflarestorage.com`;
  return `https://${acct}.r2.cloudflarestorage.com`;
}
const endpoint = resolveR2Endpoint(accountId);

console.log('--- env sanity (no secrets) ---');
console.log(`R2_BUCKET                = ${bucket}`);
console.log(`R2_ACCOUNT_ID            prefix=${accountId.slice(0, 8)} length=${accountId.length}`);
console.log(`R2_ACCESS_KEY_ID         prefix=${accessKeyId.slice(0, 4)} length=${accessKeyId.length}`);
console.log(`R2_SECRET_ACCESS_KEY     length=${secretAccessKey.length}`);
console.log(`R2_JURISDICTION          ${jurisdictionRaw === '' ? '(unset → default endpoint)' : jurisdictionRaw}`);
console.log(`endpoint (resolved)      ${endpoint}`);
console.log('');

const client = new S3Client({
  region: 'auto',
  endpoint,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: false,
});

const key = `diagnostic/r2-test-${Date.now()}.txt`;

console.log(`--- PutObject ---`);
console.log(`bucket=${bucket} key=${key}`);

try {
  const putRes = await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: 'r2-credential-test',
    ContentType: 'text/plain',
  }));
  console.log('SUCCESS');
  console.log(`  ETag=${putRes.ETag ?? '(none)'}`);
  console.log(`  $metadata.httpStatusCode=${putRes.$metadata?.httpStatusCode ?? '(none)'}`);
  console.log(`  $metadata.requestId=${putRes.$metadata?.requestId ?? '(none)'}`);

  // Cleanup
  console.log(`--- DeleteObject (cleanup) ---`);
  try {
    const delRes = await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    console.log(`  delete httpStatusCode=${delRes.$metadata?.httpStatusCode ?? '(none)'}`);
  } catch (delErr) {
    console.log(`  cleanup failed (test object remains): ${delErr?.name}: ${delErr?.message}`);
  }
  process.exit(0);
} catch (err) {
  console.log('FAILED');
  console.log(`  err.name                       = ${err?.name}`);
  console.log(`  err.Code                       = ${err?.Code}`);
  console.log(`  err.code                       = ${err?.code}`);
  console.log(`  err.message                    = ${err?.message}`);
  console.log(`  err.$metadata?.httpStatusCode  = ${err?.$metadata?.httpStatusCode}`);
  console.log(`  err.$metadata?.requestId       = ${err?.$metadata?.requestId}`);
  console.log(`  err.$metadata?.cfId            = ${err?.$metadata?.cfId}`);
  console.log(`  err.$metadata?.attempts        = ${err?.$metadata?.attempts}`);
  if (err?.cause) {
    console.log(`  err.cause.name                 = ${err.cause?.name}`);
    console.log(`  err.cause.message              = ${err.cause?.message}`);
  }
  process.exit(1);
}
