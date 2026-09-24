# Providers and models

Adding a model is a data change. Adding a vendor is one small file. Neither touches the routes,
the database, or the UI.

## Add a model (no code)

1. Open `server/catalog.js`.
2. Add an entry to `CATALOG`:

```js
{
  id: 'openai-gpt-4.1-mini',            // stable internal id
  name: 'GPT-4.1 mini',                  // what the UI shows
  maker: 'OpenAI',
  provider: 'openai',                    // must match a registered adapter
  providerModel: 'gpt-4.1-mini',         // what the API receives
  kind: 'text',                          // 'text' or 'image'
  tags: ['Text', 'Fast'],
  description: 'A quicker, cheaper model for first drafts and iterations.',
  pricing: { input: 0.4, output: 1.6, unit: 'usd-per-million-tokens', estimated: true },
}
```

3. Restart the server. The model appears on the Models page and in the model picker.

With a key configured, the server also lists whatever the provider reports that is not in your
catalogue, tagged `Discovered`. That is the safety net against model-id drift.

### Pricing

`pricing` drives the credits and cost columns; it does not affect generation. Two shapes:

```js
pricing: { input: 2.0, output: 8.0, unit: 'usd-per-million-tokens', estimated: true }
pricing: { perImage: 0.04, unit: 'usd-per-image', estimated: true }
```

One credit ≈ $0.001 of estimated spend (`CREDIT_RATES` in `catalog.js`). Rates change often —
verify them against the provider's pricing page before trusting the numbers anywhere near money,
and mark them `estimated: false` only when you have confirmed them.

### Which model does "Auto select" pick?

The first configured provider in `AI_STUDIO_PROVIDER_ORDER` (default
`openai,anthropic,gemini,ollama,mock`) that can produce the requested kind. An explicit model
selection is never silently substituted: if its provider is not configured, the request fails with
a hint telling you how to enable it.

---

## Add a provider (one file)

1. Create `server/providers/yourvendor.js` exporting a factory:

```js
import { notConfigured, readErrorBody, request } from './util.js';

export function createYourVendorProvider(cfg) {
  const id = 'yourvendor';
  return {
    id,
    label: 'Your Vendor',
    isConfigured: () => Boolean(cfg.apiKey),
    hint: 'Set YOURVENDOR_API_KEY in .env to enable these models.',

    async discoverModels({ signal }) {
      if (!cfg.apiKey) throw notConfigured(id, this.hint);
      const response = await request(`${cfg.baseUrl}/models`, {
        provider: id, signal, headers: { Authorization: `Bearer ${cfg.apiKey}` }, timeoutMs: 15_000,
      });
      if (!response.ok) throw new Error(await readErrorBody(response));
      const payload = await response.json();
      return (payload.data || []).map((model) => ({ id: model.id, kind: 'text' }));
    },

    // Must be an async generator that yields { type: 'delta', text } and,
    // at the end, { type: 'usage', tokensIn, tokensOut }.
    // `images` is an array of { mime, dataUrl } reference images; adapters that
    // cannot accept them should yield a notice saying so, never silently drop them.
    async *streamText({ model, prompt, system = '', maxTokens = 1200, signal, images = [] }) {
      if (!cfg.apiKey) throw notConfigured(id, this.hint);
      const response = await request(`${cfg.baseUrl}/chat`, {
        provider: id, method: 'POST', signal,
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, system, max_tokens: maxTokens, stream: true }),
      });
      // …parse your vendor's stream, yielding { type: 'delta', text } per chunk…
      yield { type: 'usage', tokensIn: 0, tokensOut: 0 };
    },

    async generateImage({ model, prompt, signal }) { /* optional */ },
    async checkHealth({ signal }) { return { ok: true, detail: 'Reachable.' }; },
  };
}
```

2. Register it in `server/providers/index.js`:

```js
const providers = [
  createOpenAIProvider(config.providers.openai),
  createYourVendorProvider(config.providers.yourvendor),   // ← here
  // …
];
```

3. Add its configuration in `server/config.js` (`config.providers.yourvendor`), a line in
   `providerSummary()` so the UI can show its state, and entries in `.env.example`.

That is the whole integration. Streaming, credits, persistence, usage, activity, error handling,
and the demo fallback come from the existing pipeline.

### The adapter contract

| Member | Required | Notes |
| --- | --- | --- |
| `id`, `label` | ✅ | `id` must match `provider` in the catalogue |
| `isConfigured()` | ✅ | Whether this build can use the provider at all |
| `hint` | ✅ | Shown to the user when the provider is not configured |
| `discoverModels()` | ✅ | `[{ id, kind }]`; may throw — failures are recorded, never fatal |
| `streamText()` | ✅ for text | Async generator of `delta`/`usage` events |
| `generateImage()` | for images | Returns `{ dataUrl, revisedPrompt }` |
| `streamText({ images })` | for vision | Reference images as `{ mime, dataUrl }`; yield a `notice` instead of dropping them |
| `checkHealth()` | optional | Powers the "test" button in Settings → Connections |

Event types an adapter may yield: `delta`, `usage`, `notice`. The gateway adds `start`, `asset`,
`error`, and `summary`, so adapters never need to know about HTTP or the database.

### Rules that keep providers honest

- **Never invent output.** If a model returns nothing, yield a `notice` and zeroed usage.
- **Map errors to `ProviderError`** with a `status`, a `code`, and a `hint` a human can act on.
  An auth failure should say which key is wrong, not `HTTP 401`.
- **Send the API key only to the provider.** Keys live in `config.providers.*`, are read from
  `.env`/process environment, and never appear in an API response.
- **Respect `signal`.** The browser aborting a generation must abort the upstream request.
- **Report usage when the provider does.** When it does not, the gateway estimates from character
  counts and marks the result `estimated: true`.

---

## Keys, accounts, and who may spend credits

Provider keys stay in `.env` and are read by the server only; no endpoint ever returns one, and the
browser cannot ask for one. Accounts do not change that — what they add is the question of *who*
may spend those credits. Any member with **editor** or above in the active workspace can run a
generation; a viewer's request is refused (`403`) before the gateway is consulted, so a read-only
teammate can never consume a key. Usage rows carry the workspace id, so `GET /api/usage` totals per
workspace rather than per server.

## Providers in this build

| Provider | Auth | Text | Image | Vision (uploads) | Discovery | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | ✅ `/chat/completions` (SSE) | ✅ `/images/generations` | ✅ `image_url` content parts | ✅ `/models` | `OPENAI_BASE_URL` also covers OpenAI-compatible gateways |
| Anthropic | `ANTHROPIC_API_KEY` | ✅ `/messages` (SSE) | — | ✅ base64 image blocks | ✅ `/models` | `ANTHROPIC_VERSION` is configurable |
| Google Gemini | `GEMINI_API_KEY` | ✅ `streamGenerateContent` (SSE) | ✅ inline image parts | ✅ `inline_data` parts | ✅ `/models` | `GOOGLE_API_KEY` also accepted |
| Ollama | none (`OLLAMA_ENABLED=1`) | ✅ `/api/chat` (NDJSON) | — | ✅ `images` array | ✅ `/api/tags` | Long timeout; models come from your machine |
| Studio demo engine | none | ✅ local | ✅ SVG placeholder | ✅ counted, then noted in the output | n/a | Clearly labelled everywhere; disable with `AI_STUDIO_ALLOW_MOCK=0` |

Attached **text** files do not depend on a provider capability: the server appends them to the
prompt as reference material under a heading, and the run records what travelled with it.

Video and audio generation have no adapter yet. Those modes currently resolve to text or image
output respectively, and the UI says so rather than implying a capability that does not exist.
