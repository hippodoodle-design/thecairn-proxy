import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createLogger } from '../../logger.js';
import { StorageError } from '../errors.js';

const log = createLogger('storage-r2');

const REQUIRED_ENV = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];

function missingEnvVars() {
  return REQUIRED_ENV.filter((name) => !process.env[name]);
}

// Memoised at module scope so write (storeFrame) and read (signR2Url) paths
// share a single S3 client. Lazy-init: importing this module does not require
// R2 credentials; the client is constructed on first use.
let _client = null;

function getR2Client() {
  if (_client) return _client;

  const missing = missingEnvVars();
  if (missing.length > 0) {
    throw new StorageError(`R2 credentials missing: ${missing.join(', ')}`);
  }

  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: false,
  });
  return _client;
}

/**
 * Build a StorageBinding backed by Cloudflare R2 (S3-compatible).
 *
 * @returns {import('./index.js').StorageBinding}
 */
export function createR2Storage() {
  return {
    async storeFrame(filePath, options = {}) {
      const keyPrefix = options.keyPrefix ?? 'peakapoo';
      const timestampMs = options.timestampMs ?? 0;
      const key = `${keyPrefix}/${randomUUID()}-${timestampMs}.jpg`;

      const body = readFileSync(filePath);
      const size_bytes = body.length;

      log.info({ msg: 'r2-storage:put', key, size_bytes });

      const s3 = getR2Client();
      try {
        await s3.send(new PutObjectCommand({
          Bucket: process.env.R2_BUCKET,
          Key: key,
          Body: body,
          ContentType: 'image/jpeg',
        }));
      } catch (err) {
        const status = err?.$metadata?.httpStatusCode;
        if (status === 401 || status === 403) {
          throw new StorageError('R2 credentials rejected', { cause: err });
        }
        if (status === 404) {
          throw new StorageError('R2 bucket not found', { cause: err });
        }
        throw new StorageError(err?.message || String(err), { cause: err });
      }

      log.info({ msg: 'r2-storage:done', key, size_bytes });

      return { key, size_bytes, backend: 'r2' };
    },
  };
}

/**
 * Sign an R2 object key for read access. Uses GetObject presigning against
 * the same bucket/credentials the writer uses. The returned URL is opaque
 * and time-limited; caller is responsible for not echoing it past `ttlSeconds`.
 *
 * @param {string} key - R2 object key (e.g. 'peakapoo/<uuid>-1234.jpg')
 * @param {number} [ttlSeconds=21600] - URL lifetime; default 6 hours
 * @returns {Promise<string>} signed URL
 */
export async function signR2Url(key, ttlSeconds = 21600) {
  const s3 = getR2Client();
  const cmd = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
  });
  return getSignedUrl(s3, cmd, { expiresIn: ttlSeconds });
}
