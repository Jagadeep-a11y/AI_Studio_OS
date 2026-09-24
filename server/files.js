import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { newId } from './db.js';
import { ProviderError } from './providers/util.js';

/**
 * File storage.
 *
 * Two jobs, one place:
 *   1. Attachments the user uploads as reference material for a generation.
 *   2. Outputs a model produces (images), written out of the database and onto
 *      disk, so `asset_url` stays a short pointer instead of a megabyte of
 *      base64 in every row.
 *
 * Bytes live under `data/uploads/` and metadata lives in SQLite, which keeps the
 * database small and makes the files trivially replaceable by object storage
 * later — only this module would change.
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

export function createFileStore({ db, store, uploadDir }) {
  fs.mkdirSync(uploadDir, { recursive: true });

  const absolutePath = (row) => {
    const stored = row?.storedPath || row?.path;
    if (!stored) throw new ProviderError('That file has no stored location', { status: 500, code: 'file_unreadable' });
    return path.join(uploadDir, path.basename(stored));
  };

  function write({ name, mime, buffer, kind = 'attachment', projectId = null, generationId = null, excerpt = '' }) {
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
    const stored = `${id}${extension.replace(/[^a-z0-9.]/gi, '')}`;
    fs.writeFileSync(path.join(uploadDir, stored), buffer);

    const text = excerpt || (isTextual(safeMime) ? buffer.toString('utf8').slice(0, MAX_TEXT_EXCERPT) : '');
    return store.createFile({
      id,
      name: safeName(name),
      mime: safeMime,
      size: buffer.length,
      path: stored,
      kind,
      excerpt: text,
      projectId,
      generationId,
    });
  }

  /** Stores a generation output (a data URL) as a real file on disk. */
  function writeDataUrl({ dataUrl, name = 'output', projectId = null, generationId = null }) {
    const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(String(dataUrl || ''));
    if (!match) return null;
    const mime = match[1].toLowerCase();
    const payload = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8');
    const extension = EXTENSIONS[mime] || '.bin';
    try {
      return write({ name: `${name}${extension}`, mime, buffer: payload, kind: 'output', projectId, generationId });
    } catch (error) {
      // A generated asset that cannot be stored must not lose the generation.
      console.warn('Could not persist generated asset:', error.message);
      return null;
    }
  }

  return {
    write,
    writeDataUrl,
    readLink(row) {
      return absolutePath(row);
    },
    async read(row) {
      try {
        return await fsp.readFile(absolutePath(row));
      } catch {
        throw new ProviderError('That file is no longer on disk', { status: 404, code: 'file_missing' });
      }
    },
    remove(id) {
      const row = store.getFile(id) || store.getFileRow?.(id);
      if (!row) return false;
      try {
        fs.rmSync(absolutePath(row), { force: true });
      } catch (error) {
        console.warn('Could not remove file from disk:', error.message);
      }
      store.deleteFile(id);
      return true;
    },
    /** Used by the tests and by `npm run clean` style tooling. */
    stats() {
      const rows = store.listFiles({ limit: 1000 });
      return { count: rows.length, bytes: rows.reduce((total, row) => total + (row.size || 0), 0) };
    },
  };
}

// --- preparing attachments for a generation ---------------------------------

/**
 * Turns stored attachments into the shape providers expect: images as data
 * URLs, documents as text the prompt can quote.
 */
export async function buildAttachments(fileStore, rows, { maxImages = 4, maxTextChars = 12_000 } = {}) {
  const attachments = [];
  let textBudget = maxTextChars;
  let images = 0;

  for (const row of rows) {
    if (row.isImage) {
      if (images >= maxImages) continue;
      images += 1;
      const data = await fileStore.read(row);
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
