import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ProviderError } from '../providers/util.js';

/**
 * The disk file store: bytes live in `data/uploads/` (or wherever
 * `AI_STUDIO_UPLOADS` points), metadata lives in SQLite.
 *
 * Keys are plain filenames, and every key is reduced to its basename before it
 * touches the filesystem — a key is data that came out of the database, so it
 * must not be able to walk out of the uploads directory.
 */
export function createLocalStorage({ uploadDir, logger = console } = {}) {
  if (!uploadDir) throw new ProviderError('Local storage needs an upload directory', { status: 500, code: 'storage_misconfigured' });
  fs.mkdirSync(uploadDir, { recursive: true });

  const fileFor = (key) => path.join(uploadDir, path.basename(String(key || '')));

  return {
    kind: 'local',
    label: 'Local disk',

    /** Disk keys stay flat: the uploads directory is already per-instance. */
    keyFor({ id, extension = '' }) {
      return `${id}${String(extension || '').replace(/[^a-z0-9.]/gi, '')}`;
    },

    async put({ key, body }) {
      await fsp.writeFile(fileFor(key), body);
      return { key, bytes: body.length };
    },

    async get(key) {
      try {
        return await fsp.readFile(fileFor(key));
      } catch {
        throw new ProviderError('That file is no longer on disk', { status: 404, code: 'file_missing' });
      }
    },

    async exists(key) {
      try {
        await fsp.access(fileFor(key));
        return true;
      } catch {
        return false;
      }
    },

    async remove(key) {
      try {
        await fsp.rm(fileFor(key), { force: true });
        return true;
      } catch (error) {
        logger.warn?.('Could not remove file from disk:', error.message);
        return false;
      }
    },

    /** Local files have no signed URL to hand out; they are always proxied. */
    url() {
      return null;
    },

    describe() {
      return { driver: 'local', directory: uploadDir, readable: true };
    },

    async check() {
      const key = `_healthcheck-${Date.now().toString(36)}.txt`;
      const body = Buffer.from(`studio storage probe ${new Date().toISOString()}\n`, 'utf8');
      await this.put({ key, body });
      const read = await this.get(key);
      await this.remove(key);
      return { ok: read.equals(body), bytes: read.length };
    },
  };
}
