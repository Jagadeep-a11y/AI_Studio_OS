import { approximateTokens } from '../catalog.js';
import { ProviderError, chunkText, sleep } from './util.js';

/**
 * Demo engine.
 *
 * This is a deterministic local stand-in, not a language model. It exists so
 * the full product loop — prompt, streamed output, saved generation, credits,
 * activity, usage — can be exercised with no credentials and no network, and so
 * the UI has an honest fallback instead of a dead end. Everything it returns is
 * labelled as demo output in the API, the UI, and the database row.
 */

const OPENERS = [
  'Here is a first pass you can react to.',
  'A quick direction to get the conversation moving.',
  'A working draft — rough edges on purpose.',
  'One way into this, ready to rework.',
];

function sectionsFor(kind, mode, prompt) {
  const subject = prompt.replace(/\s+/g, ' ').trim().slice(0, 220);
  if (kind === 'image') {
    return [
      `Subject: ${subject}`,
      'Framing: 3:2 landscape, subject slightly off-centre, generous negative space on the right for type.',
      'Light: late-morning sun through a window, soft shadow falloff, no harsh speculars.',
      'Palette: porcelain, warm sand, faded terracotta, one deep accent pulled from the subject.',
      'Texture: fine grain, gentle halation on highlights, matte finish — avoid a plastic, over-sharpened look.',
      'Deliverable: one hero frame plus two alternates (tighter crop, wider environmental).',
    ];
  }
  if (mode === 'Video') {
    return [
      `Premise: ${subject}`,
      'Beat 1 — 0:00–0:04. Wide establishing shot, handheld, natural sound only.',
      'Beat 2 — 0:04–0:09. Macro detail of the thing that matters most; let the frame breathe.',
      'Beat 3 — 0:09–0:14. Human moment, mid-shot, unforced performance.',
      'Beat 4 — 0:14–0:20. Cut to the idea stated plainly, then hold on an empty frame.',
      'Sound: one sustained pad, restrained percussion entering at 0:09, silence at the end.',
    ];
  }
  return [
    `Read on the brief: ${subject}`,
    'Audience: someone who already cares, and needs permission to act, not more information.',
    'Tension: they want the feeling of being considered; they are offered noise instead.',
    'Idea: lead with the specific, human detail. Let the product be the proof, not the pitch.',
    'Tone: warm, plain-spoken, confident enough to be quiet. No superlatives, no exclamation marks.',
    'Structure: hook (one line) → real tension (two lines) → how it works (three short points) → invitation (one line).',
    'First deliverable: a single 60-word hero, plus two alternates at half the length.',
  ];
}

export function createMockProvider() {
  return {
    id: 'mock',
    label: 'Studio demo engine',
    isDemo: true,
    isConfigured: () => true,
    hint: 'Demo output. Add a provider key to .env to generate with a real model.',

    async discoverModels() {
      return [
        { id: 'studio-mock-v1', kind: 'text' },
        { id: 'studio-mock-image-v1', kind: 'image' },
      ];
    },

    async *streamText({ prompt, kind = 'text', mode = 'Writing', signal, images = [] }) {
      yield { type: 'notice', message: 'Demo output from the local Studio engine — no external model was called.' };
      if (images.length) {
        yield { type: 'notice', message: `${images.length} reference image${images.length === 1 ? '' : 's'} received. A real model would look at them; the demo engine only notes that they arrived.` };
      }

      const opener = OPENERS[Math.abs(prompt.length + mode.length) % OPENERS.length];
      const lines = [opener, '', ...sectionsFor(kind, mode, prompt)];
      const text = lines.join('\n');

      for (const piece of chunkText(text, 22)) {
        if (signal?.aborted) throw new ProviderError('Generation cancelled', { provider: 'mock', status: 499, code: 'cancelled' });
        // A short pause keeps the streaming UI honest about what streaming is.
        await sleep(12);
        yield { type: 'delta', text: piece };
      }

      yield {
        type: 'usage',
        tokensIn: approximateTokens(prompt),
        tokensOut: approximateTokens(text),
        estimated: true,
      };
    },

    async generateImage({ prompt, signal }) {
      if (signal?.aborted) throw new ProviderError('Generation cancelled', { provider: 'mock', status: 499, code: 'cancelled' });
      const label = prompt.replace(/\s+/g, ' ').trim().slice(0, 68);
      const seed = [...prompt].reduce((total, char) => (total + char.charCodeAt(0)) % 360, 0);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" width="1200" height="800" role="img" aria-label="Demo render">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${seed} 62% 88%)"/>
      <stop offset="52%" stop-color="hsl(${(seed + 38) % 360} 58% 76%)"/>
      <stop offset="100%" stop-color="hsl(${(seed + 74) % 360} 46% 58%)"/>
    </linearGradient>
    <radialGradient id="glow" cx="72%" cy="26%" r="52%">
      <stop offset="0%" stop-color="#fffdf8" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#fffdf8" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="800" fill="url(#sky)"/>
  <rect width="1200" height="800" fill="url(#glow)"/>
  <circle cx="864" cy="212" r="118" fill="#fffaf2" opacity="0.72"/>
  <path d="M0 640 L250 520 L470 596 L720 470 L1000 560 L1200 496 L1200 800 L0 800 Z" fill="hsl(${(seed + 12) % 360} 34% 46%)" opacity="0.55"/>
  <path d="M0 712 L330 626 L610 690 L900 604 L1200 668 L1200 800 L0 800 Z" fill="hsl(${(seed + 200) % 360} 28% 30%)" opacity="0.72"/>
  <text x="72" y="700" font-family="Georgia, serif" font-size="30" fill="#fffdf8" opacity="0.92">Demo render · ${label.replace(/[<>&]/g, '')}</text>
  <text x="72" y="742" font-family="Helvetica, Arial, sans-serif" font-size="20" fill="#fffdf8" opacity="0.74">Placeholder artwork — connect an image model for a real generation.</text>
</svg>`;
      const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
      await sleep(280);
      return { dataUrl, revisedPrompt: prompt, tokensIn: approximateTokens(prompt), tokensOut: 0, estimated: true };
    },

    /** Present only to keep the adapter interface uniform. */
    async checkHealth() {
      return { ok: true, detail: 'Demo engine is always available.' };
    },
  };
}
