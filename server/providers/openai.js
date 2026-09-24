import { ProviderError, assertOk, notConfigured, readErrorBody, request } from './util.js';

/**
 * OpenAI adapter (also covers any OpenAI-compatible gateway: Azure-compatible
 * proxies, OpenRouter, vLLM, LM Studio — point OPENAI_BASE_URL at it).
 *
 * Endpoints used:
 *   GET  /models                → live model discovery
 *   POST /chat/completions      → streamed text (SSE)
 *   POST /images/generations    → image generation
 */
export function createOpenAIProvider(cfg) {
  const id = 'openai';
  const base = () => cfg.baseUrl.replace(/\/$/, '');
  const headers = () => ({ Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' });

  return {
    id,
    label: 'OpenAI',
    isConfigured: () => Boolean(cfg.apiKey),
    hint: 'Set OPENAI_API_KEY in .env to enable OpenAI models.',

    async discoverModels({ signal } = {}) {
      if (!cfg.apiKey) throw notConfigured(id, this.hint);
      const response = await request(`${base()}/models`, { provider: id, headers: headers(), signal, timeoutMs: 15_000 });
      if (!response.ok) {
        const detail = await readErrorBody(response);
        throw new ProviderError(`${id} model list failed (${response.status})`, { provider: id, status: 401, code: 'provider_auth_error', hint: detail || 'Check OPENAI_API_KEY.' });
      }
      const payload = await response.json();
      return (payload.data || [])
        .filter((model) => model?.id)
        .map((model) => ({ id: model.id, kind: /image|dall-e/i.test(model.id) ? 'image' : 'text' }));
    },

    async *streamText({ model, prompt, system = '', maxTokens = 1200, signal }) {
      if (!cfg.apiKey) throw notConfigured(id, this.hint);
      const response = await request(`${base()}${cfg.chatPath}`, {
        provider: id,
        method: 'POST',
        headers: headers(),
        signal,
        body: JSON.stringify({
          model,
          stream: true,
          max_completion_tokens: maxTokens,
          stream_options: { include_usage: true },
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: prompt },
          ],
        }),
      });
      if (!response.ok) {
        const detail = await readErrorBody(response);
        throw new ProviderError(`${id} completion failed (${response.status})`, {
          provider: id,
          status: response.status === 401 ? 401 : 502,
          code: 'provider_request_failed',
          hint: detail || `Confirm "${model}" exists for this account and that OPENAI_API_KEY is valid.`,
        });
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let received = false;
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') return;
          let payload;
          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }
          const delta = payload.choices?.[0]?.delta?.content;
          if (delta) {
            received = true;
            yield { type: 'delta', text: delta };
          }
          if (payload.usage) {
            yield {
              type: 'usage',
              tokensIn: payload.usage.prompt_tokens || 0,
              tokensOut: payload.usage.completion_tokens || 0,
            };
          }
          const reason = payload.choices?.[0]?.finish_reason;
          if (reason && !received && reason !== 'stop') {
            yield { type: 'notice', message: `OpenAI stopped early (${reason}).` };
          }
        }
      }
    },

    async generateImage({ model, prompt, size = '1024x1024', signal }) {
      if (!cfg.apiKey) throw notConfigured(id, this.hint);
      const response = await request(`${base()}${cfg.imagesPath}`, {
        provider: id,
        method: 'POST',
        headers: headers(),
        signal,
        body: JSON.stringify({ model, prompt, n: 1, size }),
      });
      if (!response.ok) {
        const detail = await readErrorBody(response);
        throw new ProviderError(`${id} image request failed (${response.status})`, {
          provider: id,
          status: response.status === 401 ? 401 : 502,
          code: 'provider_request_failed',
          hint: detail || `Confirm "${model}" is an image model available to this account.`,
        });
      }
      const payload = await response.json();
      const item = payload.data?.[0] || {};
      const dataUrl = item.b64_json ? `data:image/png;base64,${item.b64_json}` : (item.url || '');
      if (!dataUrl) throw new ProviderError('OpenAI returned no image data', { provider: id, code: 'provider_empty_response' });
      return { dataUrl, revisedPrompt: item.revised_prompt || prompt, tokensIn: 0, tokensOut: 0 };
    },

    async checkHealth({ signal } = {}) {
      if (!cfg.apiKey) return { ok: false, detail: 'No API key configured.' };
      try {
        const response = await request(`${base()}/models`, { provider: id, headers: headers(), signal, timeoutMs: 8_000 });
        await assertOk(response, id, 'OpenAI health');
        return { ok: true, detail: 'API key accepted.' };
      } catch (error) {
        return { ok: false, detail: error.message };
      }
    },
  };
}
