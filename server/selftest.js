import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createFakeS3 } from './fixtures/fake-s3.js';
import { isTransient, normalizeSteps } from './automations.js';
import { archiveName, crc32 } from './zip.js';
import { createWebhookSender, privateReason } from './webhook.js';

/**
 * End-to-end self test.
 *
 * Boots the real server against a throwaway SQLite file, then drives the API the
 * way the browser does — including cookie sessions, the full account and invite
 * flow, role enforcement, workspace isolation, and reading complete SSE
 * generation streams. Run with `npm test`. Requires no network access and no
 * provider keys: the demo engine covers the generation path.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-selftest-'));
const dbPath = path.join(tmpDir, 'selftest.db');
const uploadDir = path.join(tmpDir, 'uploads');
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

async function waitForServer(target = base, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${target}/api/health`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

/** Polls until `predicate` returns a truthy value, or gives up. */
/**
 * Reads a zip back through its own central directory. Written here rather than
 * trusting the writer: entry names, sizes, offsets, and checksums are all read
 * from the bytes a downloader would receive.
 */
function readZipDirectory(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) return [];
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) break;
    const crc = buffer.readUInt32LE(cursor + 16);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.slice(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const localName = buffer.readUInt16LE(localOffset + 26);
    const localExtra = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    entries.push({ name, crc, size, data: buffer.slice(start, start + size) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function waitUntil(predicate, { timeoutMs = 6000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

/**
 * A cookie-aware client. Node's fetch has no cookie jar, so each actor in the
 * test (owner, editor, viewer, a hostile site) keeps its own and sends it
 * explicitly — which is exactly what a browser would do.
 */
function createClient(target = base, label = 'client') {
  const jar = new Map();
  const cookieHeader = () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');

  function absorb(response) {
    const lines = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    for (const line of lines) {
      const [pair] = String(line).split(';');
      const index = pair.indexOf('=');
      if (index < 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value) jar.set(name, value);
      else jar.delete(name);
    }
  }

  async function request(path_, { method = 'GET', body, rawBody, headers = {}, form, originHeader, token, raw = false, redirect } = {}) {
    const requestHeaders = { ...headers };
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (originHeader) requestHeaders.Origin = originHeader;
    if (token) requestHeaders.Authorization = `Bearer ${token}`;
    const cookie = cookieHeader();
    if (cookie && !token) requestHeaders.Cookie = cookie;

    const response = await fetch(`${target}${path_}`, {
      method,
      headers: requestHeaders,
      body: form || rawBody || (body !== undefined ? JSON.stringify(body) : undefined),
      ...(redirect ? { redirect } : {}),
    });
    absorb(response);
    if (raw) return response;
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: response.status, body: parsed, text, headers: response.headers };
  }

  return {
    label,
    jar,
    cookieHeader,
    request,
    get: (path_, options) => request(path_, { ...options, method: 'GET' }),
    post: (path_, body, options) => request(path_, { ...options, method: 'POST', body }),
    patch: (path_, body, options) => request(path_, { ...options, method: 'PATCH', body }),
    put: (path_, body, options) => request(path_, { ...options, method: 'PUT', body }),
    del: (path_, body, options) => request(path_, { ...options, method: 'DELETE', body }),
    /** Reads an SSE response into a list of `{ event, data }` records. */
    async stream(path_, body, options = {}) {
      const response = await request(path_, { ...options, method: 'POST', body, raw: true });
      return readStream(response);
    },
  };
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

function startServer({ dbFile, uploadPath, serverPort, extraEnv = {} }) {
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(root, 'server', 'index.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(serverPort),
      AI_STUDIO_HOST: '127.0.0.1',
      AI_STUDIO_DB: dbFile,
      AI_STUDIO_UPLOADS: uploadPath,
      AI_STUDIO_QUIET: '1',
      AI_STUDIO_ALLOW_MOCK: '1',
      // A fast tick keeps the scheduler observable inside a normal test run.
      AI_STUDIO_SCHEDULER_TICK_MS: '300',
      AI_STUDIO_SCHEDULER_BACKOFF_MS: '1000',
      AI_STUDIO_LOGIN_MAX_ATTEMPTS: '4',
      ...extraEnv,
      // Never let a developer's real keys be used (or spent) by the test run.
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: '',
      OLLAMA_ENABLED: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.log = '';
  child.stdout.on('data', (data) => { child.log += data.toString(); });
  child.stderr.on('data', (data) => { child.log += data.toString(); });
  return child;
}

const child = startServer({
  dbFile: dbPath,
  uploadPath: uploadDir,
  serverPort: port,
  // Webhooks are off unless an operator names a host. The test server names the
  // loopback address so a local receiver can be called — exactly what an
  // operator running a sidecar would do.
  extraEnv: { AI_STUDIO_WEBHOOK_ALLOW: '127.0.0.1' },
});

const cleanup = () => {
  if (!child.killed) child.kill('SIGTERM');
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
};

try {
  console.log(`\nAI Studio OS — self test (port ${port})\n`);

  const up = await waitForServer();
  if (!up) {
    console.error('Server did not start. Log:\n' + child.log);
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

  // --- Signed out ----------------------------------------------------------
  console.log('\nSigned out');
  const owner = createClient(base, 'owner');
  const anon = createClient(base, 'anon');
  const session = await anon.get('/api/auth/session');
  check('Session endpoint answers without a cookie', session.status === 200 && session.body.authenticated === false);
  check('First run is reported', session.body.firstRun === true);
  check('The seeded workspace is offered as claimable', session.body.claimable?.length === 1 && session.body.claimable[0].name, JSON.stringify(session.body.claimable));
  check('Workspace data is refused when signed out', (await anon.get('/api/bootstrap')).status === 401);
  check('Projects are refused when signed out', (await anon.get('/api/projects')).status === 401);

  // --- Sign up -------------------------------------------------------------
  console.log('\nAccounts');
  const weak = await anon.post('/api/auth/signup', { email: 'short@example.com', name: 'Short', password: 'tiny' });
  check('Weak passwords are rejected with a reason', weak.status === 400 && /8 characters/.test(weak.body?.error?.message || ''));
  const badEmail = await anon.post('/api/auth/signup', { email: 'not-an-email', name: 'Nope', password: 'long-enough-1' });
  check('Malformed emails are rejected', badEmail.status === 400 && badEmail.body?.error?.code === 'invalid_email');

  const signup = await owner.post('/api/auth/signup', { email: 'Owner@Example.com', name: 'Studio Owner', password: 'studio-pass-1' });
  check('POST /api/auth/signup creates the first account', signup.status === 201 && signup.body.user?.email === 'owner@example.com', JSON.stringify(signup.body).slice(0, 120));
  check('Email is normalised to lowercase', signup.body.user?.email === 'owner@example.com');
  check('The first account claims the seeded workspace', signup.body.claimed === true && signup.body.workspace?.role === 'owner');
  const setCookie = signup.headers.getSetCookie?.() || [signup.headers.get('set-cookie')];
  const sessionCookie = String(setCookie[0] || '');
  check('Session cookie is HttpOnly and SameSite', /HttpOnly/i.test(sessionCookie) && /SameSite=Lax/i.test(sessionCookie), sessionCookie.split(';').slice(1).join(';').trim());
  check('A duplicate signup is refused', (await anon.post('/api/auth/signup', { email: 'owner@example.com', name: 'Imposter', password: 'long-enough-1' })).status === 409);

  const boot = (await owner.get('/api/bootstrap')).body;
  check('Bootstrap identifies the caller and their role', boot.user?.name === 'Studio Owner' && boot.role === 'owner');
  check('Seeded projects load', boot.projects?.length >= 6, `got ${boot.projects?.length}`);
  check('Demo mode reported when no keys exist', boot.mode === 'demo');
  check('Providers are described', boot.providers?.length === 5);
  check('Model catalogue resolves', boot.models?.length >= 8, `got ${boot.models?.length}`);
  check('Demo models are marked', boot.models?.some((model) => model.isDemo && model.selectable));
  check('Prompt library loads', boot.prompts?.length >= 6);
  check('Automations load with schedules', boot.automations?.length >= 3 && boot.automations.every((automation) => automation.schedule?.type));
  check('Every scheduled automation has a next run', boot.automations.filter((automation) => ['interval', 'daily', 'monthly'].includes(automation.schedule?.type)).every((automation) => automation.nextRunAt));
  check('Scheduler reports its state', boot.scheduler?.enabled === true && boot.scheduler.tickMs === 300);
  check('Capabilities are declared', boot.capabilities?.persistence === 'sqlite');
  check('File uploads are advertised', boot.capabilities?.fileUploads === true && boot.capabilities?.scheduling === true);
  check('Accounts and teams are advertised', boot.capabilities?.accounts === true && boot.capabilities?.roles?.length === 4);
  check('The workspace lists its members', boot.members?.length === 1 && boot.members[0].role === 'owner');
  const afterClaim = await anon.get('/api/auth/session');
  check('Claiming a workspace leaves nothing else claimable', afterClaim.body.firstRun === false && (afterClaim.body.claimable || []).length === 0, JSON.stringify(afterClaim.body.claimable));

  const signIn = createClient(base, 'sign-in');
  const badLogin = await signIn.post('/api/auth/login', { email: 'owner@example.com', password: 'wrong-password' });
  check('A wrong password is refused', badLogin.status === 401);
  const unknownLogin = await signIn.post('/api/auth/login', { email: 'nobody@example.com', password: 'wrong-password' });
  check('An unknown email answers identically (no account enumeration)',
    unknownLogin.status === 401 && unknownLogin.body?.error?.message === badLogin.body?.error?.message);

  const login = await signIn.post('/api/auth/login', { email: 'owner@example.com', password: 'studio-pass-1' });
  check('POST /api/auth/login issues a session', login.status === 200 && login.body.user?.name === 'Studio Owner');
  check('Health stays public for probes', (await anon.get('/api/health')).status === 200);
  const rawToken = String((login.headers.getSetCookie?.() || [])[0] || '').split('=')[1]?.split(';')[0] || '';
  const scripted = createClient(base, 'script');
  const scriptedSession = await scripted.request('/api/auth/session', { token: rawToken });
  check('The session token also works as a bearer token', scriptedSession.body?.authenticated === true);
  check('A bogus bearer token is ignored', (await scripted.request('/api/auth/session', { token: 'not-a-real-token' })).body?.authenticated === false);

  // --- Streaming generation ------------------------------------------------
  console.log('\nGeneration stream (demo engine)');
  const prompt = 'A quiet launch film for a hand-poured candle studio, warm ochre light, no people on camera.';
  const events = await owner.stream('/api/generate', { prompt, model: 'Studio demo engine', mode: 'Writing', title: 'Selftest — candle studio' });
  const start = events.find((item) => item.event === 'start');
  const text = events.filter((item) => item.event === 'delta').map((item) => item.data.text).join('');
  const done = events.find((item) => item.event === 'done');
  check('POST /api/generate streams event-stream', events.length > 5 && Boolean(start));
  check('Stream announces the model', Boolean(start?.data.modelLabel) && start?.data.provider === 'mock');
  check('Stream delivers text', text.length > 120, `${text.length} chars`);
  check('Stream reports usage', events.some((item) => item.event === 'usage'));
  check('Stream finishes cleanly', Boolean(done) && done.data.failed === false);
  check('Generation was persisted', Boolean(done?.data?.generation?.id) && done.data.generation.status === 'succeeded');
  check('Project was created and credited with the output', done?.data?.project?.outputs >= 1);
  check('Credits were accounted', done?.data?.usage?.totals?.generations >= 1);

  const generationId = done?.data?.generation?.id;
  const projectId = done?.data?.project?.id;
  const single = await owner.get(`/api/generations/${generationId}`);
  check('GET /api/generations/:id returns the record', single.body.generation?.id === generationId && single.body.generation.output.length > 100);

  const anonStream = await anon.request('/api/generate', { method: 'POST', body: { prompt: 'Should not run', mode: 'Writing' }, raw: true });
  check('Anonymous generation is refused', anonStream.status === 401, `got ${anonStream.status}`);

  // --- Projects ------------------------------------------------------------
  console.log('\nProjects');
  const projectDetail = await owner.get(`/api/projects/${projectId}`);
  check('Project detail lists its generations', projectDetail.body.generations?.some((item) => item.id === generationId));
  const created = await owner.post('/api/projects', { title: 'Selftest project', type: 'Campaign', model: 'Auto select' });
  check('POST /api/projects creates a project', created.body.project?.id?.startsWith('p-'));
  const patched = await owner.patch(`/api/projects/${created.body.project.id}`, { status: 'In review' });
  check('PATCH /api/projects/:id updates status', patched.body.project?.status === 'In review');
  const duplicated = await owner.post(`/api/projects/${created.body.project.id}/duplicate`);
  check('POST /api/projects/:id/duplicate copies the project', duplicated.body.project?.title?.includes('(copy)'));
  const archived = await owner.del(`/api/projects/${created.body.project.id}`);
  check('DELETE /api/projects/:id archives', archived.body.archived === true && !archived.body.projects.some((item) => item.id === created.body.project.id));

  // --- Prompts -------------------------------------------------------------
  console.log('\nPrompt library');
  const used = await owner.post('/api/prompts/p-brand/use');
  check('POST /api/prompts/:id/use increments uses', used.body.prompt?.uses >= 2401);
  const newPrompt = await owner.post('/api/prompts', { title: 'Selftest prompt', body: 'Write a considered product story for [product].' });
  check('POST /api/prompts saves a prompt', newPrompt.body.prompt?.title === 'Selftest prompt');

  // --- Automations ---------------------------------------------------------
  console.log('\nAutomations');
  const run = await owner.post('/api/automations/a-digest/run');
  check('POST /api/automations/:id/run generates output', run.body.status === 'succeeded' && run.body.output?.length > 40);
  check('Automation run is recorded', run.body.automation?.lastRun && run.body.automation.lastRun !== 'Not run yet');
  check('Manual runs push the next run forward', run.body.automation?.nextRunAt && new Date(run.body.automation.nextRunAt) > new Date());
  const runs = await owner.get('/api/automations/a-digest/runs');
  check('GET /api/automations/:id/runs lists history', runs.body.runs?.length >= 1);
  const tidied = await owner.post('/api/automations/a-archive/run');
  check('A workspace chore now runs instead of reporting a gap', ['succeeded', 'skipped'].includes(tidied.body.status) && /tidy|archive|project/i.test(tidied.body.message), JSON.stringify(tidied.body).slice(0, 140));
  check('The chore records its step in the run log', tidied.body.steps?.length === 1 && tidied.body.steps[0].action === 'tidy', JSON.stringify(tidied.body.steps));
  check('The run history carries steps, not just a status', run.body.steps?.[0]?.action === 'generate' && run.body.steps[0].status === 'succeeded', JSON.stringify(run.body.steps));
  const digestRuns = await owner.get('/api/automations/a-digest/runs');
  check('A stored run keeps its step chain', digestRuns.body.runs?.[0]?.steps?.[0]?.action === 'generate', JSON.stringify(digestRuns.body.runs?.[0]?.steps));
  check('A run reports how long its steps took', digestRuns.body.runs?.[0]?.durationMs >= 0 && digestRuns.body.runs[0].status === 'succeeded');

  // --- Reference files -----------------------------------------------------
  console.log('\nFiles and references');
  const uploadForm = new FormData();
  uploadForm.append('files', new Blob(['Studio brief. Target: a ceramics studio.\nAvoid: glossy gradients.\n'], { type: 'text/plain' }), 'brief.txt');
  uploadForm.append('files', new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#c9b8a8"/></svg>'], { type: 'image/svg+xml' }), 'swatch.svg');
  const uploaded = await owner.request('/api/files', { method: 'POST', form: uploadForm });
  check('POST /api/files stores uploads', uploaded.body.files?.length === 2 && uploaded.body.files.every((file) => file.id && file.size > 0), JSON.stringify(uploaded.body).slice(0, 120));
  const [textFile, imageFile] = uploaded.body.files;
  const served = await owner.request(`/api/files/${imageFile.id}`, { raw: true });
  check('GET /api/files/:id serves bytes', served.status === 200 && (served.headers.get('content-type') || '').includes('svg'));
  check('Uploads are listed for the workspace', (await owner.get('/api/files')).body.files?.length === 2);

  const refEvents = await owner.stream('/api/generate', { prompt: 'Write the hero line for this brief.', mode: 'Writing', title: 'Selftest — references', fileIds: [textFile.id, imageFile.id] });
  const refMeta = refEvents.find((item) => item.event === 'meta');
  const refStart = refEvents.find((item) => item.event === 'start');
  const refText = refEvents.filter((item) => item.event === 'delta').map((item) => item.data.text).join('');
  check('Generation echoes the attached files', refMeta?.data.references?.length === 2);
  check('Images are marked as vision input', refStart?.data.imagesSent === 1);
  check('Text references reach the prompt', refText.includes('ceramics studio'), refText.slice(0, 80));

  // --- Generated assets are files -----------------------------------------
  console.log('\nGenerated assets');
  const imageEvents = await owner.stream('/api/generate', { prompt: 'A warm still life with a ceramic cup.', mode: 'Image', title: 'Selftest — asset' });
  const imageDone = imageEvents.find((item) => item.event === 'done')?.data;
  check('Image output is stored as a file', imageDone?.generation?.assetUrl?.startsWith('/api/files/'), imageDone?.generation?.assetUrl);
  check('Asset metadata comes back with the generation', Boolean(imageDone?.generation?.assetFile?.size));
  const assetResponse = await owner.request(imageDone.generation.assetUrl, { raw: true });
  check('Stored asset downloads', assetResponse.status === 200 && Number(assetResponse.headers.get('content-length')) > 100);

  check('DELETE /api/files/:id removes an upload', (await owner.del(`/api/files/${textFile.id}`)).status === 200 && (await owner.get(`/api/files/${textFile.id}`)).status === 404);

  // --- Event triggers ------------------------------------------------------
  console.log('\nEvent triggers');
  const project = boot.projects[0];
  await owner.patch(`/api/projects/${project.id}`, { status: 'In review' });
  const eventRun = await waitUntil(async () => {
    const body = await owner.get('/api/automations/a-review/runs');
    const latest = body.body.runs?.[0];
    // A run is visible the moment it starts, so wait for it to finish.
    return latest && latest.status !== 'running' ? latest : null;
  });
  check('Status change fires the matching automation', eventRun?.status === 'succeeded', eventRun ? `${eventRun.status} · ${eventRun.note}` : 'no run recorded');
  check('Event run produced a generation', Boolean(eventRun?.generation?.id));
  check('The event run recorded its generate step', eventRun?.steps?.[0]?.action === 'generate' && eventRun.steps[0].status === 'succeeded', JSON.stringify(eventRun?.steps));

  // --- Scheduler -----------------------------------------------------------
  console.log('\nScheduler');
  const heartbeat = await owner.post('/api/automations', { name: 'Selftest heartbeat', action: 'Curate & summarize', schedule: { type: 'interval', everyMinutes: 0.1 } });
  check('POST /api/automations accepts a schedule', heartbeat.body.automation?.schedule?.type === 'interval' && heartbeat.body.automation.nextRunAt);
  const scheduledRun = await waitUntil(async () => {
    const body = await owner.get(`/api/automations/${heartbeat.body.automation.id}/runs`);
    const found = body.body.runs?.find((item) => String(item.note || '').startsWith('scheduled'));
    return found && found.status !== 'running' ? found : null;
  }, { timeoutMs: 8000 });
  check('The scheduler runs due workflows on its own', scheduledRun?.status === 'succeeded', scheduledRun ? `${scheduledRun.status}` : 'no finished scheduled run within 8s');
  const scheduler = await owner.get('/api/scheduler');
  check('Scheduler status counts runs', scheduler.body.counts?.runs >= 1 && scheduler.body.active === true);
  check('Scheduler reports the workspace timezone', Boolean(scheduler.body.timeZone));
  const badSchedule = await owner.post('/api/automations', { name: 'Too fast', schedule: { type: 'interval', everyMinutes: 0.001 } });
  check('A nonsense schedule is rejected', badSchedule.status === 400);

  // --- Automation steps ----------------------------------------------------
  console.log('\nAutomation steps');

  /** A local HTTP endpoint for webhook steps: records what it was sent. */
  const receiver = { requests: [], behaviour: 'ok', server: null, url: '' };
  receiver.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON */ }
      receiver.requests.push({ url: req.url, headers: req.headers, body: parsed, raw: Buffer.concat(chunks) });
      const attempt = receiver.requests.length;
      if (receiver.behaviour === 'fail-once' && attempt === 1) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        return res.end('collector is warming up');
      }
      if (receiver.behaviour === 'reject') {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end('{"error":"channel_not_found"}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => receiver.server.listen(0, '127.0.0.1', resolve));
  receiver.url = `http://127.0.0.1:${receiver.server.address().port}/hooks/studio`;

  // Validation: a chain has to be a chain of things this server can run.
  const unknownStep = await owner.post('/api/automations', { name: 'Nonsense', steps: [{ action: 'teleport' }], schedule: { type: 'manual' } });
  check('An unknown step is rejected at creation', unknownStep.status === 400 && unknownStep.body.error?.code === 'invalid_steps', JSON.stringify(unknownStep.body).slice(0, 120));
  const tooMany = await owner.post('/api/automations', {
    name: 'Too long', schedule: { type: 'manual' },
    steps: Array.from({ length: 6 }, () => ({ action: 'export' })),
  });
  check('A six-step chain is rejected', tooMany.status === 400, JSON.stringify(tooMany.body).slice(0, 120));
  const noUrl = await owner.post('/api/automations', { name: 'No url', steps: [{ action: 'webhook' }], schedule: { type: 'manual' } });
  check('A webhook step without a URL is rejected', noUrl.status === 400 && /URL/i.test(noUrl.body.error?.message || ''), JSON.stringify(noUrl.body).slice(0, 120));
  const legacyAction = await owner.post('/api/automations', { name: 'Legacy shape', action: 'Prepare a creative brief', schedule: { type: 'manual' } });
  check('The older action field still builds a chain', legacyAction.body.automation?.steps?.[0]?.action === 'generate', JSON.stringify(legacyAction.body.automation?.steps));
  const catalog = (await owner.get('/api/automations')).body.stepCatalog || [];
  check('The step catalogue is offered to the UI', catalog.length === 4 && catalog.find((entry) => entry.id === 'webhook')?.available === true, JSON.stringify(catalog.map((entry) => `${entry.id}:${entry.available}`)));

  // A three-step chain: generate, export as zip, then post the summary.
  receiver.behaviour = 'ok';
  const chain = await owner.post('/api/automations', {
    name: 'Brief, export, notify',
    schedule: { type: 'manual' },
    steps: [
      { action: 'generate' },
      { action: 'export', options: { format: 'zip' } },
      { action: 'webhook', options: { url: receiver.url, event: 'studio.handoff' } },
    ],
  });
  check('A three-step chain is stored', chain.body.automation?.steps?.length === 3, JSON.stringify(chain.body.automation?.steps));
  const chainRun = await owner.post(`/api/automations/${chain.body.automation.id}/run`);
  check('A three-step chain runs end to end', chainRun.body.status === 'succeeded' && chainRun.body.steps?.length === 3, JSON.stringify(chainRun.body.steps));
  check('Every step records what it did', chainRun.body.steps?.every((step) => step.status === 'succeeded' && step.message) === true, JSON.stringify(chainRun.body.steps?.map((step) => step.message)));
  check('The generate step produced a generation', Boolean(chainRun.body.steps?.[0]?.generationId));
  check('The export step produced a file', Boolean(chainRun.body.steps?.[1]?.fileId) && chainRun.body.files?.length === 1, JSON.stringify(chainRun.body.files));

  const exportedZip = await owner.request(`/api/files/${chainRun.body.steps[1].fileId}`, { raw: true });
  const zipBuffer = Buffer.from(await exportedZip.arrayBuffer());
  check('The zip export downloads as an archive', exportedZip.status === 200 && zipBuffer.slice(0, 2).toString() === 'PK', `${exportedZip.status} · ${zipBuffer.length} bytes`);
  // Read the archive back through its own central directory, and check every
  // entry's checksum — an export that only *looks* like a zip is not an export.
  const zipEntries = readZipDirectory(zipBuffer);
  check('The zip lists its entries', zipEntries.length >= 2 && zipEntries.some((entry) => entry.name === 'brief.md'), JSON.stringify(zipEntries.map((entry) => entry.name)));
  check('Every zip entry matches its recorded checksum', zipEntries.every((entry) => crc32(entry.data) === entry.crc), JSON.stringify(zipEntries.map((entry) => `${entry.name}:${crc32(entry.data) === entry.crc}`)));
  check('The zip keeps its folders', zipEntries.some((entry) => entry.name.startsWith('generations/')), JSON.stringify(zipEntries.map((entry) => entry.name)));
  check('Zip entry names cannot escape the archive', archiveName('../../etc/passwd') === 'etc/passwd' && archiveName('/etc/shadow') === 'etc/shadow' && archiveName('..') === 'file', `${archiveName('../../etc/passwd')} · ${archiveName('/etc/shadow')}`);
  const brief = zipEntries.find((entry) => entry.name === 'brief.md')?.data.toString('utf8') || '';
  check('The exported brief describes the project', brief.includes('# ') && brief.includes('## Brief') && brief.length > 200, brief.slice(0, 60));

  const webhookSent = receiver.requests.at(-1);
  check('The webhook step posted a run summary', webhookSent?.body?.event === 'studio.handoff' && webhookSent.body.automation?.name === 'Brief, export, notify', JSON.stringify(webhookSent?.body).slice(0, 140));
  check('The webhook payload carries the steps so far', Array.isArray(webhookSent?.body?.steps) && webhookSent.body.steps.length === 2, JSON.stringify(webhookSent?.body?.steps));
  check('The webhook payload names the workspace', Boolean(webhookSent?.body?.workspace?.id && webhookSent.body.workspace.name), JSON.stringify(webhookSent?.body?.workspace));
  check('The webhook identifies itself as this server', String(webhookSent?.headers?.['user-agent'] || '').includes('AI-Studio-OS'));

  // A transient failure is retried with backoff; a rejection is not.
  receiver.requests.length = 0; // count only this scenario's calls
  receiver.behaviour = 'fail-once';
  const flakyRun = await owner.post(`/api/automations/${chain.body.automation.id}/run`);
  const flakyStep = flakyRun.body.steps?.at(-1);
  check('A transient webhook failure is retried', flakyRun.body.status === 'succeeded' && flakyStep?.attempts === 2, JSON.stringify(flakyStep));
  check('The retry reason is recorded on the step', /retried after/i.test(flakyStep?.message || ''), (flakyStep?.message || '').slice(0, 120));
  check('The receiver really was called twice', receiver.requests.length === 2, `${receiver.requests.length} calls`);

  receiver.requests.length = 0;
  receiver.behaviour = 'reject';
  const rejected = await owner.post(`/api/automations/${chain.body.automation.id}/run`);
  const rejectedStep = rejected.body.steps?.at(-1) || {};
  check('A rejected webhook fails the run', rejected.status === 502 && /400/.test(rejected.body.error?.message || ''), JSON.stringify(rejected.body.error).slice(0, 140));
  check('A rejection is not retried', rejectedStep.attempts === 1 && receiver.requests.length === 1, `${rejectedStep.attempts} attempts, ${receiver.requests.length} calls`);
  check('A failed run stops the chain instead of continuing', /failed/i.test(rejected.body.error?.message || ''));
  receiver.behaviour = 'ok';

  // Tidy: archive finished work, or say honestly that there is nothing to do.
  const tidy = await owner.post('/api/automations', {
    name: 'Tidy finished work',
    schedule: { type: 'manual' },
    steps: [{ action: 'tidy', options: { afterDays: 1, statuses: ['Completed'] } }],
  });
  const tidyRun = await owner.post(`/api/automations/${tidy.body.automation.id}/run`);
  check('A tidy step archives finished work', tidyRun.body.status === 'succeeded' && /Archived 1 project/.test(tidyRun.body.message), tidyRun.body.message);
  const projectsAfterTidy = (await owner.get('/api/projects')).body.projects.map((project) => project.title);
  check('The archived project left the active list', !projectsAfterTidy.includes('Soundscape for slow mornings') && projectsAfterTidy.includes('Aurora — skincare launch film'), JSON.stringify(projectsAfterTidy).slice(0, 160));
  const dryRun = await owner.post('/api/automations', {
    name: 'Tidy rehearsal',
    schedule: { type: 'manual' },
    steps: [{ action: 'tidy', options: { afterDays: 1, statuses: ['Completed'], dryRun: true } }],
  });
  const dryRunResult = await owner.post(`/api/automations/${dryRun.body.automation.id}/run`);
  check('A tidy step with nothing left says so', ['skipped', 'succeeded'].includes(dryRunResult.body.status) && /nothing to tidy|would archive/i.test(dryRunResult.body.message), dryRunResult.body.message);

  // Per-automation time zone: 9am means 9am in Kolkata, not on the server.
  const zoned = await owner.post('/api/automations', { name: 'Kolkata digest', schedule: { type: 'daily', time: '09:00' }, timeZone: 'Asia/Kolkata', action: 'Curate & summarize' });
  const zonedHour = zoned.body.automation?.nextRunAt
    ? Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(new Date(zoned.body.automation.nextRunAt)))
    : -1;
  check('An automation can carry its own time zone', zoned.body.automation?.timeZone === 'Asia/Kolkata' && zonedHour === 9, `${zoned.body.automation?.timeZone} · hour ${zonedHour} · ${zoned.body.automation?.nextRunAt}`);
  const rezoned = await owner.patch(`/api/automations/${zoned.body.automation.id}`, { timeZone: 'Europe/Berlin' });
  check('The time zone can be changed later', rezoned.body.automation?.timeZone === 'Europe/Berlin', rezoned.body.automation?.timeZone);
  check('Changing the zone moves the next run', rezoned.body.automation?.nextRunAt !== zoned.body.automation?.nextRunAt);

  // The run log: every run in the workspace, with its steps.
  const log = await owner.get('/api/automation-runs?limit=20');
  check('The run log lists recent runs across workflows', log.body.runs?.length >= 4 && log.body.runs.every((item) => item.automationName), JSON.stringify(log.body.runs?.map((item) => item.automationName)).slice(0, 120));
  check('A logged run carries its steps', log.body.runs.some((item) => item.steps?.length === 3));
  check('The run log shows why a run failed', log.body.runs.some((item) => item.status === 'failed' && /400/.test(item.failedStep?.message || '')), JSON.stringify(log.body.runs.find((item) => item.status === 'failed')?.failedStep?.message));
  check('A finished run reports its duration', log.body.runs.filter((item) => item.status === 'succeeded').every((item) => Number.isFinite(item.durationMs)));

  // Retry classification, pinned so a change in wording cannot silently
  // turn every failure into a retry (or none into one).
  check('A rate limit is worth retrying', isTransient({ status: 429, message: 'slow down' }) && isTransient({ message: 'socket hang up' }) && isTransient({ retryable: true, message: 'nope' }));
  check('A bad request is not', !isTransient({ status: 400, message: 'bad prompt' }) && !isTransient({ status: 401, message: 'no key' }));
  check('Steps are normalised from the old action names', normalizeSteps({ action: 'Organize projects' }).steps[0]?.action === 'tidy' && normalizeSteps({ action: 'Curate & summarize' }).steps[0]?.action === 'generate');

  // The webhook guard, with DNS stubbed so the test is hermetic.
  const publicLookup = async () => [{ address: '93.184.216.34' }];
  const internalLookup = async () => [{ address: '10.4.0.9' }];
  const guarded = createWebhookSender({ allow: ['*.example.com'], lookup: publicLookup });
  const internal = createWebhookSender({ allow: ['*.example.com'], lookup: internalLookup });
  const exact = createWebhookSender({ allow: ['127.0.0.1'], lookup: publicLookup });
  const none = createWebhookSender({ allow: [] });
  const allowed = await guarded.assert('https://hooks.example.com/x').then(() => true).catch(() => false);
  const refusedInternal = await internal.assert('https://hooks.example.com/x').then(() => null).catch((error) => error.code);
  const refusedMetadata = await none.assert('http://169.254.169.254/latest/meta-data/').then(() => null).catch((error) => error.code);
  const refusedOffList = await guarded.assert('https://evil.test/x').then(() => null).catch((error) => error.code);
  const refusedScheme = await guarded.assert('file:///etc/passwd').then(() => null).catch((error) => error.code);
  check('An allowed public host passes the guard', allowed);
  check('A wildcard may not reach a private address', refusedInternal === 'webhook_private_address', String(refusedInternal));
  check('Metadata addresses are refused when webhooks are off', refusedMetadata === 'webhook_disabled', String(refusedMetadata));
  check('A host that is not allow-listed is refused', refusedOffList === 'webhook_not_allowed', String(refusedOffList));
  check('Only http and https are allowed', refusedScheme === 'webhook_protocol', String(refusedScheme));
  check('An exact allow-list entry may be local', await exact.assert('http://127.0.0.1:9000/hook').then(() => true).catch(() => false));
  check('Private ranges are recognised', privateReason('10.0.0.1') && privateReason('192.168.1.5') && privateReason('::1') && !privateReason('93.184.216.34'));

  await new Promise((resolve) => receiver.server.close(resolve));

  // --- Teams, roles, invites ----------------------------------------------
  console.log('\nTeams and roles');
  const invite = await owner.post('/api/invites', { email: 'editor@example.com', role: 'editor' });
  check('POST /api/invites creates an invite', invite.status === 201 && invite.body.invite?.status === 'pending' && invite.body.acceptUrl?.includes('invite='));
  const inviteToken = String(invite.body.acceptUrl).split('invite=')[1];

  const described = await anon.get(`/api/invites/${inviteToken}`);
  check('An invite can be described before sign-in', described.status === 200 && described.body.workspace?.name && described.body.invite?.role === 'editor');
  check('An unknown invite token is a clean 404', (await anon.get('/api/invites/nope')).status === 404);
  check('Accepting a bad token is refused', (await anon.post('/api/invites/nope/accept', { name: 'X', password: 'long-enough-1' })).status === 404);

  const editor = createClient(base, 'editor');
  const accepted = await editor.post(`/api/invites/${inviteToken}/accept`, { name: 'Ed Editor', password: 'editor-pass-1' });
  check('POST /api/invites/:token/accept joins the workspace', accepted.status === 200 && accepted.body.workspace?.role === 'editor');
  check('The invitee gets a working session', (await editor.get('/api/bootstrap')).status === 200);
  const editorBoot = (await editor.get('/api/bootstrap')).body;
  check('The editor sees the same workspace', editorBoot.workspace.id === boot.workspace.id && editorBoot.role === 'editor');
  check('The editor sees both members', editorBoot.members?.length === 2);
  check('The invite is used up', (await anon.get(`/api/invites/${inviteToken}`)).status === 404);
  check('Re-using the same invite is refused', (await anon.post(`/api/invites/${inviteToken}/accept`, { name: 'X', password: 'long-enough-1' })).status === 404);

  check('An editor can create work', (await editor.post('/api/projects', { title: 'Editor project' })).status === 201);
  const editorInvite = await editor.post('/api/invites', { email: 'viewer@example.com', role: 'viewer' });
  check('An editor cannot invite people', editorInvite.status === 403 && editorInvite.body?.error?.code === 'forbidden');
  const editorPromote = await editor.patch(`/api/members/${boot.user.id}`, { role: 'viewer' });
  check('An editor cannot change roles', editorPromote.status === 403);

  const viewerInvite = await owner.post('/api/invites', { email: 'viewer@example.com', role: 'viewer' });
  check('An owner can invite a viewer', viewerInvite.status === 201 && viewerInvite.body.invite?.role === 'viewer');
  check('Inviting an existing member is refused', (await owner.post('/api/invites', { email: 'editor@example.com', role: 'viewer' })).status === 409);
  const demoteOwner = await owner.patch(`/api/members/${boot.user.id}`, { role: 'admin' });
  check('The owner role cannot be edited, only transferred', demoteOwner.status === 403 && /owner/i.test(demoteOwner.body?.error?.message || ''), JSON.stringify(demoteOwner.body?.error).slice(0, 120));

  const viewerToken = String(viewerInvite.body.acceptUrl).split('invite=')[1];
  const viewer = createClient(base, 'viewer');
  await viewer.post(`/api/invites/${viewerToken}/accept`, { name: 'Vi Viewer', password: 'viewer-pass-1' });
  const viewerProjects = await viewer.get('/api/projects');
  check('A viewer can read the workspace', viewerProjects.status === 200 && viewerProjects.body.projects?.length >= 6);
  const viewerWrite = await viewer.post('/api/projects', { title: 'Viewer project' });
  check('A viewer cannot create work', viewerWrite.status === 403 && /viewer/.test(viewerWrite.body?.error?.message || ''));
  check('A viewer cannot run an automation', (await viewer.post('/api/automations/a-digest/run')).status === 403);

  // Admin powers, checked from the admin's own session.
  const adminInvite = await owner.post('/api/invites', { email: 'admin@example.com', role: 'admin' });
  check('An owner can invite an admin', adminInvite.status === 201 && adminInvite.body.invite?.role === 'admin');
  const admin = createClient(base, 'admin');
  await admin.post(`/api/invites/${String(adminInvite.body.acceptUrl).split('invite=')[1]}/accept`, { name: 'Ada Admin', password: 'admin-pass-1' });
  const adminInvitesEditor = await admin.post('/api/invites', { email: 'another@example.com', role: 'editor' });
  check('An admin can invite editors', adminInvitesEditor.status === 201);
  const adminInvitesAdmin = await admin.post('/api/invites', { email: 'another-admin@example.com', role: 'admin' });
  check('An admin cannot invite another admin',
    adminInvitesAdmin.status === 403 && adminInvitesAdmin.body?.error?.code === 'forbidden' && /owner/i.test(adminInvitesAdmin.body?.error?.hint || ''),
    `got ${adminInvitesAdmin.status} ${JSON.stringify(adminInvitesAdmin.body?.error || {}).slice(0, 110)}`);

  const editorId = editorBoot.user.id;
  const promoted = await owner.patch(`/api/members/${editorId}`, { role: 'admin' });
  check('An owner can promote a member', promoted.status === 200 && promoted.body.members.find((member) => member.userId === editorId)?.role === 'admin');
  const demoted = await owner.patch(`/api/members/${editorId}`, { role: 'editor' });
  check('An owner can demote them again', demoted.body.members.find((member) => member.userId === editorId)?.role === 'editor');
  check('Ownership cannot be assigned directly', (await owner.patch(`/api/members/${editorId}`, { role: 'owner' })).status === 400);
  const left = await editor.del('/api/members/' + editorId);
  check('A member can remove themselves', left.status === 200 && left.body.left === true);
  check('Their session is finished', (await editor.get('/api/bootstrap')).status === 401);
  check('The owner cannot leave', (await owner.del(`/api/members/${boot.user.id}`)).status === 403);

  // --- Handover and invite housekeeping ------------------------------------
  console.log('\nOwnership and invites');
  const outsider = createClient(base, 'outsider');
  const outsiderSignup = await outsider.post('/api/auth/signup', { email: 'outsider@example.com', name: 'Ola Outsider', password: 'outsider-pass-1' });
  check('A second account starts with its own workspace', outsiderSignup.status === 201 && outsiderSignup.body.workspace?.id !== boot.workspace.id);

  const outsiderInvite = await owner.post('/api/invites', { email: 'outsider@example.com', role: 'editor' });
  const outsiderAccept = await outsider.post(`/api/invites/${String(outsiderInvite.body.acceptUrl).split('invite=')[1]}/accept`, {});
  check('A signed-in account joins without re-entering a password', outsiderAccept.status === 200 && outsiderAccept.body.workspace.id === boot.workspace.id && outsiderAccept.body.user.name === 'Ola Outsider');
  check('The switch is reflected in their session', (await outsider.get('/api/bootstrap')).body.workspace.id === boot.workspace.id);

  const revoke = await owner.post('/api/invites', { email: 'ghost@example.com', role: 'viewer' });
  const revokeToken = String(revoke.body.acceptUrl).split('invite=')[1];
  const listed = await owner.get('/api/members');
  check('Pending invites are listed for managers', listed.body.invites?.some((item) => item.email === 'ghost@example.com') && listed.body.canManage === true);
  const revoked = await owner.del(`/api/invites/${revoke.body.invite.id}`);
  check('An invite can be revoked', revoked.status === 200 && (await anon.get(`/api/invites/${revokeToken}`)).status === 404);
  const viewerMembers = await viewer.get('/api/members');
  check('A viewer sees the team but no invites', viewerMembers.status === 200 && viewerMembers.body.members.length >= 3 && viewerMembers.body.invites.length === 0 && viewerMembers.body.canManage === false);

  const transfer = await owner.patch(`/api/workspaces/${boot.workspace.id}`, { transferTo: outsiderAccept.body.user.id });
  check('Ownership can be handed over', transfer.status === 200 && transfer.body.members.find((member) => member.userId === outsiderAccept.body.user.id)?.role === 'owner');
  check('The old owner keeps admin access', transfer.body.members.find((member) => member.userId === boot.user.id)?.role === 'admin');
  check('The caller is told their role changed', transfer.body.role === 'admin');
  const exOwnerCannot = await owner.patch(`/api/members/${outsiderAccept.body.user.id}`, { role: 'viewer' });
  check('An admin cannot demote the new owner', exOwnerCannot.status === 403);
  const handedBack = await outsider.patch(`/api/workspaces/${boot.workspace.id}`, { transferTo: boot.user.id });
  check('Ownership can be handed back', handedBack.body.members.find((member) => member.userId === boot.user.id)?.role === 'owner');
  check('The transfer is refused for someone outside the workspace', (await owner.patch(`/api/workspaces/${boot.workspace.id}`, { transferTo: 'u-nobody' })).status === 404);

  // --- Workspace isolation -------------------------------------------------
  console.log('\nWorkspace isolation');
  const second = await owner.post('/api/workspaces', { name: 'Side Projects' });
  check('POST /api/workspaces creates one and switches to it', second.status === 201 && second.body.workspace?.name === 'Side Projects');
  const isolated = (await owner.get('/api/bootstrap')).body;
  check('A new workspace starts empty', isolated.projects?.length === 0 && isolated.files?.length === undefined || isolated.projects?.length === 0);
  check('Membership does not leak between workspaces', isolated.members?.length === 1 && isolated.members[0].role === 'owner');
  check('Another workspace\'s project is invisible', (await owner.get(`/api/projects/${project.id}`)).status === 404);
  check('Another workspace\'s generation is invisible', (await owner.get(`/api/generations/${generationId}`)).status === 404);
  check('Another workspace\'s file is not served', (await owner.request(`/api/files/${imageFile.id}`, { raw: true })).status === 404);
  check('Another workspace\'s automation is invisible', (await owner.post('/api/automations/a-digest/run')).status === 404);
  const switchBack = await owner.post('/api/workspaces/switch', { workspaceId: boot.workspace.id });
  check('Switching back restores the workspace', switchBack.status === 200 && switchBack.body.workspace.id === boot.workspace.id);
  check('The original projects are visible again', (await owner.get('/api/projects')).body.projects?.length >= 6);
  const signedOutSwitch = await anon.post('/api/workspaces/switch', { workspaceId: boot.workspace.id });
  check('Signed-out callers cannot switch workspaces', signedOutSwitch.status === 401, `got ${signedOutSwitch.status} ${JSON.stringify(signedOutSwitch.body).slice(0, 80)}`);
  const foreignSwitch = await viewer.post('/api/workspaces/switch', { workspaceId: second.body.workspace.id });
  check('A member cannot switch into a workspace they are not in', foreignSwitch.status === 404);

  // --- CSRF and session hygiene -------------------------------------------
  console.log('\nSession hygiene');
  const crossOrigin = await owner.post('/api/projects', { title: 'cross site' }, { originHeader: 'https://evil.example' });
  check('Cross-origin cookie writes are refused', crossOrigin.status === 403 && crossOrigin.body?.error?.code === 'cross_origin');
  const sameOrigin = await owner.post('/api/projects', { title: 'legit' }, { originHeader: base });
  check('Same-origin writes still work', sameOrigin.status === 201);
  // A hosted preview sits behind a proxy that rewrites Host, so the browser's
  // own same-origin signal has to be enough to allow the write.
  const behindProxy = await owner.post('/api/projects', { title: 'behind a proxy' }, { headers: { 'Sec-Fetch-Site': 'same-origin', Origin: 'https://studio.preview.example' } });
  check('A proxy that rewrites Host does not break same-origin writes', behindProxy.status === 201, `got ${behindProxy.status}`);
  const crossSiteFetch = await owner.post('/api/projects', { title: 'nope' }, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  check('A cross-site fetch is refused even without an Origin header', crossSiteFetch.status === 403 && crossSiteFetch.body?.error?.code === 'cross_origin');
  const cookieValue = owner.jar.get('studio_session') || '';
  const storedSessions = new DatabaseSync(dbPath).prepare('SELECT id FROM sessions').all().map((row) => row.id);
  check('Only the token digest is stored, never the token', !storedSessions.includes(cookieValue) && storedSessions.length > 0);

  const limited = createClient(base, 'bruteforce');
  for (let attempt = 0; attempt < 4; attempt += 1) await limited.post('/api/auth/login', { email: 'viewer@example.com', password: 'nope' });
  const blocked = await limited.post('/api/auth/login', { email: 'viewer@example.com', password: 'nope' });
  check('Repeated bad sign-ins are throttled', blocked.status === 429 && blocked.body?.error?.code === 'rate_limited', `got ${blocked.status}`);
  check('A throttled caller is told how long to wait', /minute/.test(blocked.body?.error?.message || ''));

  // (Admin, not viewer: the throttle test above is still counting that email.)
  const passwordChange = await admin.patch('/api/me', { currentPassword: 'admin-pass-1', password: 'admin-pass-2' });
  check('PATCH /api/me changes the password', passwordChange.status === 200 && passwordChange.body.passwordChanged === true);
  check('Changing a password ends the old session', (await admin.get('/api/bootstrap')).status === 401);
  const relogin = await createClient(base, 'admin-again').post('/api/auth/login', { email: 'admin@example.com', password: 'admin-pass-2' });
  check('The new password works', relogin.status === 200, `got ${relogin.status} ${JSON.stringify(relogin.body?.error || {}).slice(0, 90)}`);
  check('The old password does not', (await createClient(base, 'admin-old').post('/api/auth/login', { email: 'admin@example.com', password: 'admin-pass-1' })).status === 401);

  const logout = await createClient(base, 'logout');
  await logout.post('/api/auth/login', { email: 'owner@example.com', password: 'studio-pass-1' });
  check('Signing out clears the session', (await logout.post('/api/auth/logout')).status === 200 && (await logout.get('/api/bootstrap')).status === 401);

  // --- Usage, settings, errors --------------------------------------------
  console.log('\nUsage, settings, errors');
  const usage = await owner.get('/api/usage');
  check('Usage totals add up', usage.body.totals.generations >= 2 && usage.body.plan.creditsIncluded === 10000);
  check('Usage has a seven-day series', usage.body.daily?.length === 7);
  check('Usage lists recent generations', usage.body.recent?.length >= 1);
  const saved = await owner.put('/api/settings', { name: 'Selftest User', workspace: 'Selftest Studio' });
  check('PUT /api/settings persists', saved.body.settings?.name === 'Selftest User' && saved.body.settings?.workspace === 'Selftest Studio');
  const probe = await owner.post('/api/workspaces', { name: 'Settings probe' });
  const probeSettings = (await owner.get('/api/settings')).body?.settings || {};
  check('Settings are per workspace, not global', probeSettings.workspace === 'Settings probe' && probeSettings.name !== 'Selftest User', JSON.stringify(probeSettings).slice(0, 120));
  const renamedBySettings = await owner.put('/api/settings', { workspace: 'Renamed by settings' });
  check('Renaming through settings renames the workspace', renamedBySettings.body?.workspace?.name === 'Renamed by settings', JSON.stringify(renamedBySettings.body?.workspace || {}).slice(0, 100));
  await owner.del(`/api/workspaces/${probe.body.workspace.id}`, { confirm: 'Renamed by settings' });
  check('Deleting a workspace returns you to another one', (await owner.get('/api/bootstrap')).body.workspace?.name === 'Selftest Studio');

  const badEvents = await owner.stream('/api/generate', { prompt: 'test', model: 'Claude Sonnet' });
  const badError = badEvents.find((item) => item.event === 'error');
  check('Unconfigured provider fails with guidance', /not connected/i.test(badError?.data?.message || ''), badError?.data?.message);

  const emptyPrompt = await owner.post('/api/generate', { prompt: '' });
  check('Empty prompt is rejected', emptyPrompt.status === 400);
  const notFound = await owner.get('/api/generations/does-not-exist');
  check('Unknown generation returns 404 JSON', notFound.status === 404 && typeof notFound.body?.error?.message === 'string');
  const badJson = await owner.request('/api/projects', { method: 'POST', rawBody: '{oops', headers: { 'Content-Type': 'application/json' } });
  check('Malformed JSON returns 400', badJson.status === 400, `got ${badJson.status} ${JSON.stringify(badJson.body).slice(0, 80)}`);
  const badMethod = await owner.request('/api/health', { method: 'DELETE' });
  check('Unknown route/method returns JSON error', badMethod.status >= 400 && typeof badMethod.body?.error?.message === 'string');
  check('A member cannot delete the workspace', (await viewer.del(`/api/workspaces/${boot.workspace.id}`, { confirm: 'x' })).status === 403);
  const wrongConfirm = await owner.del(`/api/workspaces/${second.body.workspace.id}`, { confirm: 'nope' });
  check('Deleting a workspace needs its name as confirmation', wrongConfirm.status === 400 && wrongConfirm.body?.error?.code === 'confirmation_required');
  const deleted = await owner.del(`/api/workspaces/${second.body.workspace.id}`, { confirm: 'Side Projects' });
  check('An owner can delete their own workspace', deleted.status === 200 && deleted.body.deleted === true);

  // --- Object storage ------------------------------------------------------
  /**
   * The fake S3 below verifies every SigV4 signature by rebuilding the canonical
   * request from what arrived on the wire, so a signing bug cannot pass. This
   * section drives a *second* server instance configured to write to it.
   */
  console.log('\nObject storage (S3 driver)');
  const bucket = 'studio-test-bucket';
  const fakeS3 = createFakeS3({ accessKeyId: 'test-key', secretAccessKey: 'test-secret' });
  const { endpoint: s3Endpoint } = await fakeS3.listen();
  const storageDb = path.join(tmpDir, 'storage.db');
  const storagePort = port + 2;
  const storageChild = startServer({
    dbFile: storageDb,
    uploadPath: path.join(tmpDir, 'storage-uploads'),
    serverPort: storagePort,
    extraEnv: {
      AI_STUDIO_STORAGE: 's3',
      AI_STUDIO_S3_BUCKET: bucket,
      AI_STUDIO_S3_ENDPOINT: s3Endpoint,
      AI_STUDIO_S3_REGION: 'auto',
      AI_STUDIO_S3_ACCESS_KEY: 'test-key',
      AI_STUDIO_S3_SECRET_KEY: 'test-secret',
      AI_STUDIO_S3_PREFIX: 'studio',
    },
  });
  const storageBase = `http://127.0.0.1:${storagePort}`;
  const storageUp = await waitForServer(storageBase);
  check('A server configured for S3 boots', storageUp, storageChild.log.slice(-600));

  if (storageUp) {
    const s3Owner = createClient(storageBase, 's3-owner');
    const s3Signup = await s3Owner.post('/api/auth/signup', { email: 's3@example.com', name: 'S3 Owner', password: 's3-owner-pass' });
    check('Signing up works the same on the S3 driver', s3Signup.status === 201);

    const described = await s3Owner.get('/api/storage');
    check('Storage describes itself as S3', described.body.driver === 's3' && described.body.bucket === bucket, JSON.stringify(described.body).slice(0, 120));
    check('Storage diagnostics carry no credentials', !JSON.stringify(described.body).includes('test-secret') && !JSON.stringify(described.body).includes('test-key'));

    const probe = await s3Owner.post('/api/storage/check');
    check('The bucket probe writes, reads, and deletes', probe.body.ok === true && probe.body.driver === 's3', JSON.stringify(probe.body).slice(0, 160));
    check('The probe leaves nothing behind', fakeS3.keysFor(bucket).filter((key) => key.includes('_healthcheck')).length === 0);
    const invited = await s3Owner.post('/api/invites', { email: 'viewer@example.com', role: 'viewer' });
    const memberProbe = createClient(storageBase, 's3-viewer');
    await memberProbe.post(`/api/invites/${String(invited.body.acceptUrl).split('invite=')[1]}/accept`, { name: 'S3 Viewer', password: 's3-viewer-pass' });
    check('A viewer can read the storage description', (await memberProbe.get('/api/storage')).status === 200);
    check('Only a manager can probe the bucket', (await memberProbe.post('/api/storage/check')).status === 403);

    const form = new FormData();
    form.append('files', new Blob(['Object storage brief. Target: a ceramics studio.\n'], { type: 'text/plain' }), 's3-brief.txt');
    const uploaded = await s3Owner.request('/api/files', { method: 'POST', form });
    const uploadedFile = uploaded.body.files?.[0];
    check('An upload lands in the bucket', uploaded.status === 201 && fakeS3.keysFor(bucket).some((key) => key.endsWith('.txt')), JSON.stringify(fakeS3.keysFor(bucket)));
    check('Objects are keyed per workspace', fakeS3.keysFor(bucket).some((key) => key.startsWith(`studio/w/`) && key.includes(uploadedFile?.id || 'nope')), JSON.stringify(fakeS3.keysFor(bucket)));

    const fetched = await s3Owner.request(`/api/files/${uploadedFile.id}`, { raw: true });
    const fetchedText = await fetched.text();
    check('The API streams the bytes back from the bucket', fetched.status === 200 && fetchedText.includes('Object storage brief'), `${fetched.status} · ${fetchedText.slice(0, 40)}`);
    check('The served file keeps its content type', (fetched.headers.get('content-type') || '').includes('text/plain'));

    // A generation that produces an image must store the asset in the bucket too.
    const imageEvents = await s3Owner.stream('/api/generate', { prompt: 'A still life with a ceramic cup.', mode: 'Image', title: 'S3 asset' });
    const imageDone = imageEvents.find((item) => item.event === 'done')?.data;
    check('A generated asset is stored as an object', imageDone?.generation?.assetUrl?.startsWith('/api/files/'), imageDone?.generation?.assetUrl);
    const asset = await s3Owner.request(imageDone.generation.assetUrl, { raw: true });
    check('The stored asset downloads from the bucket', asset.status === 200 && Number(asset.headers.get('content-length')) > 100, `${asset.status} · ${asset.headers.get('content-length')} bytes`);

    const attachments = await s3Owner.stream('/api/generate', {
      prompt: 'Use the attached brief.',
      mode: 'Writing',
      title: 'S3 reference',
      fileIds: [uploadedFile.id],
    });
    const attachmentEvents = attachments.find((item) => item.event === 'meta');
    check('An attachment is read back out of the bucket for a generation', attachmentEvents?.data.references?.length === 1, JSON.stringify(attachmentEvents?.data.references));

    const removed = await s3Owner.del(`/api/files/${uploadedFile.id}`);
    check('Deleting a file removes the object', removed.status === 200 && !fakeS3.keysFor(bucket).some((key) => key.includes(uploadedFile.id)), JSON.stringify(fakeS3.keysFor(bucket)));

    // Presigned redirects are opt-in and produce a URL the bucket accepts.
    const redirectChild = startServer({
      dbFile: storageDb,
      uploadPath: path.join(tmpDir, 'storage-uploads'),
      serverPort: storagePort + 1,
      extraEnv: {
        AI_STUDIO_STORAGE: 's3',
        AI_STUDIO_S3_BUCKET: bucket,
        AI_STUDIO_S3_ENDPOINT: s3Endpoint,
        AI_STUDIO_S3_REGION: 'auto',
        AI_STUDIO_S3_ACCESS_KEY: 'test-key',
        AI_STUDIO_S3_SECRET_KEY: 'test-secret',
        AI_STUDIO_S3_PREFIX: 'studio',
        AI_STUDIO_STORAGE_REDIRECT: '1',
      },
    });
    const redirectBase = `http://127.0.0.1:${storagePort + 1}`;
    const redirectUp = await waitForServer(redirectBase);
    check('A server with presigned redirects boots', redirectUp, redirectChild.log.slice(-400));
    if (redirectUp) {
      const redirectClient = createClient(redirectBase, 's3-redirect');
      await redirectClient.post('/api/auth/login', { email: 's3@example.com', password: 's3-owner-pass' });
      const redirectForm = new FormData();
      redirectForm.append('files', new Blob(['Redirect me to the bucket.\n'], { type: 'text/plain' }), 'redirect.txt');
      const redirectUpload = await redirectClient.request('/api/files', { method: 'POST', form: redirectForm });
      const target = redirectUpload.body.files?.[0];
      const firstHop = await redirectClient.request(`/api/files/${target.id}`, { raw: true, redirect: 'manual' });
      // (client defaults to following redirects; this one asks for the first hop)
      const location = firstHop.headers.get('location') || '';
      check('A file read redirects to a presigned URL', firstHop.status === 302 && location.includes('X-Amz-Signature'), `${firstHop.status} ${location.slice(0, 90)}`);
      const direct = await fetch(location);
      check('The presigned URL serves the bytes and the bucket accepted the signature', direct.status === 200 && (await direct.text()).includes('Redirect me'), `status ${direct.status}`);
      // A tenant boundary must still hold: another workspace's file id is a 404.
      const stranger = await redirectClient.request('/api/files/f-does-not-exist', { raw: true, redirect: 'manual' });
      check('An unknown file id is still a 404 behind redirects', stranger.status === 404);
    }
    redirectChild.kill('SIGTERM');

    // Switching back to local must not orphan objects written while S3 was active.
    const mixedChild = startServer({
      dbFile: storageDb,
      uploadPath: path.join(tmpDir, 'storage-uploads'),
      serverPort: storagePort + 2,
      extraEnv: {
        AI_STUDIO_STORAGE: 'local',
        AI_STUDIO_S3_BUCKET: bucket,
        AI_STUDIO_S3_ENDPOINT: s3Endpoint,
        AI_STUDIO_S3_REGION: 'auto',
        AI_STUDIO_S3_ACCESS_KEY: 'test-key',
        AI_STUDIO_S3_SECRET_KEY: 'test-secret',
      },
    });
    const mixedBase = `http://127.0.0.1:${storagePort + 2}`;
    const mixedUp = await waitForServer(mixedBase);
    check('Switching back to local storage still boots', mixedUp, mixedChild.log.slice(-400));
    if (mixedUp) {
      const mixed = createClient(mixedBase, 'mixed');
      await mixed.post('/api/auth/login', { email: 's3@example.com', password: 's3-owner-pass' });
      const before = fakeS3.keysFor(bucket).length;
      const oldAsset = await mixed.request(imageDone.generation.assetUrl, { raw: true });
      check('Files written to S3 are still served after switching to local', oldAsset.status === 200, `status ${oldAsset.status}`);
      const localForm = new FormData();
      localForm.append('files', new Blob(['Back on disk.\n'], { type: 'text/plain' }), 'local.txt');
      const localUpload = await mixed.request('/api/files', { method: 'POST', form: localForm });
      const localFile = localUpload.body.files?.[0];
      check('New uploads go to disk again', fakeS3.keysFor(bucket).length === before, `bucket grew by ${fakeS3.keysFor(bucket).length - before}`);
      check('Both drivers are reported as available', (await mixed.get('/api/storage')).body.drivers?.length === 2);
      const localRead = await mixed.request(`/api/files/${localFile.id}`, { raw: true });
      check('The local file is readable in the same session', localRead.status === 200 && (await localRead.text()).includes('Back on disk'));

      // Deleting a workspace must take its objects with it.
      const doomed = (await mixed.get('/api/bootstrap')).body.workspace;
      const doomedFiles = fakeS3.keysFor(bucket).length;
      const deleted = await mixed.del(`/api/workspaces/${doomed.id}`, { confirm: doomed.name });
      check('Deleting a workspace removes its objects', deleted.status === 200 && fakeS3.keysFor(bucket).length < doomedFiles, `${doomedFiles} → ${fakeS3.keysFor(bucket).length}`);
    }
    mixedChild.kill('SIGTERM');
  }
  storageChild.kill('SIGTERM');
  await fakeS3.close();

  // --- Migrating a database from before accounts existed -------------------
  console.log('\nLegacy migration');
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 400));

  const legacyPath = path.join(tmpDir, 'legacy.db');
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(fs.readFileSync(path.join(here, 'fixtures', 'legacy-db.sql'), 'utf8'));
  const legacyNow = new Date().toISOString();
  legacy.prepare(`INSERT INTO projects (id, title, type, model, status, prompt, art, outputs, archived, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
    .run('p-legacy', 'From the last version', 'Brand', 'Auto select', 'Draft', 'A project that predates accounts.', 'atlas', 3, legacyNow, legacyNow);
  legacy.prepare(`INSERT INTO generations (id, project_id, provider, model_id, model_label, kind, mode, prompt, output, status, tokens_in, tokens_out, credits, cost_usd, latency_ms, created_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('g-legacy', 'p-legacy', 'mock', 'demo', 'Studio demo engine', 'writing', 'Writing', 'Old prompt', 'Old output that should survive.', 'succeeded', 50, 300, 2, 0, 900, legacyNow, legacyNow);
  legacy.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('workspace', 'Legacy Studio');
  legacy.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('timezone', 'Europe/Berlin');
  legacy.prepare('INSERT INTO activity (icon, tone, line, project, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('sparkles', '', 'An old <em>activity</em> line', 'From the last version', legacyNow);
  legacy.close();

  const legacyPort = port + 1;
  const legacyChild = startServer({ dbFile: legacyPath, uploadPath: path.join(tmpDir, 'legacy-uploads'), serverPort: legacyPort });
  const legacyBase = `http://127.0.0.1:${legacyPort}`;
  const legacyUp = await waitForServer(legacyBase);
  check('A pre-accounts database still boots', legacyUp, legacyChild.log.slice(-1200));

  if (legacyUp) {
    const legacyAnon = createClient(legacyBase, 'legacy-anon');
    const legacyOwner = createClient(legacyBase, 'legacy-owner');
    const legacySession = await legacyAnon.get('/api/auth/session');
    check('Its content is offered for claiming', legacySession.body.firstRun === true && legacySession.body.claimable?.[0]?.name === 'Legacy Studio', JSON.stringify(legacySession.body.claimable));
    const claimed = await legacyOwner.post('/api/auth/signup', { email: 'legacy@example.com', name: 'Legacy Owner', password: 'legacy-pass-1' });
    check('The first account adopts the old workspace', claimed.status === 201 && claimed.body.claimed === true && claimed.body.workspace.name === 'Legacy Studio');
    const legacyBoot = (await legacyOwner.get('/api/bootstrap')).body;
    check('Old projects survived the migration', legacyBoot.projects?.some((item) => item.id === 'p-legacy' && item.outputs === 3));
    check('Old settings survived the migration', legacyBoot.settings?.workspace === 'Legacy Studio' && legacyBoot.settings?.timezone === 'Europe/Berlin', JSON.stringify(legacyBoot.settings));
    check('Old generations survived the migration', legacyBoot.recentGenerations?.some((item) => item.id === 'g-legacy') || (await legacyOwner.get('/api/generations/g-legacy')).status === 200);
    check('Old activity survived the migration', (await legacyOwner.get('/api/activity')).body?.activity?.some((item) => /old/i.test(item.line)));
  }
  legacyChild.kill('SIGTERM');
} catch (error) {
  failures.push(`Unexpected error: ${error.message}`);
  console.error('\nUnexpected error:\n', error);
  // The server's own log is the only place a crash explains itself.
  console.error('\nServer log (tail):\n' + (child.log || '(empty)').split('\n').slice(-25).join('\n'));
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
