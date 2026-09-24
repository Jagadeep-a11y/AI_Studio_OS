import path from 'node:path';
import { newId } from './db.js';
import { ProviderError } from './providers/util.js';

/**
 * File metadata and where the bytes go.
 *
 * Two jobs, one place:
 *   1. Attachments the user uploads as reference material for a generation.
 *   2. Outputs a model produces (images), stored out of the database so
 *      `asset_url` stays a short pointer instead of a megabyte of base64 in
 *      every row.
 *
 * Metadata lives in SQLite; bytes live in whichever storage driver is
 * configured (`data/uploads/` by default, or any S3-compatible bucket). Rows
 * record the driver and key they were written with, so switching providers
 * leaves earlier files readable. Nothing here knows how a driver works — it
 * calls `put`, `get`, and `remove`.
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB per file
export const MAX_FILES_PER_REQUEST = 8;
export const MAX_TEXT_EXCERPT = 4_000;

const ALLOWED_MIME = [
  /^image\/(png|jpe?g|webp|gif|avif|svg\+xml)$/i,
  /^text\/[a-z0-9.+-]+$/i,
  /^application\/(json|pdf|xml|zip|rtf)$/i,
  /^application\/vnd\.openxmlformats-officedocument\..+$/i,
];

const EXTENSIONS = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
  'image/avif': '.avif', 'image/svg+xml': '.svg', 'text/plain': '.txt', 'text/markdown': '.md',
  'text/csv': '.csv', 'application/json': '.json', 'application/pdf': '.pdf', 'application/zip': '.zip',
};

const isTextual = (mime) => /^text\//i.test(mime) || ['application/json', 'application/xml', 'application/x-ndjson'].includes(mime);

export const humanSize = (bytes) => {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

// --- multipart/form-data ----------------------------------------------------

/**
 * Minimal multipart parser. Enough for browser file uploads (which is all this
 * endpoint accepts) without pulling in a dependency: boundaries, headers, and
 * bodies, with no attempt at the exotic corners of RFC 7578.
 */
export function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  const boundary = (match?.[1] || match?.[2] || '').trim();
  if (!boundary) throw new ProviderError('Upload is missing a multipart boundary', { status: 400, code: 'invalid_multipart' });

  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = buffer.indexOf(delimiter);
  if (cursor === -1) throw new ProviderError('Upload body does not match its boundary', { status: 400, code: 'invalid_multipart' });

  while (cursor !== -1) {
    let start = cursor + delimiter.length;
    if (buffer.slice(start, start + 2).toString() === '--') break; // closing delimiter
    if (buffer.slice(start, start + 2).toString() === '\r\n') start += 2;

    const headerEnd = buffer.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;
    const rawHeaders = buffer.slice(start, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    const next = buffer.indexOf(delimiter, bodyStart);
    const bodyEnd = next === -1 ? buffer.length : next - 2; // strip the CRLF before the delimiter
    const body = buffer.slice(bodyStart, Math.max(bodyStart, bodyEnd));

    const disposition = /content-disposition:[^\n]*/i.exec(rawHeaders)?.[0] || '';
    const name = /name="([^"]*)"/i.exec(disposition)?.[1] || '';
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1] || '';
    const type = (/content-type:\s*([^\s;]+)/i.exec(rawHeaders)?.[1] || '').trim();

    if (name || filename) parts.push({ name, filename, type, data: body });
    cursor = next === -1 ? -1 : next;
  }

  return parts;
}

/** Strips directory components and control characters from a client filename. */
export function safeName(filename) {
  const base = path.basename(String(filename || 'upload'));
  return base.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '').trim().slice(0, 120) || 'upload';
}

// --- storage ----------------------------------------------------------------

export function createFileStore({ storage }) {
  if (!storage) throw new ProviderError('The file store needs a storage driver', { status: 500, code: 'storage_misconfigured' });

  /**
   * Rows reach this module in two shapes — the API shape from `fileFromRow`
   * (`storageKey`, `storageDriver`) and the raw database row
   * (`storage_key`, `storage_driver`) — so both are read here rather than at
   * every call site.
   */
  const driverOf = (row) => row?.storageDriver || row?.storage_driver || 'local';
  const keyOf = (row) => row?.storageKey || row?.storage_key || row?.path || '';
  const driverFor = (row) => storage.for(driverOf(row));

  /** A file store bound to one workspace's data layer. */
  function forWorkspace(store) {
    return {
      write: (file) => write(store, file),
      writeDataUrl: (input) => writeDataUrl(store, input),
      read: (row) => read(row),
      remove: (id) => remove(store, id),
      /** A short-lived direct URL, when the driver can make one and it is enabled. */
      presignedFor: (row) => storage.url(keyOf(row), { driver: driverOf(row) }),
    };
  }

  async function write(store, { name, mime, buffer, kind = 'attachment', projectId = null, generationId = null, excerpt = '' }) {
    if (!buffer?.length) throw new ProviderError('The file is empty', { status: 400, code: 'empty_file' });
    if (buffer.length > MAX_FILE_BYTES) {
      throw new ProviderError(`${safeName(name)} is larger than ${humanSize(MAX_FILE_BYTES)}`, { status: 413, code: 'file_too_large' });
    }
    const safeMime = mime && ALLOWED_MIME.some((pattern) => pattern.test(mime)) ? mime : 'application/octet-stream';
    if (safeMime === 'application/octet-stream') {
      throw new ProviderError(`“${safeName(name)}” is not a file type this studio accepts`, {
        status: 415,
        code: 'unsupported_media_type',
        hint: 'Images, PDFs, text, Markdown, CSV, JSON, and office documents are supported.',
      });
    }

    const id = newId('f');
    const extension = EXTENSIONS[safeMime] || path.extname(safeName(name)).toLowerCase() || '';
    // The id is generated here, so the key can be derived from it — which keeps
    // objects addressable and collision-free before the row exists.
    const key = storage.keyFor({ workspaceId: store.workspaceId, id, extension });
    await storage.put({ key, body: buffer, contentType: safeMime });

    const text = excerpt || (isTextual(safeMime) ? buffer.toString('utf8').slice(0, MAX_TEXT_EXCERPT) : '');
    try {
      return store.createFile({
        id,
        name: safeName(name),
        mime: safeMime,
        size: buffer.length,
        kind,
        excerpt: text,
        projectId,
        generationId,
        storageDriver: storage.kind,
        storageKey: key,
      });
    } catch (error) {
      // A row that cannot be written must not leave its bytes behind.
      await storage.remove(key).catch(() => {});
      throw error;
    }
  }

  /** Stores a generation output (a data URL) as a real object. */
  async function writeDataUrl(store, { dataUrl, name = 'output', projectId = null, generationId = null }) {
    const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(String(dataUrl || ''));
    if (!match) return null;
    const mime = match[1].toLowerCase();
    const payload = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8');
    const extension = EXTENSIONS[mime] || '.bin';
    try {
      return await write(store, { name: `${name}${extension}`, mime, buffer: payload, kind: 'output', projectId, generationId });
    } catch (error) {
      // A generated asset that cannot be stored must not lose the generation.
      console.warn('Could not persist generated asset:', error.message);
      return null;
    }
  }

  /** Reads a row's bytes from whichever driver holds them. */
  async function read(row) {
    const key = keyOf(row);
    if (!key) throw new ProviderError('That file has no stored location', { status: 500, code: 'file_unreadable' });
    return driverFor(row).get(key);
  }

  async function remove(store, id) {
    const row = store.getFileRow?.(id) || store.getFile(id);
    if (!row) return false;
    const key = keyOf(row);
    // The row goes first: an orphaned object is cheaper than a row pointing at
    // nothing, and a failed delete would otherwise strand a file the user
    // believes they removed.
    store.deleteFile(id);
    await driverFor(row).remove(key).catch((error) => {
      console.warn(`Could not remove ${key} from storage:`, error.message);
    });
    return true;
  }

  /** True when the row's driver is available (used by the storage diagnostics). */
  const driverAvailable = (name) => Boolean(storage.drivers[name || 'local']);

  return {
    forWorkspace,
    /** Reads a row that is already known to belong to the caller's workspace. */
    read,
    driverFor,
    driverAvailable,
    /**
     * Deletes every object a workspace owns. Called before the workspace row is
     * removed, because the rows that name the objects go with it.
     */
    async purgeWorkspace(store) {
      const rows = store.listFiles({ limit: 10_000 });
      let removed = 0;
      const failed = [];
      for (const row of rows) {
        const key = keyOf(row);
        try {
          if (driverAvailable(driverOf(row))) await storage.for(driverOf(row)).remove(key);
          removed += 1;
        } catch (error) {
          failed.push(`${key}: ${error.message}`);
        }
      }
      return { removed, failed, bytes: rows.reduce((total, row) => total + (row.size || 0), 0) };
    },
    /** Bytes and object counts for a workspace: rows in, totals out. */
    statsFor(store) {
      const rows = store.listFiles({ limit: 10_000 });
      return { count: rows.length, bytes: rows.reduce((total, row) => total + (row.size || 0), 0) };
    },
    describe: () => storage.describe(),
    check: () => storage.check(),
  };
}

// --- preparing attachments for a generation ---------------------------------

/**
 * Turns stored attachments into the shape providers expect: images as data
 * URLs, documents as text the prompt can quote.
 */
export async function buildAttachments(scopedFiles, rows, { maxImages = 4, maxTextChars = 12_000 } = {}) {
  const attachments = [];
  let textBudget = maxTextChars;
  let images = 0;

  for (const row of rows) {
    if (row.isImage) {
      if (images >= maxImages) continue;
      images += 1;
      const data = await scopedFiles.read(row);
      attachments.push({ id: row.id, name: row.name, mime: row.mime, kind: 'image', dataUrl: `data:${row.mime};base64,${data.toString('base64')}`, bytes: row.size });
      continue;
    }
    const text = (row.excerpt || '').trim();
    if (!text || textBudget <= 0) {
      attachments.push({ id: row.id, name: row.name, mime: row.mime, kind: 'binary', bytes: row.size });
      continue;
    }
    const slice = text.slice(0, Math.min(textBudget, 4_000));
    textBudget -= slice.length;
    attachments.push({ id: row.id, name: row.name, mime: row.mime, kind: 'text', text: slice, bytes: row.size });
  }

  return attachments;
}

/** Appends reference documents to a prompt in a way models handle well. */
export function withTextReferences(prompt, attachments = []) {
  const documents = attachments.filter((item) => item.kind === 'text' && item.text);
  if (!documents.length) return prompt;
  const blocks = documents.map((item) => `--- ${item.name} ---\n${item.text}`).join('\n\n');
  return `${prompt}\n\nReference material provided by the user:\n\n${blocks}`;
}

export const imageAttachments = (attachments = []) => attachments.filter((item) => item.kind === 'image' && item.dataUrl);
