import { ProviderError } from '../providers/util.js';
import { ALGORITHM, presignQuery, sha256Hex, signRequest, uriEncode } from './sigv4.js';

/**
 * An S3-compatible object store.
 *
 * Only the four operations this app needs are implemented — PUT, GET, HEAD and
 * DELETE — because uploads are capped at 10 MB (one request, no multipart
 * upload ceremony). Everything is signed with SigV4, so the same driver covers
 * AWS S3, Cloudflare R2, MinIO, Backblaze B2, DigitalOcean Spaces and Wasabi;
 * the differences are all in the endpoint and whether it wants path-style URLs.
 *
 * Two decisions worth stating:
 *
 *   • Objects are keyed per workspace (`w/<workspaceId>/<fileId><ext>`), so a
 *     bucket shared by every tenant is still browsable and a leaked key cannot
 *     be guessed from a file id alone.
 *   • Reads still go through the API unless redirect mode is switched on. Serving
 *     a presigned URL directly means anyone holding the link has the bytes, with
 *     no membership check — fine for a private bucket and large files, but it is
 *     a trade the operator has to make deliberately, so it is opt-in.
 */

const SERVICE = 's3';

export function createS3Storage({
  bucket,
  endpoint,
  region = 'auto',
  accessKeyId,
  secretAccessKey,
  sessionToken = '',
  prefix = 'studio',
  pathStyle = true,
  timeoutMs = 30_000,
  retries = 1,
  presignTtlMs = 300_000,
  signedUrlBase = '',
  logger = console,
} = {}) {
  if (!bucket) throw new ProviderError('S3 storage needs a bucket name', { status: 500, code: 'storage_misconfigured' });
  if (!accessKeyId || !secretAccessKey) {
    throw new ProviderError('S3 storage needs an access key id and secret', {
      status: 500,
      code: 'storage_misconfigured',
      hint: 'Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (or AI_STUDIO_S3_ACCESS_KEY / _SECRET).',
    });
  }

  const base = new URL(endpoint || `https://s3.${region}.amazonaws.com`);
  const credentials = { accessKeyId, secretAccessKey, region, sessionToken: sessionToken || '' };
  const cleanPrefix = String(prefix || '').replace(/^\/+|\/+$/g, '');

  /** The URL and the signed `host` header for one object key. */
  function locate(key) {
    const objectKey = cleanPrefix ? `${cleanPrefix}/${key}` : key;
    const url = new URL(base.toString());
    if (pathStyle) {
      url.pathname = `/${bucket}/${objectKey.split('/').map((part) => uriEncode(part, false)).join('/')}`;
    } else {
      url.host = `${bucket}.${base.host}`;
      url.pathname = `/${objectKey.split('/').map((part) => uriEncode(part, false)).join('/')}`;
    }
    return { url, objectKey, path: url.pathname };
  }

  const isRetryable = (status) => status === 429 || status >= 500;

  /**
   * One signed request. The header map is built first, signed as a whole, and
   * then sent unmodified — signing a set of headers that is not the set on the
   * wire is the classic way to produce a SignatureDoesNotMatch that is very hard
   * to read.
   */
  async function send(method, key, { body, contentType, allowMissing = false } = {}) {
    const { url, path } = locate(key);
    const payload = body || Buffer.alloc(0);
    const payloadHash = sha256Hex(payload);
    const { amzDate } = signRequest({ method, path, headers: {}, payloadHash, credentials, service: SERVICE });

    const headers = {
      host: url.host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      ...(contentType ? { 'content-type': contentType } : {}),
      ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
    };
    const { signature, scope } = signRequest({ method, path, headers, payloadHash, credentials, service: SERVICE });
    const signedHeaders = Object.keys(headers).sort().join(';');
    const requestHeaders = {
      ...headers,
      Authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };

    const attempt = async () => {
      const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: method === 'GET' || method === 'HEAD' ? undefined : payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return response;
      if (response.status === 404 && allowMissing) return response;
      if (isRetryable(response.status)) {
        throw Object.assign(new Error(`S3 responded ${response.status}`), { retryable: true, status: response.status });
      }
      throw Object.assign(await s3Error(response, key), { retryable: false });
    };

    let lastError = null;
    for (let attemptIndex = 0; attemptIndex <= retries; attemptIndex += 1) {
      try {
        return await attempt();
      } catch (error) {
        lastError = error;
        if (!error.retryable || attemptIndex === retries) break;
        logger.warn?.(`Object store ${method} ${key} failed (${error.message}); retrying once.`);
        await new Promise((resolve) => setTimeout(resolve, 250 * (attemptIndex + 1)));
      }
    }
    if (lastError instanceof ProviderError) throw lastError;
    throw new ProviderError(`Object storage is unreachable: ${lastError?.message || 'request failed'}`, {
      status: 502,
      code: 'storage_unreachable',
      hint: `Check AI_STUDIO_S3_ENDPOINT (${base.origin}) and the bucket "${bucket}".`,
    });
  }

  return {
    kind: 's3',
    label: `S3-compatible (${bucket})`,

    /** Objects live under a per-workspace folder inside the configured prefix. */
    keyFor({ workspaceId, id, extension = '' }) {
      const safeExtension = String(extension || '').replace(/[^a-z0-9.]/gi, '');
      return `w/${workspaceId}/${id}${safeExtension}`;
    },

    async put({ key, body, contentType }) {
      await send('PUT', key, { body, contentType });
      return { key, bytes: body.length };
    },

    async get(key) {
      const response = await send('GET', key, { allowMissing: true });
      if (!response || response.status === 404) {
        throw new ProviderError('That file is no longer in the object store', { status: 404, code: 'file_missing' });
      }
      return Buffer.from(await response.arrayBuffer());
    },

    async exists(key) {
      const response = await send('HEAD', key, { allowMissing: true });
      return Boolean(response && response.status !== 404);
    },

    async remove(key) {
      const response = await send('DELETE', key, { allowMissing: true });
      return Boolean(response && response.status !== 404);
    },

    /** A short-lived presigned GET URL, used only when redirect mode is on. */
    url(key, { ttlMs = presignTtlMs, now = new Date() } = {}) {
      const { url, path } = locate(key);
      const expiresSeconds = Math.max(1, Math.min(604_800, Math.round(ttlMs / 1000)));
      const query = presignQuery({ credentials, expiresSeconds, date: now });
      // `X-Amz-SignedHeaders` says `host`, so the host header is part of the
      // canonical request — signing an empty header set here would produce a
      // URL that every real S3 implementation rejects.
      const { signature } = signRequest({
        method: 'GET',
        path,
        query,
        headers: { host: url.host },
        payloadHash: 'UNSIGNED-PAYLOAD',
        credentials,
        date: now,
      });
      const signed = new URL(url.toString());
      for (const [name, value] of Object.entries({ ...query, 'X-Amz-Signature': signature })) {
        signed.searchParams.set(name, value);
      }
      return signed.toString();
    },

    /** No secrets: safe to return over HTTP to a signed-in member. */
    describe() {
      return {
        driver: 's3',
        bucket,
        endpoint: base.origin,
        region,
        prefix: cleanPrefix,
        addressing: pathStyle ? 'path-style' : 'virtual-hosted',
        readable: true,
      };
    },

    /**
     * Writes, reads back, and deletes a probe object. This is the "is the bucket
     * actually reachable with these credentials" question, answered by doing it.
     */
    async check() {
      const key = `w/_healthcheck/${Date.now().toString(36)}.txt`;
      const body = Buffer.from(`studio storage probe ${new Date().toISOString()}\n`, 'utf8');
      await this.put({ key, body, contentType: 'text/plain' });
      const read = await this.get(key);
      await this.remove(key);
      return { ok: read.equals(body), bytes: read.length };
    },
  };
}

/** Turns S3's XML error document into the app's error shape. */
async function s3Error(response, key) {
  const text = await response.text().catch(() => '');
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] || `HTTP ${response.status}`;
  const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1] || 'the object store refused the request';
  const hint = code === 'SignatureDoesNotMatch' || code === 'InvalidAccessKeyId'
    ? 'The storage credentials in .env do not match the bucket. Re-check the key id and secret.'
    : code === 'NoSuchBucket'
      ? 'That bucket does not exist yet. Create it in your storage provider first.'
      : code === 'AccessDenied'
        ? 'The access key is valid but is not allowed to touch this bucket.'
        : '';
  return new ProviderError(`Object storage rejected the request: ${code} — ${message}`, {
    status: 502,
    code: `storage_${code.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}`,
    hint,
  });
}
