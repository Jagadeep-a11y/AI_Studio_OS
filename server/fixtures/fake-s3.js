import http from 'node:http';
import {
  ALGORITHM,
  canonicalQueryString,
  canonicalRequest,
  hmac,
  sha256Hex,
  signingKey,
} from '../storage/sigv4.js';

/**
 * A tiny S3-compatible server for tests.
 *
 * It implements the four operations the studio uses (PUT, GET, HEAD, DELETE),
 * **verifies the SigV4 signature on every request** by rebuilding the canonical
 * request from what actually arrived on the wire, and supports presigned GETs.
 * That is the point: a signing bug in the client cannot pass, because this
 * server recomputes the signature the way a real one does and answers
 * `SignatureDoesNotMatch` if it disagrees.
 *
 * Objects live in memory. `objects` is exposed for assertions.
 */

export function createFakeS3({ accessKeyId = 'test-key', secretAccessKey = 'test-secret', sessionToken = '' } = {}) {
  const objects = new Map(); // bucket/key → { body, contentType, modified }
  let requests = 0;
  let lastCanonical = null;
  const failures = [];

  const keyFor = (bucket, key) => `${bucket}/${key}`;

  function respond(res, status, body, headers = {}) {
    res.writeHead(status, { 'x-amz-request-id': `fake-${Date.now().toString(36)}`, ...headers });
    res.end(body);
  }

  const xmlError = (res, code, message, status = 403) => {
    failures.push(`${code}: ${message}`);
    respond(res, status, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`, {
      'content-type': 'application/xml',
    });
  };

  /** Rebuilds the canonical request from the incoming request and checks it. */
  function verify(req, url, body) {
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith(ALGORITHM)) return { ok: false, code: 'AccessDenied', message: 'Missing SigV4 Authorization header' };

    const fields = Object.fromEntries(auth.slice(ALGORITHM.length).trim().split(',').map((part) => {
      const [name, ...rest] = part.trim().split('=');
      return [name, rest.join('=')];
    }));
    // Credential is <key-id>/<date>/<region>/<service>/aws4_request. The string
    // to sign uses the scope *without* the key id, so the two must be kept apart.
    const credential = fields.Credential || '';
    const [keyId, dateStamp, region, service, terminator] = credential.split('/');
    if (terminator !== 'aws4_request') return { ok: false, code: 'AuthorizationHeaderMalformed', message: `Scope must end in aws4_request, got "${terminator}"` };
    const scope = [dateStamp, region, service, terminator].join('/');
    if (keyId !== accessKeyId) return { ok: false, code: 'InvalidAccessKeyId', message: `Unknown key ${keyId}` };
    if (service !== 's3' || !region) return { ok: false, code: 'AuthorizationHeaderMalformed', message: 'Scope must be a valid s3 scope' };

    const signedNames = String(fields.SignedHeaders || '').split(';').filter(Boolean);
    const headers = {};
    for (const name of signedNames) {
      if (name === 'host') headers.host = req.headers.host;
      else if (name === 'content-length') headers[name] = String(body.length);
      else headers[name] = req.headers[name];
    }
    const payloadHash = req.headers['x-amz-content-sha256'] || sha256Hex(body);
    if (payloadHash !== 'UNSIGNED-PAYLOAD' && payloadHash !== sha256Hex(body)) {
      return { ok: false, code: 'XAmzContentSHA256Mismatch', message: 'Body hash does not match x-amz-content-sha256' };
    }

    const amzDate = req.headers['x-amz-date'];
    const canonical = canonicalRequest({ method: req.method, path: url.pathname, query: {}, headers, payloadHash });
    lastCanonical = { canonical, payloadHash, signedHeaders: signedNames, headers, path: url.pathname };
    const expected = hmac(signingKey(secretAccessKey, dateStamp, region, service), [ALGORITHM, amzDate, scope, sha256Hex(canonical)].join('\n')).toString('hex');
    if (expected !== fields.Signature) return { ok: false, code: 'SignatureDoesNotMatch', message: 'The request signature we calculated does not match the signature you provided' };
    if (sessionToken && req.headers['x-amz-security-token'] !== sessionToken) {
      return { ok: false, code: 'InvalidToken', message: 'The provided token is malformed or otherwise invalid' };
    }
    return { ok: true };
  }

  /** Presigned GETs arrive with the signature in the query instead of a header. */
  function verifyPresigned(url) {
    const params = url.searchParams;
    if (params.get('X-Amz-Algorithm') !== ALGORITHM) return { ok: false, code: 'AccessDenied', message: 'Missing presign algorithm' };
    const credential = params.get('X-Amz-Credential') || '';
    const [keyId, dateStamp, region, service, terminator] = credential.split('/');
    if (terminator !== 'aws4_request') return { ok: false, code: 'AuthorizationHeaderMalformed', message: 'Presigned scope must end in aws4_request' };
    const scope = [dateStamp, region, service, terminator].join('/');
    if (keyId !== accessKeyId) return { ok: false, code: 'InvalidAccessKeyId', message: `Unknown key ${keyId}` };
    const expires = Number(params.get('X-Amz-Expires') || 0);
    const signedAt = Date.parse(`${params.get('X-Amz-Date')?.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z') || ''}`);
    if (!Number.isFinite(signedAt) || signedAt + expires * 1000 < Date.now()) {
      return { ok: false, code: 'AccessDenied', message: 'Request has expired' };
    }

    const query = {};
    for (const [name, value] of params.entries()) if (name !== 'X-Amz-Signature') query[name] = value;
    const canonical = canonicalRequest({ method: 'GET', path: url.pathname, query, headers: { host: url.host }, payloadHash: 'UNSIGNED-PAYLOAD' });
    const expected = hmac(signingKey(secretAccessKey, dateStamp, region, service), [ALGORITHM, params.get('X-Amz-Date'), scope, sha256Hex(canonical)].join('\n')).toString('hex');
    if (expected !== params.get('X-Amz-Signature')) return { ok: false, code: 'SignatureDoesNotMatch', message: 'Presigned URL signature mismatch' };
    return { ok: true };
  }

  const server = http.createServer((req, res) => {
    requests += 1;
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      // Path-style: /<bucket>/<key…>. Virtual-host style is not modelled.
      const [, bucket, ...rest] = url.pathname.split('/');
      const key = decodeURIComponent(rest.join('/'));
      if (!bucket) return xmlError(res, 'InvalidRequest', 'Bucket name missing', 400);
      const presigned = req.method === 'GET' && url.searchParams.has('X-Amz-Signature');
      const verdict = presigned ? verifyPresigned(url) : verify(req, url, body);
      if (!verdict.ok) return xmlError(res, verdict.code, verdict.message, verdict.code === 'InvalidAccessKeyId' ? 403 : 403);

      const stored = objects.get(keyFor(bucket, key));
      if (req.method === 'PUT') {
        objects.set(keyFor(bucket, key), { body, contentType: req.headers['content-type'] || 'application/octet-stream', modified: new Date().toISOString() });
        return respond(res, 200, '', { etag: `"${sha256Hex(body).slice(0, 32)}"` });
      }
      if (req.method === 'HEAD') {
        if (!stored) return respond(res, 404, '');
        return respond(res, 200, '', { 'content-length': String(stored.body.length), 'content-type': stored.contentType });
      }
      if (req.method === 'GET') {
        if (!stored) return xmlError(res, 'NoSuchKey', `The specified key does not exist: ${key}`, 404);
        return respond(res, 200, stored.body, { 'content-type': stored.contentType, 'content-length': String(stored.body.length) });
      }
      if (req.method === 'DELETE') {
        objects.delete(keyFor(bucket, key));
        return respond(res, 204, '');
      }
      return xmlError(res, 'MethodNotAllowed', `${req.method} is not supported by this fake`, 405);
    });
  });

  return {
    objects,
    failures,
    get requestCount() { return requests; },
    /** The last canonical request the verifier built, for debugging signatures. */
    get lastCanonical() { return lastCanonical; },
    async listen(port = 0) {
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
      return { port: server.address().port, endpoint: `http://127.0.0.1:${server.address().port}` };
    },
    keysFor(bucket) {
      return [...objects.keys()].filter((entry) => entry.startsWith(`${bucket}/`)).map((entry) => entry.slice(bucket.length + 1));
    },
    get(bucket, key) {
      return objects.get(keyFor(bucket, key)) || null;
    },
    /** Simulates an object vanishing (or being deleted by someone else). */
    forget(bucket, key) {
      objects.delete(keyFor(bucket, key));
    },
      close: () => new Promise((resolve) => server.close(resolve)),
  };
}
