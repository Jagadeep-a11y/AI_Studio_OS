import crypto from 'node:crypto';

/**
 * AWS Signature Version 4, the signing scheme every S3-compatible service uses
 * (AWS S3, Cloudflare R2, MinIO, Backblaze B2, DigitalOcean Spaces, Wasabi…).
 *
 * Written out rather than pulled in as a dependency, for the same reason the
 * rest of this project has none. Kept as pure functions so the client and the
 * test server can share exactly one implementation of the canonical request —
 * a signature bug then shows up as a mismatch over the wire instead of agreeing
 * with itself.
 *
 * Reference: "Authenticating Requests (AWS Signature Version 4)".
 */

export const ALGORITHM = 'AWS4-HMAC-SHA256';

export const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
export const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/**
 * RFC 3986 encoding. `encodeURIComponent` leaves `!'()*` alone, which S3 does
 * not, and path segments keep their slashes while the query never does.
 */
export const uriEncode = (value, encodeSlash = true) => String(value)
  .split('')
  .map((char) => {
    if (/[A-Za-z0-9_.~-]/.test(char)) return char;
    if (char === '/') return encodeSlash ? '%2F' : '/';
    return `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
  })
  .join('');

/** `2026-09-24T07:12:00.000Z` → `{ amzDate: '20260924T071200Z', dateStamp: '20260924' }` */
export function amzDates(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

/** Sorted `k=v` pairs, both sides encoded, as S3 expects. */
export function canonicalQueryString(query = {}) {
  return Object.keys(query)
    .filter((key) => query[key] !== undefined && query[key] !== null)
    .sort()
    .map((key) => `${uriEncode(key, false)}=${uriEncode(query[key], false)}`)
    .join('&');
}

/** Lowercased names, trimmed values, sorted, each terminated with a newline. */
export function canonicalHeaders(headers = {}) {
  return Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort()
    .map((name) => `${name}:${String(headers[name] ?? '').trim().replace(/\s+/g, ' ')}\n`)
    .join('');
}

export const signedHeaderList = (headers = {}) => Object.keys(headers).map((name) => name.toLowerCase()).sort().join(';');

export function canonicalRequest({ method, path, query = {}, headers = {}, payloadHash }) {
  return [
    String(method || 'GET').toUpperCase(),
    path.startsWith('/') ? path : `/${path}`,
    canonicalQueryString(query),
    canonicalHeaders(headers),
    signedHeaderList(headers),
    payloadHash,
  ].join('\n');
}

export function signingKey(secretAccessKey, dateStamp, region, service = 's3') {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

export function stringToSign({ amzDate, scope, canonical }) {
  return [ALGORITHM, amzDate, scope, sha256Hex(canonical)].join('\n');
}

/**
 * Signs a request. Returns the values the caller must put on the wire: the
 * `Authorization` header for header-auth, and `query` extended with the signature
 * for a presigned URL.
 */
export function signRequest({ method, path, query = {}, headers = {}, payloadHash, credentials, date = new Date(), service = 's3' }) {
  const { amzDate, dateStamp } = amzDates(date);
  const scope = `${dateStamp}/${credentials.region}/${service}/aws4_request`;
  const canonical = canonicalRequest({ method, path, query, headers, payloadHash });
  const signature = hmac(signingKey(credentials.secretAccessKey, dateStamp, credentials.region, service),
    stringToSign({ amzDate, scope, canonical })).toString('hex');
  return { signature, scope, amzDate, dateStamp, canonical };
}

/** The presign query parameters, in the order they are added. */
export function presignQuery({ credentials, expiresSeconds, date = new Date(), service = 's3' }) {
  const { amzDate, dateStamp } = amzDates(date);
  const scope = `${dateStamp}/${credentials.region}/${service}/aws4_request`;
  return {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresSeconds),
    'X-Amz-SignedHeaders': 'host',
    ...(credentials.sessionToken ? { 'X-Amz-Security-Token': credentials.sessionToken } : {}),
  };
}
