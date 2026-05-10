/**
 * HEAD a list of R2 keys to confirm they exist in the bucket.
 * Reuses worker-side S3Client config (jurisdiction-aware endpoint).
 *
 * Run with worker-scoped env injected:
 *   railway run --service @cairn/worker -- node scripts/verify-r2-keys.js <key1> [<key2> ...]
 */

import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';

const keys = process.argv.slice(2);
if (keys.length === 0) {
  console.error('Usage: node scripts/verify-r2-keys.js <key1> [<key2> ...]');
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
console.log('');

for (const key of keys) {
  try {
    const r = await s3.send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
    console.log(`OK 200  ${key}`);
    console.log(`        contentLength=${r.ContentLength} contentType=${r.ContentType}`);
    console.log(`        lastModified=${r.LastModified?.toISOString()} etag=${r.ETag}`);
  } catch (e) {
    console.log(`ERR     ${key}`);
    console.log(`        httpStatus=${e?.$metadata?.httpStatusCode} name=${e?.name}`);
  }
}
