import { ProviderError, notConfigured, readErrorBody, request } from './util.js';

/**
 * Google Gemini adapter.
 *
 * Endpoints used:
 *   GET  /models                                  → live model discovery
 *   POST /models/{model}:streamGenerateContent    → streamed text (SSE via ?alt=sse)
 *   POST /models/{model}:generateContent          → image generation (inlineData parts)
 */
export function createGeminiProvider(cfg) {
  const id = 'gemini';
  const base = () => cfg.baseUrl.replace(/\/$/, '');
  const key = () => cfg.apiKey;
  const headers = () => ({ 'Content-Type': 'application/json', 'x-goog-api-key': key() });

  const clean = (model) => String(model).replace(/^models\//, '');

  const payloadFor = ({ prompt, system, maxTokens, modalities, images = [] }) => ({
    contents: [{
      role: 'user',
      parts: [
        ...images.map((image) => ({
          inline_data: { mime_type: image.mime, data: String(image.dataUrl).split(',')[1] || '' },
        })),
        { text: prompt },
      ],
    }],
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: {
      maxOutputTokens: maxTokens,
      ...(modalities ? { responseModalities: modalities } : {}),
    },
  });

  return {
    id,
    label: 'Google Gemini',
    isConfigured: () => Boolean(key()),
    hint: 'Set GEMINI_API_KEY in .env to enable Gemini models.',

    async discoverModels({ signal } = {}) {
      if (!key()) throw notConfigured(id, this.hint);
      const response = await request(`${base()}/models?pageSize=200`, { provider: id, headers: headers(), signal, timeoutMs: 15_000 });
      if (!response.ok) {
        const detail = await readErrorBody(response);
        throw new ProviderError(`${id} model list failed (${response.status})`, { provider: id, status: 401, code: 'provider_auth_error', hint: detail || 'Check GEMINI_API_KEY.' });
      }
      const payload = await response.json();
      return (payload.models || [])
        .filter((model) => model?.name)
        .map((model) => ({
          id: clean(model.name),
          kind: /image/i.test(model.name) ? 'image' : 'text',
          methods: model.supportedGenerationMethods || [],
        }));
    },

    async *streamText({ model, prompt, system = '', maxTokens = 1200, signal, images = [] }) {
      if (!key()) throw notConfigured(id, this.hint);
      const url = `${base()}/models/${clean(model)}:streamGenerateContent?alt=sse`;
      const response = await request(url, {
        provider: id,
        method: 'POST',
        headers: headers(),
        signal,
        timeoutMs: cfg.timeoutMs,
        body: JSON.stringify(payloadFor({ prompt, system, maxTokens, images })),
      });
      if (!response.ok) {
        const detail = await readErrorBody(response);
        throw new ProviderError(`${id} completion failed (${response.status})`, {
          provider: id,
          status: response.status === 401 || response.status === 403 ? 401 : 502,
          code: 'provider_request_failed',
          hint: detail || `Confirm "${clean(model)}" is available to this API key.`,
        });
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let tokensIn = 0;
      let tokensOut = 0;

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
          const parts = payload.candidates?.[0]?.content?.parts || [];
          for (const part of parts) if (part.text) yield { type: 'delta', text: part.text };
          const usage = payload.usageMetadata;
          if (usage) {
            tokensIn = usage.promptTokenCount || tokensIn;
            tokensOut = usage.candidatesTokenCount || tokensOut;
          }
          const blockReason = payload.candidates?.[0]?.finishReason;
          if (blockReason && !['STOP', 'MAX_TOKENS'].includes(blockReason)) {
            yield { type: 'notice', message: `Gemini finished early (${blockReason}).` };
          }
        }
      }
      yield { type: 'usage', tokensIn, tokensOut };
    },

    async generateImage({ model, prompt, signal }) {
      if (!key()) throw notConfigured(id, this.hint);
      const url = `${base()}/models/${clean(model)}:generateContent`;
      const response = await request(url, {
        provider: id,
        method: 'POST',
        headers: headers(),
        signal,
        timeoutMs: cfg.timeoutMs,
        body: JSON.stringify(payloadFor({ prompt, maxTokens: 1024, modalities: ['IMAGE'] })),
      });
      if (!response.ok) {
        const detail = await readErrorBody(response);
        throw new ProviderError(`${id} image request failed (${response.status})`, {
          provider: id,
          status: response.status === 401 || response.status === 403 ? 401 : 502,
          code: 'provider_request_failed',
          hint: detail || `Confirm "${clean(model)}" supports image output.`,
        });
      }
      const payload = await response.json();
      const parts = payload.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find((part) => part.inlineData?.data || part.inline_data?.data);
      const inline = imagePart?.inlineData || imagePart?.inline_data;
      if (!inline?.data) throw new ProviderError('Gemini returned no image data', { provider: id, code: 'provider_empty_response' });
      const mime = inline.mimeType || inline.mime_type || 'image/png';
      return {
        dataUrl: `data:${mime};base64,${inline.data}`,
        revisedPrompt: prompt,
        tokensIn: payload.usageMetadata?.promptTokenCount || 0,
        tokensOut: payload.usageMetadata?.candidatesTokenCount || 0,
      };
    },

    async checkHealth({ signal } = {}) {
      if (!key()) return { ok: false, detail: 'No API key configured.' };
      try {
        const response = await request(`${base()}/models?pageSize=1`, { provider: id, headers: headers(), signal, timeoutMs: 8_000 });
        if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` };
        return { ok: true, detail: 'API key accepted.' };
      } catch (error) {
        return { ok: false, detail: error.message };
      }
    },
  };
}
