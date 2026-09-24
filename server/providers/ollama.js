import { ProviderError, notConfigured, readErrorBody, request } from './util.js';

/**
 * Ollama adapter — local models with no API key and no per-token cost.
 * Opt in with OLLAMA_ENABLED=1 and make sure the daemon is running.
 *
 * Endpoints used:
 *   GET  /api/tags  → installed models
 *   POST /api/chat  → streamed text (newline-delimited JSON)
 */
export function createOllamaProvider(cfg) {
  const id = 'ollama';
  const base = () => cfg.baseUrl.replace(/\/$/, '');
  const headers = () => ({ 'Content-Type': 'application/json' });

  return {
    id,
    label: 'Ollama (local)',
    isConfigured: () => Boolean(cfg.enabled),
    hint: 'Set OLLAMA_ENABLED=1 in .env and start the Ollama daemon to use local models.',

    async discoverModels({ signal } = {}) {
      if (!cfg.enabled) throw notConfigured(id, this.hint);
      const response = await request(`${base()}/api/tags`, { provider: id, headers: headers(), signal, timeoutMs: 6_000 });
      if (!response.ok) {
        const detail = await readErrorBody(response);
        throw new ProviderError(`${id} model list failed (${response.status})`, { provider: id, code: 'provider_unreachable', hint: detail || 'Is the Ollama daemon running?' });
      }
      const payload = await response.json();
      return (payload.models || []).filter((model) => model?.name).map((model) => ({ id: model.name, kind: 'text' }));
    },

    async *streamText({ model, prompt, system = '', signal }) {
      if (!cfg.enabled) throw notConfigured(id, this.hint);
      const response = await request(`${base()}/api/chat`, {
        provider: id,
        method: 'POST',
        headers: headers(),
        // Long local generations need a longer leash than a hosted API call.
        timeoutMs: 300_000,
        signal,
        body: JSON.stringify({
          model,
          stream: true,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: prompt },
          ],
          options: { num_predict: 1200 },
        }),
      });
      if (!response.ok) {
        const detail = await readErrorBody(response);
        throw new ProviderError(`${id} completion failed (${response.status})`, {
          provider: id,
          code: 'provider_request_failed',
          hint: detail || `Run "ollama pull ${model}" first.`,
        });
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let tokensIn = 0;
      let tokensOut = 0;

      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let payload;
          try {
            payload = JSON.parse(line);
          } catch {
            continue;
          }
          if (payload.message?.content) yield { type: 'delta', text: payload.message.content };
          if (payload.done) {
            tokensIn = payload.prompt_eval_count || tokensIn;
            tokensOut = payload.eval_count || tokensOut;
          }
          if (payload.error) throw new ProviderError(payload.error, { provider: id, code: 'provider_stream_error' });
        }
      }
      yield { type: 'usage', tokensIn, tokensOut };
    },

    async checkHealth({ signal } = {}) {
      if (!cfg.enabled) return { ok: false, detail: 'Ollama is disabled.' };
      try {
        const response = await request(`${base()}/api/tags`, { provider: id, headers: headers(), signal, timeoutMs: 4_000 });
        if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
        const payload = await response.json();
        return { ok: true, detail: `${(payload.models || []).length} local model(s) available.` };
      } catch (error) {
        return { ok: false, detail: error.message };
      }
    },
  };
}
