import { mkdirSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../logger.js';

const log = createLogger('storage-stub');

/**
 * Storage binding interface. Implementations write a JPG (or other image) and
 * return the key that should be persisted alongside the rest of the record.
 *
 * @typedef {Object} StoreOptions
 * @property {string} [keyPrefix='peakapoo']
 * @property {number} [timestampMs=0]
 *
 * @typedef {Object} StorageResult
 * @property {string} key - object key (e.g. 'peakapoo/<uuid>-1234.jpg')
 * @property {number} size_bytes
 * @property {'r2'|'stub'} backend
 *
 * @typedef {Object} StorageBinding
 * @property {(filePath: string, options?: StoreOptions) => Promise<StorageResult>} storeFrame
 */

const STUB_ROOT = path.join(tmpdir(), 'cairn-storage-stub');

/**
 * Local-filesystem stub. Writes the file under <tmpdir>/cairn-storage-stub/<key>
 * and returns the same key shape the R2 backend would produce. Useful for dev
 * before R2 credentials are wired up.
 *
 * @returns {StorageBinding}
 */
export function createStubStorage() {
  return {
    async storeFrame(filePath, options = {}) {
      const keyPrefix = options.keyPrefix ?? 'peakapoo';
      const timestampMs = options.timestampMs ?? 0;
      const key = `${keyPrefix}/${randomUUID()}-${timestampMs}.jpg`;

      const dest = path.join(STUB_ROOT, key);
      mkdirSync(path.dirname(dest), { recursive: true });

      const data = readFileSync(filePath);
      writeFileSync(dest, data);
      const size_bytes = statSync(dest).size;

      log.info({ msg: 'stub-storage:wrote', key, dest, size_bytes });

      return { key, size_bytes, backend: 'stub' };
    },
  };
}

export { createR2Storage } from './r2.js';
export const STUB_STORAGE_ROOT = STUB_ROOT;
