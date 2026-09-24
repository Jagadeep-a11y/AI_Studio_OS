import { ProviderError, notConfigured, readErrorBody, request } from './util.js';

/**
 * Anthropic adapter.
 *
 * Endpoints used:
 *   GET  /models     → live model discovery
 *   POST /messages   → streamed text (SSE, `content_block_delta` events)
 */
export function createAnthropicProvider(cfg) {
  const id = 'anthropic';
  const base = () => cfg.baseUrl.replace(/\/$/, '');
  const headers = () => ({
    'x-api-key': cfg.apiKey,
    'anthropic-version': cfg.version,
    'content-type': 'application/json',
  });

  return {
    id,
    label: 'Anthropic',
    isConfigured: () => Boolean(cfg.apiKey),
    hint: 'Set ANTHROPIC_API_KEY in .env to enable Claude models.',

    async discoverModels({ signal } = {}) {
      if (!cfg.apiKey) throw notConfigured(id, this.hint);
      const response = await request(`${base()}/models?limit=100`, { provider: id, headers: headers(), signal, timeoutMs: 15_000 });
      if (!response.ok) {
        const detail = await readErrorBody(response);
        throw new ProviderError(`${id} model list failed (${response.status})`, { provider: id, status: 401, code: 'provider_auth_error', hint: detail || 'Check ANTHROPIC_API_KEY.' });
      }
      const payload = await response.json();
      return (payload.data || []).filter((model) => model?.id).map((model) => ({ id: model.id, kind: 'text' }));
    },

    async *streamText({ model, prompt, system = '', maxTokens = 1200, signal, images = [] }) {
      if (!cfg.apiKey) throw notConfigured(id, this.hint);
      const content = images.length
        ? [
          ...images.map((image) => ({
            type: 'image',
            source: { type: 'base64', media_type: image.mime, data: String(image.dataUrl).split(',')[1] || '' },
          })),
          { type: 'text', text: prompt },
        ]
        : prompt;
      const response = await request(`${base()}/messages`, {
        provider: id,
        method: 'POST',
        headers: headers(),
        signal,
        timeoutMs: cfg.timeoutMs,
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          stream: true,
          system: system || undefined,
          messages: [{ role: 'user', content }],
        }),
      });
      if (!response.ok) {
        const detail = await readErrorBody(response);
        throw new ProviderError(`${id} completion failed (${response.status})`, {
          provider: id,
          status: response.status === 401 ? 401 : 502,
          code: 'provider_request_failed',
          hint: detail || `Confirm "${model}" exists for this account and that ANTHROPIC_API_KEY is valid.`,
        });
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let tokensIn = 0;
      let tokensOut = 0;
      let sawText = false;

      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() || '';
        for (const block of blocks) {
          const dataLine = block.split(/\r?\n/).find((line) => line.startsWith('data:'));
          if (!dataLine) continue;
          let payload;
          try {
            payload = JSON.parse(dataLine.slice(5).trim());
          } catch {
            continue;
          }
          if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta') {
            sawText = true;
            yield { type: 'delta', text: payload.delta.text };
          }
          if (payload.type === 'message_start') tokensIn = payload.message?.usage?.input_tokens || tokensIn;
          if (payload.type === 'message_delta') tokensOut = payload.usage?.output_tokens || tokensOut;
          if (payload.type === 'error') {
            throw new ProviderError(payload.error?.message || 'Anthropic stream error', { provider: id, code: 'provider_stream_error' });
          }
        }
      }

      if (!sawText) yield { type: 'notice', message: 'Anthropic returned no text for this prompt.' };
      yield { type: 'usage', tokensIn, tokensOut };
    },

    async checkHealth({ signal } = {}) {
      if (!cfg.apiKey) return { ok: false, detail: 'No API key configured.' };
      try {
        const response = await request(`${base()}/models?limit=1`, { provider: id, headers: headers(), signal, timeoutMs: 8_000 });
        if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
        return { ok: true, detail: 'API key accepted.' };
      } catch (error) {
        return { ok: false, detail: error.message };
      }
    },
  };
}
