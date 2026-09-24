import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
import { createMockProvider } from './mock.js';
import { createOllamaProvider } from './ollama.js';
import { createOpenAIProvider } from './openai.js';

/**
 * Provider registry. Adding a vendor means writing one adapter that exports a
 * `createXProvider(cfg)` factory and registering it here — nothing else in the
 * app (gateway, routes, UI) changes.
 */
export function createProviders(config) {
  const providers = [
    createOpenAIProvider(config.providers.openai),
    createAnthropicProvider(config.providers.anthropic),
    createGeminiProvider(config.providers.gemini),
    createOllamaProvider(config.providers.ollama),
    createMockProvider(config.providers.mock),
  ];

  const order = config.providerOrder;
  providers.sort((a, b) => {
    const ai = order.indexOf(a.id);
    const bi = order.indexOf(b.id);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  return providers;
}
