/**
 * Model catalogue.
 *
 * The UI never talks to a provider directly — it asks for a catalogue entry and
 * the gateway resolves it to `{ provider, providerModel }`. That indirection is
 * what makes new vendors a data change instead of a code change.
 *
 * Two rules keep this file honest:
 *   1. `providerModel` values are defaults, not promises. When a key is present
 *      the server asks the provider for its live model list and marks each
 *      entry `verified: true` / `verified: false`, so rot is visible in the UI.
 *   2. `pricing` values are editable estimates used for the credits display.
 *      Confirm current rates with the provider before trusting them for billing.
 */

export const CATALOG = [
  // --- OpenAI ---------------------------------------------------------------
  {
    id: 'openai-gpt-4.1',
    name: 'GPT-4.1',
    maker: 'OpenAI',
    provider: 'openai',
    providerModel: 'gpt-4.1',
    kind: 'text',
    tags: ['Text', 'Reasoning'],
    description: 'A versatile reasoning model for briefs, research, and code.',
    pricing: { input: 2.0, output: 8.0, unit: 'usd-per-million-tokens', estimated: true },
  },
  {
    id: 'openai-gpt-4.1-mini',
    name: 'GPT-4.1 mini',
    maker: 'OpenAI',
    provider: 'openai',
    providerModel: 'gpt-4.1-mini',
    kind: 'text',
    tags: ['Text', 'Fast'],
    description: 'A quicker, cheaper OpenAI model for first drafts and iterations.',
    pricing: { input: 0.4, output: 1.6, unit: 'usd-per-million-tokens', estimated: true },
  },
  {
    id: 'openai-image',
    name: 'GPT Image',
    maker: 'OpenAI',
    provider: 'openai',
    providerModel: 'gpt-image-1',
    kind: 'image',
    tags: ['Image', 'Design'],
    description: 'Prompt-to-image generation with strong prompt adherence.',
    pricing: { perImage: 0.04, unit: 'usd-per-image', estimated: true },
  },

  // --- Anthropic ------------------------------------------------------------
  {
    id: 'anthropic-sonnet',
    name: 'Claude Sonnet',
    maker: 'Anthropic',
    provider: 'anthropic',
    providerModel: 'claude-sonnet-4-5',
    kind: 'text',
    tags: ['Text', 'Reasoning'],
    description: 'Thoughtful writing and structured thinking for creative work.',
    pricing: { input: 3.0, output: 15.0, unit: 'usd-per-million-tokens', estimated: true },
  },
  {
    id: 'anthropic-haiku',
    name: 'Claude Haiku',
    maker: 'Anthropic',
    provider: 'anthropic',
    providerModel: 'claude-haiku-4-5',
    kind: 'text',
    tags: ['Text', 'Fast'],
    description: 'Fast, inexpensive Claude for summaries, tags, and tidying up.',
    pricing: { input: 1.0, output: 5.0, unit: 'usd-per-million-tokens', estimated: true },
  },

  // --- Google ---------------------------------------------------------------
  {
    id: 'gemini-flash',
    name: 'Gemini Flash',
    maker: 'Google',
    provider: 'gemini',
    providerModel: 'gemini-2.5-flash',
    kind: 'text',
    tags: ['Text', 'Fast'],
    description: 'Low-latency multimodal model, good for high-volume drafting.',
    pricing: { input: 0.3, output: 2.5, unit: 'usd-per-million-tokens', estimated: true },
  },
  {
    id: 'gemini-image',
    name: 'Gemini Image',
    maker: 'Google',
    provider: 'gemini',
    providerModel: 'gemini-2.5-flash-image',
    kind: 'image',
    tags: ['Image', 'Design'],
    description: 'Image generation and editing through the Gemini API.',
    pricing: { perImage: 0.039, unit: 'usd-per-image', estimated: true },
  },

  // --- Local ----------------------------------------------------------------
  {
    id: 'ollama-local',
    name: 'Ollama (local)',
    maker: 'Your machine',
    provider: 'ollama',
    providerModel: 'llama3.2',
    kind: 'text',
    tags: ['Text', 'Local'],
    description: 'Runs on your own hardware. No API key, no per-token cost.',
    pricing: { input: 0, output: 0, unit: 'free', estimated: false },
    discovery: true,
  },

  // --- Demo -----------------------------------------------------------------
  {
    id: 'mock-text',
    name: 'Studio demo engine',
    maker: 'AI Studio OS',
    provider: 'mock',
    providerModel: 'studio-mock-v1',
    kind: 'text',
    tags: ['Text', 'Demo'],
    description: 'Deterministic local draft generator. No network, no cost, no real AI.',
    pricing: { input: 0, output: 0, unit: 'free', estimated: false },
    isDemo: true,
  },
  {
    id: 'mock-image',
    name: 'Studio demo render',
    maker: 'AI Studio OS',
    provider: 'mock',
    providerModel: 'studio-mock-image-v1',
    kind: 'image',
    tags: ['Image', 'Demo'],
    description: 'Generates a placeholder canvas so image flows can be demoed offline.',
    pricing: { perImage: 0, unit: 'free', estimated: false },
    isDemo: true,
  },
];

/** Credits are an internal, provider-neutral unit so usage stays comparable. */
export const CREDIT_RATES = {
  'usd-per-million-tokens': { tokensPerCredit: 1_000, creditsPerUnit: 1 }, // 1 credit ≈ $0.001 of estimated spend
  'usd-per-image': { creditsPerImage: 100 },
  free: { creditsPerImage: 0, tokensPerCredit: 1_000, creditsPerUnit: 0 },
};

export function estimateCredits(entry, { tokensIn = 0, tokensOut = 0, images = 0 }) {
  if (!entry || !entry.pricing) return 1;
  const pricing = entry.pricing;
  if (pricing.unit === 'usd-per-image') {
    return Math.max(1, Math.round((pricing.perImage || 0) * 1000) * Math.max(1, images));
  }
  const rate = CREDIT_RATES['usd-per-million-tokens'];
  const spend = (tokensIn / 1e6) * (pricing.input || 0) + (tokensOut / 1e6) * (pricing.output || 0);
  return Math.max(1, Math.round(spend * 1000 * rate.creditsPerUnit));
}

export function estimateCostUsd(entry, { tokensIn = 0, tokensOut = 0, images = 0 }) {
  if (!entry || !entry.pricing) return 0;
  const pricing = entry.pricing;
  if (pricing.unit === 'usd-per-image') return Number(((pricing.perImage || 0) * Math.max(1, images)).toFixed(4));
  return Number((((tokensIn / 1e6) * (pricing.input || 0) + (tokensOut / 1e6) * (pricing.output || 0))).toFixed(4));
}

/** Rough token estimate used when a provider does not report usage. */
export const approximateTokens = (text) => Math.max(1, Math.ceil(String(text || '').length / 4));

export function toPublicModel(entry, providers, discovery = null) {
  const provider = providers.find((item) => item.id === entry.provider);
  const live = discovery?.get(entry.provider)?.ids;
  return {
    id: entry.id,
    name: entry.name,
    maker: entry.maker,
    provider: entry.provider,
    providerLabel: provider?.label || entry.provider,
    providerModel: entry.providerModel,
    kind: entry.kind,
    tags: entry.tags || [],
    description: entry.description,
    descriptionNote: entry.descriptionNote || '',
    pricing: entry.pricing || null,
    isDemo: Boolean(entry.isDemo),
    selectable: Boolean(provider?.configured),
    verified: live ? live.has(entry.providerModel) : null,
    discoveredAt: discovery?.get(entry.provider)?.fetchedAt || null,
  };
}
