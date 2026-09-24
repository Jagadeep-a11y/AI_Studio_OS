import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * End-to-end self test.
 *
 * Boots the real server against a throwaway SQLite file, then drives the API the
 * way the browser does — including reading a full SSE generation stream. Run
 * with `npm test`. Requires no network access and no provider keys: the demo
 * engine covers the generation path.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-selftest-'));
const dbPath = path.join(tmpDir, 'selftest.db');
const port = 4300 + Math.floor(Math.random() * 400);
const base = `http://127.0.0.1:${port}`;

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function waitForServer(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

/** Reads an SSE response into a list of `{ event, data }` records. */
async function readStream(response) {
  const events = [];
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const blocks = buffer.split(/\n\n/);
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      const eventLine = block.split('\n').find((line) => line.startsWith('event:'));
      const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
      if (!dataLine) continue;
      events.push({ event: eventLine ? eventLine.slice(6).trim() : 'message', data: JSON.parse(dataLine.slice(5).trim()) });
    }
  }
  return events;
}

const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(root, 'server', 'index.js')], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    AI_STUDIO_HOST: '127.0.0.1',
    AI_STUDIO_DB: dbPath,
    AI_STUDIO_QUIET: '1',
    AI_STUDIO_ALLOW_MOCK: '1',
    // Never let a developer's real keys be used (or spent) by the test run.
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    GEMINI_API_KEY: '',
    OLLAMA_ENABLED: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
child.stdout.on('data', (data) => { serverLog += data.toString(); });
child.stderr.on('data', (data) => { serverLog += data.toString(); });

const cleanup = () => {
  if (!child.killed) child.kill('SIGTERM');
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
};

try {
  console.log(`\nAI Studio OS — self test (port ${port})\n`);

  const up = await waitForServer();
  if (!up) {
    console.error('Server did not start. Log:\n' + serverLog);
    cleanup();
    process.exit(1);
  }

  // --- Static shell --------------------------------------------------------
  console.log('Static app');
  const page = await fetch(`${base}/`);
  const pageHtml = await page.text();
  check('GET / serves the app shell', page.status === 200 && pageHtml.includes('AI Studio OS'));
  const css = await fetch(`${base}/styles.css`);
  check('GET /styles.css is stylesheet', css.status === 200 && (css.headers.get('content-type') || '').includes('text/css'));
  const js = await fetch(`${base}/app.js`);
  check('GET /app.js is javascript', js.status === 200 && (js.headers.get('content-type') || '').includes('javascript'));
  check('Server source is not exposed', (await fetch(`${base}/server/index.js`)).status === 404);
  check('.env is not exposed', (await fetch(`${base}/.env`)).status === 404);

  // --- Bootstrap -----------------------------------------------------------
  console.log('\nBootstrap');
  const boot = await (await fetch(`${base}/api/bootstrap`)).json();
  check('Seeded projects load', boot.projects?.length >= 6, `got ${boot.projects?.length}`);
  check('Demo mode reported when no keys exist', boot.mode === 'demo');
  check('Providers are described', boot.providers?.length === 5);
  check('Model catalogue resolves', boot.models?.length >= 8, `got ${boot.models?.length}`);
  check('Demo models are marked', boot.models?.some((model) => model.isDemo && model.selectable));
  check('Prompt library loads', boot.prompts?.length >= 6);
  check('Automations load', boot.automations?.length >= 3);
  check('Capabilities are declared', boot.capabilities?.persistence === 'sqlite');

  // --- Streaming generation ------------------------------------------------
  console.log('\nGeneration stream (demo engine)');
  const prompt = 'A quiet launch film for a hand-poured candle studio, warm ochre light, no people on camera.';
  const streamResponse = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, model: 'Studio demo engine', mode: 'Writing', title: 'Selftest — candle studio' }),
  });
  check('POST /api/generate streams event-stream', (streamResponse.headers.get('content-type') || '').includes('text/event-stream'));
  const events = await readStream(streamResponse);
  const start = events.find((item) => item.event === 'start');
  const text = events.filter((item) => item.event === 'delta').map((item) => item.data.text).join('');
  const done = events.find((item) => item.event === 'done');
  check('Stream announces the model', Boolean(start?.data.modelLabel) && start?.data.provider === 'mock');
  check('Stream delivers text', text.length > 120, `${text.length} chars`);
  check('Stream reports usage', events.some((item) => item.event === 'usage'));
  check('Stream finishes cleanly', Boolean(done) && done.data.failed === false);
  check('Generation was persisted', Boolean(done?.data?.generation?.id) && done.data.generation.status === 'succeeded');
  check('Project was created and credited with the output', done?.data?.project?.outputs >= 1);
  check('Credits were accounted', done?.data?.usage?.totals?.generations >= 1);

  const generationId = done?.data?.generation?.id;
  const projectId = done?.data?.project?.id;
  const single = await (await fetch(`${base}/api/generations/${generationId}`)).json();
  check('GET /api/generations/:id returns the record', single.generation?.id === generationId && single.generation.output.length > 100);

  // --- Projects ------------------------------------------------------------
  console.log('\nProjects');
  const projectDetail = await (await fetch(`${base}/api/projects/${projectId}`)).json();
  check('Project detail lists its generations', projectDetail.generations?.some((item) => item.id === generationId));
  const created = await (await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Selftest project', type: 'Campaign', model: 'Auto select' }),
  })).json();
  check('POST /api/projects creates a project', created.project?.id?.startsWith('p-'));
  const patched = await (await fetch(`${base}/api/projects/${created.project.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'In review' }),
  })).json();
  check('PATCH /api/projects/:id updates status', patched.project?.status === 'In review');
  const duplicated = await (await fetch(`${base}/api/projects/${created.project.id}/duplicate`, { method: 'POST' })).json();
  check('POST /api/projects/:id/duplicate copies the project', duplicated.project?.title?.includes('(copy)'));
  const archived = await (await fetch(`${base}/api/projects/${created.project.id}`, { method: 'DELETE' })).json();
  check('DELETE /api/projects/:id archives', archived.archived === true && !archived.projects.some((item) => item.id === created.project.id));

  // --- Prompts -------------------------------------------------------------
  console.log('\nPrompt library');
  const used = await (await fetch(`${base}/api/prompts/p-brand/use`, { method: 'POST' })).json();
  check('POST /api/prompts/:id/use increments uses', used.prompt?.uses >= 2401);
  const newPrompt = await (await fetch(`${base}/api/prompts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Selftest prompt', body: 'Write a considered product story for [product].' }),
  })).json();
  check('POST /api/prompts saves a prompt', newPrompt.prompt?.title === 'Selftest prompt');

  // --- Automations ---------------------------------------------------------
  console.log('\nAutomations');
  const run = await (await fetch(`${base}/api/automations/a-digest/run`, { method: 'POST' })).json();
  check('POST /api/automations/:id/run generates output', run.status === 'succeeded' && run.output?.length > 40);
  check('Automation run is recorded', run.automation?.lastRun && run.automation.lastRun !== 'Not run yet');
  const runs = await (await fetch(`${base}/api/automations/a-digest/runs`)).json();
  check('GET /api/automations/:id/runs lists history', runs.runs?.length >= 1);
  const skipped = await (await fetch(`${base}/api/automations/a-archive/run`, { method: 'POST' })).json();
  check('Non-generation chore reports honestly', skipped.status === 'skipped' && /scheduler/i.test(skipped.message));

  // --- Usage, settings, errors --------------------------------------------
  console.log('\nUsage, settings, errors');
  const usage = await (await fetch(`${base}/api/usage`)).json();
  check('Usage totals add up', usage.totals.generations >= 2 && usage.plan.creditsIncluded === 10000);
  check('Usage has a seven-day series', usage.daily?.length === 7);
  check('Usage lists recent generations', usage.recent?.length >= 1);
  const saved = await (await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Selftest User', workspace: 'Selftest Studio' }),
  })).json();
  check('PUT /api/settings persists', saved.settings?.name === 'Selftest User' && saved.settings?.workspace === 'Selftest Studio');

  const badModel = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'test', model: 'Claude Sonnet' }),
  });
  const badEvents = await readStream(badModel);
  const badError = badEvents.find((item) => item.event === 'error');
  check('Unconfigured provider fails with guidance', /not connected/i.test(badError?.data?.message || ''), badError?.data?.message);

  const emptyPrompt = await fetch(`${base}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: '' }),
  });
  check('Empty prompt is rejected', emptyPrompt.status === 400);
  const notFound = await fetch(`${base}/api/generations/does-not-exist`);
  check('Unknown generation returns 404 JSON', notFound.status === 404 && (notFound.headers.get('content-type') || '').includes('json'));
  const badJson = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  check('Malformed JSON returns 400', badJson.status === 400);
  const badMethod = await fetch(`${base}/api/health`, { method: 'DELETE' });
  check('Unknown route/method returns JSON error', badMethod.status >= 400 && (badMethod.headers.get('content-type') || '').includes('json'));
} catch (error) {
  failures.push(`Unexpected error: ${error.message}`);
  console.error('\nUnexpected error:\n', error);
} finally {
  cleanup();
}

const total = passed + failures.length;
console.log(`\n${failures.length ? '✗' : '✓'} ${passed}/${total} checks passed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('Ready to run: npm start\n');
