import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createLogger } from '../../logger.js';
import { StorageError } from '../errors.js';

const log = createLogger('storage-r2');

const REQUIRED_ENV = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];

function missingEnvVars() {
  return REQUIRED_ENV.filter((name) => !process.env[name]);
}

/**
 * Build a StorageBinding backed by Cloudflare R2 (S3-compatible).
 *
 * Lazy-init: the S3 client is only constructed on first `storeFrame` call so
 * importing this module doesn't require R2 credentials. The worker decides
 * which backend to instantiate based on env at job entry.
 *
 * @returns {import('./index.js').StorageBinding}
 */
export function createR2Storage() {
  let client = null;

  function getClient() {
    if (client) return client;

    const missing = missingEnvVars();
    if (missing.length > 0) {
      throw new StorageError(`R2 credentials missing: ${missing.join(', ')}`);
    }

    client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
      forcePathStyle: false,
    });
    return client;
  }

  return {
    async storeFrame(filePath, options = {}) {
      const keyPrefix = options.keyPrefix ?? 'peakapoo';
      const timestampMs = options.timestampMs ?? 0;
      const key = `${keyPrefix}/${randomUUID()}-${timestampMs}.jpg`;

      const body = readFileSync(filePath);
      const size_bytes = body.length;

      log.info({ msg: 'r2-storage:put', key, size_bytes });

      const s3 = getClient();
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
