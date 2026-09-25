import dns from 'node:dns/promises';
import net from 'node:net';
import { ProviderError } from './providers/util.js';

/**
 * Outbound webhooks.
 *
 * An automation that posts to a URL is a server-side request for anyone who can
 * edit an automation, which is exactly the shape of SSRF: point it at
 * `http://169.254.169.254/` and the instance metadata service answers. So a
 * target has to be allowed by an operator before it is called:
 *
 *   AI_STUDIO_WEBHOOK_ALLOW=hooks.slack.com,discord.com,*.example.com
 *
 * Rules, in the order they are applied:
 *   1. `http`/`https` only — no `file:`, `gopher:`, or a redirect to either.
 *   2. The host must match an allow-list entry: an exact host, `*.suffix`, or `*`.
 *   3. A wildcard match may not resolve to a private, loopback, or link-local
 *      address. Wildcards are for vendors, not for the network the server sits on.
 *   4. An exact entry may point anywhere — including `127.0.0.1` — because that
 *      is an operator saying "yes, this one" (a local collector, a sidecar).
 */

const PRIVATE_V4 = [
  [/^0\./, 'this network'],
  [/^10\./, 'a private network'],
  [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, 'carrier-grade NAT'],
  [/^127\./, 'loopback'],
  [/^169\.254\./, 'link-local'],
  [/^172\.(1[6-9]|2\d|3[01])\./, 'a private network'],
  [/^192\.168\./, 'a private network'],
];

/** Why an address is not reachable from the public internet, or null if it is. */
export function privateReason(address) {
  const value = String(address || '').replace(/^\[|\]$/g, '');
  if (!value) return 'an unknown address';

  if (net.isIP(value) === 4) {
    for (const [pattern, reason] of PRIVATE_V4) if (pattern.test(value)) return reason;
    return null;
  }
  if (net.isIP(value) === 6) {
    const lower = value.toLowerCase();
    if (lower === '::' || lower === '::1') return 'loopback';
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return 'a private network';
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return 'link-local';
    // ::ffff:10.0.0.1 and similar mapped forms
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return privateReason(mapped[1]);
    return null;
  }
  return null;
}

/** `hooks.slack.com` → matches `hooks.slack.com` and `*.slack.com`, never `notslack.com`. */
export function hostMatches(host, patterns) {
  const target = String(host || '').toLowerCase();
  for (const pattern of patterns) {
    const entry = String(pattern || '').trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return { pattern: entry, wildcard: true };
    if (entry === target) return { pattern: entry, wildcard: false };
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(2);
      if (target.length > suffix.length && target.endsWith(`.${suffix}`)) return { pattern: entry, wildcard: true };
    }
  }
  return null;
}

export function createWebhookSender({ allow = [], timeoutMs = 10_000, lookup = dns.lookup, logger = console } = {}) {
  const patterns = (Array.isArray(allow) ? allow : String(allow).split(',')).map((entry) => String(entry).trim()).filter(Boolean);

  /**
   * Decide whether a URL may be called. Returns what was decided so the caller
   * can record it; throws a ProviderError the run log can show verbatim.
   */
  async function assert(url) {
    let parsed;
    try {
      parsed = new URL(String(url || ''));
    } catch {
      throw new ProviderError('Webhook target is not a URL', { status: 400, code: 'webhook_invalid_url' });
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new ProviderError(`Webhooks must use http or https, not ${parsed.protocol.replace(':', '')}`, { status: 400, code: 'webhook_protocol' });
    }
    if (!patterns.length) {
      throw new ProviderError('Outbound webhooks are turned off on this server', {
        status: 400,
        code: 'webhook_disabled',
        hint: 'Set AI_STUDIO_WEBHOOK_ALLOW to the host you want to call, for example AI_STUDIO_WEBHOOK_ALLOW=hooks.slack.com.',
      });
    }

    const match = hostMatches(parsed.hostname, patterns);
    if (!match) {
      throw new ProviderError(`${parsed.hostname} is not on this server's webhook allow list`, {
        status: 400,
        code: 'webhook_not_allowed',
        hint: `Allowed: ${patterns.join(', ')}. An operator changes this with AI_STUDIO_WEBHOOK_ALLOW.`,
      });
    }

    const literal = net.isIP(parsed.hostname.replace(/^\[|\]$/g, ''));
    let addresses = [];
    if (match.wildcard || !literal) {
      try {
        const found = await lookup(parsed.hostname, { all: true });
        addresses = (Array.isArray(found) ? found : [found]).map((entry) => entry?.address).filter(Boolean);
      } catch (error) {
        throw new ProviderError(`Could not resolve ${parsed.hostname}: ${error.message}`, { status: 502, code: 'webhook_unresolvable' });
      }
    }
    // A wildcard is a convenience for a vendor, not for the network this server
    // runs on — so it may not reach anything non-public.
    if (match.wildcard) {
      for (const address of addresses.length ? addresses : [parsed.hostname]) {
        const reason = privateReason(address);
        if (reason) {
          throw new ProviderError(`${parsed.hostname} resolves to ${address}, which is ${reason}`, {
            status: 400,
            code: 'webhook_private_address',
            hint: 'Allow that exact host instead of a wildcard if it really is the intended target.',
          });
        }
      }
    }
    return { url: parsed.toString(), hostname: parsed.hostname, pattern: match.pattern, addresses };
  }

  /**
   * Post one JSON payload. Non-2xx is a failure for the run, with a slice of the
   * response so the run log says something more useful than "failed".
   */
  async function send({ url, event = 'automation.run', payload, signal = null }) {
    const target = await assert(url);
    const started = Date.now();
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response;
    try {
      response = await fetch(target.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'AI-Studio-OS/0.2 (+automation webhook)',
          'x-studio-event': event,
        },
        body: JSON.stringify(payload ?? {}),
        signal: combined,
        redirect: 'error', // a host that passed the guard must not redirect elsewhere
      });
    } catch (error) {
      const reason = error?.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : `could not be reached (${error.message})`;
      throw new ProviderError(`Webhook ${reason}`, { status: 502, code: 'webhook_unreachable', retryable: true });
    }

    const text = await response.text().catch(() => '');
    if (!response.ok) {
      // The receiver answering 4xx is a rejection, not a wobble: retrying a 400
      // just posts the same rejected payload again.
      throw new ProviderError(`Webhook answered ${response.status}${text ? `: ${text.slice(0, 180)}` : ''}`, {
        status: 502,
        code: 'webhook_rejected',
        retryable: response.status >= 500 || response.status === 429,
      });
    }
    logger.log?.(`→ webhook ${target.hostname} accepted ${event} in ${Date.now() - started}ms`);
    return { hostname: target.hostname, status: response.status, ms: Date.now() - started };
  }

  return { patterns, assert, send };
}
