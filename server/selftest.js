import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

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

  async function request(path_, { method = 'GET', body, rawBody, headers = {}, form, originHeader, token, raw = false } = {}) {
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

function startServer({ dbFile, uploadPath, serverPort }) {
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

const child = startServer({ dbFile: dbPath, uploadPath: uploadDir, serverPort: port });

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
  const skipped = await owner.post('/api/automations/a-archive/run');
  check('Non-generation chore reports honestly', skipped.body.status === 'skipped' && /generator|workflow/i.test(skipped.body.message), JSON.stringify(skipped.body).slice(0, 120));

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
    return body.body.runs?.length ? body.body.runs[0] : null;
  });
  check('Status change fires the matching automation', eventRun?.status === 'succeeded', eventRun ? eventRun.note : 'no run recorded');
  check('Event run produced a generation', Boolean(eventRun?.generation?.id));

  // --- Scheduler -----------------------------------------------------------
  console.log('\nScheduler');
  const heartbeat = await owner.post('/api/automations', { name: 'Selftest heartbeat', action: 'Curate & summarize', schedule: { type: 'interval', everyMinutes: 0.1 } });
  check('POST /api/automations accepts a schedule', heartbeat.body.automation?.schedule?.type === 'interval' && heartbeat.body.automation.nextRunAt);
  const scheduledRun = await waitUntil(async () => {
    const body = await owner.get(`/api/automations/${heartbeat.body.automation.id}/runs`);
    return body.body.runs?.find((item) => String(item.note || '').startsWith('scheduled')) || null;
  }, { timeoutMs: 8000 });
  check('The scheduler runs due workflows on its own', scheduledRun?.status === 'succeeded', scheduledRun ? 'ok' : 'no scheduled run within 8s');
  const scheduler = await owner.get('/api/scheduler');
  check('Scheduler status counts runs', scheduler.body.counts?.runs >= 1 && scheduler.body.active === true);
  check('Scheduler reports the workspace timezone', Boolean(scheduler.body.timeZone));
  const badSchedule = await owner.post('/api/automations', { name: 'Too fast', schedule: { type: 'interval', everyMinutes: 0.001 } });
  check('A nonsense schedule is rejected', badSchedule.status === 400);

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
