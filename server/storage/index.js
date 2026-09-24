import { ProviderError } from '../providers/util.js';
import { createLocalStorage } from './local.js';
import { createS3Storage } from './s3.js';

/**
 * Storage drivers.
 *
 * One configured driver writes new objects; every driver that has credentials
 * stays readable. That is what makes switching providers safe: rows remember
 * which driver holds their bytes (`files.storage_driver`), so objects written
 * before the switch are still served after it — the alternative would be a
 * migration that silently breaks every existing file.
 *
 * `local` is always available (it is where the app has always put things);
 * `s3` exists whenever its credentials are configured, whether or not it is the
 * active driver.
 */
export function createStorage({ storage = {}, logger = console } = {}) {
  const local = createLocalStorage({ uploadDir: storage.uploadsDir, logger });
  const drivers = { local };

  let s3 = null;
  if (storage.s3) {
    s3 = createS3Storage({ ...storage.s3, logger });
    drivers.s3 = s3;
  }

  const driverName = storage.driver === 's3' ? 's3' : 'local';
  if (driverName === 's3' && !s3) {
    throw new ProviderError('AI_STUDIO_STORAGE=s3 needs bucket and credentials', {
      status: 500,
      code: 'storage_misconfigured',
      hint: 'Set AI_STUDIO_S3_BUCKET, AI_STUDIO_S3_ACCESS_KEY and AI_STUDIO_S3_SECRET_KEY (see .env.example).',
    });
  }

  const active = drivers[driverName];

  /** The driver that holds a row's bytes, or a clear error if it is gone. */
  function forRow(driver) {
    const name = driver || 'local';
    const found = drivers[name];
    if (!found) {
      throw new ProviderError(`This file was stored with the ${name} driver, which is no longer configured`, {
        status: 409,
        code: 'storage_driver_unavailable',
        hint: name === 's3'
          ? 'Re-add the S3 credentials in .env to read files that were uploaded while S3 was active.'
          : 'Re-enable local storage in .env to read files from the uploads directory.',
      });
    }
    return found;
  }

  return {
    kind: active.kind,
    label: active.label,
    active,
    drivers,
    for: forRow,

    /** New objects use the configured driver's key layout. */
    keyFor(input) {
      return active.keyFor(input);
    },

    put: (input) => active.put(input),
    get: (key, { driver = active.kind } = {}) => forRow(driver).get(key),
    exists: (key, { driver = active.kind } = {}) => forRow(driver).exists(key),
    remove: (key, { driver = active.kind } = {}) => forRow(driver).remove(key),

    /**
     * A direct URL for an object, when the driver can produce one and the
     * operator has opted into redirects. Null means "stream it through the API".
     */
    url(key, { driver = active.kind, ttlMs } = {}) {
      if (!storage.redirect) return null;
      return forRow(driver).url(key, { ttlMs }) || null;
    },

    describe() {
      return {
        driver: active.kind,
        label: active.label,
        redirects: Boolean(storage.redirect),
        drivers: Object.values(drivers).map((driver) => driver.describe()),
      };
    },

    /** Writes, reads, and deletes a probe object with the active driver. */
    async check() {
      const result = await active.check();
      return { ...result, driver: active.kind, ...active.describe() };
    },
  };
}
