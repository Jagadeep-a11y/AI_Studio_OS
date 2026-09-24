import { CATALOG, approximateTokens, estimateCostUsd, estimateCredits, toPublicModel } from './catalog.js';
import { imageAttachments, withTextReferences } from './files.js';
import { createProviders } from './providers/index.js';
import { ProviderError } from './providers/util.js';
import { providerSummary } from './config.js';

/**
 * The generation gateway.
 *
 * Everything the product needs to know about models passes through here:
 *   - what models exist (catalogue + live discovery)
 *   - which model a UI selection means
 *   - how to stream a generation and how to price it
 *
 * Routes stay thin, and the UI keeps talking in product terms ("Auto select",
 * "Claude Sonnet") rather than vendor-specific model ids.
 */

const DISCOVERY_TTL_MS = 10 * 60_000;

const MODE_KIND = {
  Image: 'image',
  Video: 'image', // no video adapter yet; nearest available output type
  Writing: 'text',
  Audio: 'text', // audio scripts are text until an audio adapter exists
  Code: 'text',
};

export const kindForMode = (mode) => MODE_KIND[mode] || 'text';

export function createGateway(config) {
  const providers = createProviders(config);
  const discovery = new Map();
  let lastDiscoveryAt = 0;

  const providerById = (id) => providers.find((provider) => provider.id === id);
  const configuredProviders = () => providers.filter((provider) => provider.isConfigured());

  /**
   * Asks each configured provider for its live model list. Failures are
   * recorded, never thrown: a broken key must not take the whole app down.
   */
  async function refreshDiscovery({ force = false } = {}) {
    if (!force && Date.now() - lastDiscoveryAt < DISCOVERY_TTL_MS && discovery.size) return discovery;
    const targets = configuredProviders();
    await Promise.all(targets.map(async (provider) => {
      try {
        const models = await provider.discoverModels({});
        discovery.set(provider.id, {
          ids: new Set(models.map((model) => model.id)),
          models,
          fetchedAt: new Date().toISOString(),
          error: null,
        });
      } catch (error) {
        discovery.set(provider.id, {
          ids: discovery.get(provider.id)?.ids || new Set(),
          models: discovery.get(provider.id)?.models || [],
          fetchedAt: new Date().toISOString(),
          error: error instanceof ProviderError ? error.hint || error.message : String(error?.message || error),
        });
      }
    }));
    lastDiscoveryAt = Date.now();
    return discovery;
  }

  function catalogEntries() {
    return CATALOG.map((entry) => ({ ...entry }));
  }

  /** Catalogue entries plus anything the providers report that we did not list. */
  function allEntries() {
    const entries = catalogEntries();
    const known = new Set(entries.map((entry) => `${entry.provider}:${entry.providerModel}`));
    for (const [providerId, state] of discovery) {
      for (const model of state.models || []) {
        if (known.has(`${providerId}:${model.id}`)) continue;
        entries.push({
          id: `${providerId}-${model.id}`.replace(/[^a-zA-Z0-9._-]/g, '-'),
          name: model.id,
          maker: providerById(providerId)?.label || providerId,
          provider: providerId,
          providerModel: model.id,
          kind: model.kind || 'text',
          tags: [model.kind === 'image' ? 'Image' : 'Text', 'Discovered'],
          description: `Discovered from ${providerById(providerId)?.label || providerId}.`,
          descriptionNote: 'Not in the curated catalogue; pricing is unknown, so credits are estimated at the default rate.',
          pricing: { input: 2.0, output: 8.0, unit: 'usd-per-million-tokens', estimated: true },
          discovered: true,
        });
      }
    }
    return entries;
  }

  function findEntry(selection, kind) {
    const value = String(selection || '').trim();
    if (!value || /^auto/i.test(value)) return null;
    const entries = allEntries();
    return (
      entries.find((entry) => entry.id === value) ||
      entries.find((entry) => entry.name.toLowerCase() === value.toLowerCase()) ||
      entries.find((entry) => entry.providerModel === value) ||
      null
    );
  }

  /**
   * Resolves "Auto select" to the first configured provider (in the configured
   * order) that can produce the requested kind — never silently to a different
   * model than the user asked for.
   */
  function autoEntry(kind) {
    for (const provider of providers) {
      if (!provider.isConfigured()) continue;
      const candidate = catalogEntries().find((entry) => entry.provider === provider.id && entry.kind === kind && !entry.discovery);
      if (candidate) return candidate;
      const discovered = [...(discovery.get(provider.id)?.models || [])].find((model) => (model.kind || 'text') === kind);
      if (discovered) return findEntry(discovered.id, kind);
    }
    return null;
  }

  function resolve(selection, kind) {
    const explicit = findEntry(selection, kind);
    if (explicit) {
      const provider = providerById(explicit.provider);
      if (!provider?.isConfigured()) {
        throw new ProviderError(`${explicit.provider} is not connected, so "${explicit.name}" cannot run yet.`, {
          provider: explicit.provider,
          status: 503,
          code: 'provider_not_configured',
          hint: provider?.hint || 'Add the provider key to .env, or choose another model.',
        });
      }
      return { entry: explicit, provider };
    }

    const auto = autoEntry(kind);
    if (auto) {
      const provider = providerById(auto.provider);
      if (provider?.isConfigured()) return { entry: auto, provider, viaAutoSelect: true };
    }

    if (config.allowMock) {
      const mockEntry = catalogEntries().find((entry) => entry.provider === 'mock' && entry.kind === kind)
        || catalogEntries().find((entry) => entry.provider === 'mock');
      return { entry: mockEntry, provider: providerById('mock'), viaAutoSelect: true, isDemoFallback: true };
    }

    throw new ProviderError('No generation provider is configured.', {
      status: 503,
      code: 'no_provider',
      hint: 'Add OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY to .env, or enable OLLAMA_ENABLED=1.',
    });
  }

  /**
   * Streams a generation, normalising every provider's output into the same
   * event sequence the browser consumes.
   */
  async function* run({ selection, prompt, mode = 'Writing', system = '', maxTokens = 1200, signal, kind, attachments = [] }) {
    const outputKind = kind || kindForMode(mode);
    const { entry, provider, isDemoFallback } = resolve(selection, outputKind);
    if (!provider) throw new ProviderError('No provider available for this request', { code: 'no_provider' });

    // Documents become prompt context; images are handed to the adapter.
    const images = outputKind === 'image' ? [] : imageAttachments(attachments);
    const promptWithReferences = withTextReferences(prompt, attachments);
    const references = attachments.map((item) => ({ id: item.id, name: item.name, kind: item.kind, bytes: item.bytes }));

    yield {
      type: 'start',
      provider: entry.provider,
      providerLabel: provider.label,
      modelId: entry.providerModel,
      modelLabel: entry.name,
      kind: outputKind,
      mode,
      isDemo: Boolean(entry.isDemo || provider.isDemo),
      isDemoFallback: Boolean(isDemoFallback),
      pricing: entry.pricing || null,
      pricingEstimated: Boolean(entry.pricing?.estimated),
      note: entry.descriptionNote || '',
      references,
      imagesSent: images.length,
    };

    const binaryReferences = attachments.filter((item) => item.kind === 'binary' || (item.kind === 'image' && !images.includes(item)));
    if (binaryReferences.length && !provider.isDemo) {
      yield {
        type: 'notice',
        message: `${binaryReferences.map((item) => item.name).join(', ')} ${binaryReferences.length === 1 ? 'was' : 'were'} attached but not sent: ${provider.label} only receives text and images in this build.`,
      };
    }
    if (images.length && outputKind === 'image' && !provider.isDemo) {
      yield { type: 'notice', message: 'Reference images are noted in the prompt; image-to-image is not wired up for this provider yet.' };
    }

    if (entry.isDemo || provider.isDemo) {
      yield { type: 'notice', message: 'Demo output: generated locally by the Studio demo engine, not by an AI model.' };
    }

    const started = Date.now();
    let text = '';
    let tokensIn = 0;
    let tokensOut = 0;
    let assetUrl = '';
    let usageReported = false;

    try {
      if (outputKind === 'image') {
        if (typeof provider.generateImage !== 'function') {
          throw new ProviderError(`${provider.label} cannot generate images in this build.`, {
            provider: provider.id,
            status: 501,
            code: 'unsupported_capability',
            hint: 'Choose an image-capable model such as GPT Image or Gemini Image.',
          });
        }
        const result = await provider.generateImage({ model: entry.providerModel, prompt: promptWithReferences, signal });
        assetUrl = result.dataUrl;
        tokensIn = result.tokensIn || approximateTokens(prompt);
        tokensOut = result.tokensOut || 0;
        yield { type: 'asset', url: assetUrl, revisedPrompt: result.revisedPrompt || prompt };
      } else {
        // `runText` never exists alongside the generator: adapters expose one
        // streaming method so partial output is always visible to the user.
        for await (const event of provider.streamText({ model: entry.providerModel, prompt: promptWithReferences, system, maxTokens, signal, images })) {
          if (event.type === 'delta') text += event.text;
          if (event.type === 'usage') {
            usageReported = true;
            tokensIn = event.tokensIn || tokensIn;
            tokensOut = event.tokensOut || tokensOut;
          }
          yield event;
        }
      }
    } catch (error) {
      const providerError = error instanceof ProviderError
        ? error
        : new ProviderError(error?.message || 'Generation failed', { provider: entry.provider, code: 'provider_error' });
      yield { type: 'error', message: providerError.message, hint: providerError.hint, code: providerError.code };
      yield {
        type: 'usage',
        tokensIn: tokensIn || approximateTokens(prompt),
        tokensOut: tokensOut || approximateTokens(text),
        estimated: true,
        failed: true,
      };
      yield { type: 'summary', failed: true, partialText: text, latencyMs: Date.now() - started };
      return;
    }

    if (!usageReported) {
      tokensIn = tokensIn || approximateTokens(prompt);
      tokensOut = tokensOut || approximateTokens(text);
    }
    const usageEstimated = !usageReported && !entry.isDemo;
    if (usageEstimated) yield { type: 'usage', tokensIn, tokensOut, estimated: true };

    const credits = estimateCredits(entry, { tokensIn, tokensOut, images: outputKind === 'image' ? 1 : 0 });
    const costUsd = estimateCostUsd(entry, { tokensIn, tokensOut, images: outputKind === 'image' ? 1 : 0 });

    yield {
      type: 'summary',
      latencyMs: Date.now() - started,
      tokensIn,
      tokensOut,
      credits,
      costUsd,
      costEstimated: Boolean(entry.pricing?.estimated),
      assetUrl,
      text,
      modelId: entry.providerModel,
      modelLabel: entry.name,
      provider: entry.provider,
      isDemo: Boolean(entry.isDemo || provider.isDemo),
    };
  }

  return {
    providers,
    providerSummary,
    refreshDiscovery,
    discoveryState: () => discovery,
    /** Public model list for the Models page and the picker. */
    listModels() {
      const summary = providerSummary();
      const entries = allEntries();
      const models = entries.map((entry) => toPublicModel(entry, summary, discovery));
      return { models, providers: summary, curated: entries.filter((entry) => !entry.discovered).length };
    },
    resolve,
    run,
    kindForMode,
    isDemoOnly: () => !configuredProviders().some((provider) => !provider.isDemo),
  };
}
