/**
 * Small shared helpers for provider adapters.
 *
 * Every adapter speaks the same tiny language: async generators that yield
 * `{ type: 'delta' | 'usage' | 'notice' | 'asset', ... }` events. The gateway
 * forwards those events to the browser unchanged, which is why adding a vendor
 * never touches the HTTP layer.
 */

export class ProviderError extends Error {
  /**
   * `retryable` is optional on purpose: when it is set, the layer that raised
   * the error is saying whether trying again could work (a rate limit) or cannot
   * (a rejected payload). Callers that retry should trust it over any guess
   * they would otherwise make from the status code.
   */
  constructor(message, { provider, status = 502, code = 'provider_error', hint = '', retryable = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.code = code;
    this.hint = hint;
    if (retryable !== null) this.retryable = Boolean(retryable);
  }
}

export function notConfigured(provider, hint) {
  return new ProviderError(`${provider} is not configured`, {
    provider,
    status: 503,
    code: 'provider_not_configured',
    hint,
  });
}

export function assertOk(response, provider, context) {
  if (response.ok) return response;
  return new ProviderError(`${context || provider} request failed with ${response.status}`, {
    provider,
    status: response.status === 401 || response.status === 403 ? 401 : 502,
    code: 'provider_http_error',
    hint: response.status === 401 || response.status === 403
      ? 'Check that the API key in your .env file is valid and has access to this model.'
      : 'The provider rejected the request. Confirm the model id in server/catalog.js is still current.',
  });
}

export async function readErrorBody(response) {
  try {
    const text = await response.text();
    const parsed = JSON.parse(text);
    const message = parsed?.error?.message || parsed?.message || parsed?.error || text;
    return String(message).slice(0, 400);
  } catch {
    return '';
  }
}

/** fetch with a hard timeout and abort propagation. */
export async function request(url, { provider, timeoutMs = 60_000, signal, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (controller.signal.aborted) {
      throw new ProviderError(`${provider} timed out`, { provider, status: 504, code: 'provider_timeout', hint: 'Increase AI_STUDIO_TIMEOUT_MS or try a smaller request.' });
    }
    throw new ProviderError(`Could not reach ${provider}: ${error.message}`, { provider, status: 502, code: 'provider_unreachable' });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Parses `text/event-stream` bodies (OpenAI, Anthropic, Gemini) into
 * `{ event, data }` records. Unknown fields are skipped rather than throwing,
 * so a provider adding a new event type never breaks a stream.
 */
export async function* parseSSE(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() || '';
    for (const part of parts) {
      let event = 'message';
      const dataLines = [];
      for (const line of part.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      const data = dataLines.join('\n');
      if (!data) continue;
      if (data === '[DONE]') return;
      yield { event, data };
    }
  }
}

export function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Splits a finished string into natural-sized stream chunks. */
export function* chunkText(text, size = 14) {
  const words = String(text).split(/(\s+)/);
  let buffer = '';
  for (const word of words) {
    buffer += word;
    if (buffer.length >= size) {
      yield buffer;
      buffer = '';
    }
  }
  if (buffer) yield buffer;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
