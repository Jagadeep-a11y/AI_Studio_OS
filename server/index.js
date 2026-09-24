import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { config, providerSummary } from './config.js';
import { openDatabase } from './db.js';
import { createGateway } from './gateway.js';
import { createStore } from './store.js';
import { AUTOMATION_TEMPLATES } from './seed.js';
import { ProviderError } from './providers/util.js';

/**
 * AI Studio OS server.
 *
 * One process serves the static app and a JSON API, so the browser only ever
 * talks to its own origin and provider keys stay on the machine that runs the
 * server. No framework, no build step: `node server/index.js`.
 */

const db = openDatabase(config.dbPath);
const store = createStore(db);
const gateway = createGateway(config);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const startedAt = Date.now();
const json = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
};

const fail = (res, error, fallbackStatus = 500) => {
  const status = error instanceof ProviderError ? error.status : fallbackStatus;
  json(res, status && status >= 400 && status < 600 ? status : 500, {
    error: {
      message: error?.message || 'Something went wrong.',
      code: error?.code || 'server_error',
      hint: error?.hint || '',
      provider: error?.provider || null,
    },
  });
};

async function readJsonBody(req, limitBytes = 1_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new ProviderError('Request body is too large', { status: 413, code: 'payload_too_large' });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError('Request body must be valid JSON', { status: 400, code: 'invalid_json' });
  }
}

const text = (value, max = 8_000) => String(value ?? '').trim().slice(0, max);

/** Title suggestion for a prompt that has no project yet. */
function titleFromPrompt(prompt) {
  const clean = prompt.replace(/\s+/g, ' ').trim();
  const sentence = clean.split(/[.!?\n]/)[0] || clean;
  const title = sentence.slice(0, 60).trim() || 'A new idea';
  return title.length < clean.length ? `${title}…` : title;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

const routes = {
  'GET /api/health': async ({ res, url }) => {
    const probe = url.searchParams.get('probe') === '1';
    const providers = providerSummary();
    if (!probe) return json(res, 200, { ok: true, mode: gateway.isDemoOnly() ? 'demo' : 'live', uptimeMs: Date.now() - startedAt, providers });
    const checks = await Promise.all(gateway.providers.filter((provider) => provider.isConfigured()).map(async (provider) => ({
      id: provider.id,
      ...(await provider.checkHealth({})),
    })));
    return json(res, 200, { ok: true, mode: gateway.isDemoOnly() ? 'demo' : 'live', providers, checks });
  },

  /** One call that boots the whole UI: workspace, models, projects, the lot. */
  'GET /api/bootstrap': async ({ res }) => {
    await gateway.refreshDiscovery();
    const { models, providers, curated } = gateway.listModels();
    json(res, 200, {
      workspace: store.getSettings().workspace || config.workspace,
      mode: gateway.isDemoOnly() ? 'demo' : 'live',
      allowMock: config.allowMock,
      providers,
      models,
      curatedModels: curated,
      projects: store.listProjects(),
      prompts: store.listPrompts(),
      automations: store.listAutomations(),
      activity: store.listActivity(6),
      settings: store.getSettings(),
      usage: store.usageSummary(),
      capabilities: capabilities(),
    });
  },

  'GET /api/models': async ({ res, url }) => {
    if (url.searchParams.get('refresh') === '1') await gateway.refreshDiscovery({ force: true });
    else await gateway.refreshDiscovery();
    json(res, 200, gateway.listModels());
  },

  'GET /api/projects': async ({ res, url }) => {
    json(res, 200, { projects: store.listProjects({ includeArchived: url.searchParams.get('archived') === '1' }) });
  },

  'POST /api/projects': async ({ res, req }) => {
    const body = await readJsonBody(req);
    const project = store.createProject({
      title: body.title,
      type: body.type,
      model: body.model,
      prompt: body.prompt,
      status: body.status,
    });
    store.addActivity({ icon: 'folder', tone: 'orange', line: `<strong>${escapeForActivity(project.model)}</strong> started a new project`, project: project.title });
    json(res, 201, { project, activity: store.listActivity(6) });
  },

  'GET /api/prompts': async ({ res }) => json(res, 200, { prompts: store.listPrompts() }),

  'POST /api/prompts': async ({ res, req }) => {
    const body = await readJsonBody(req);
    if (!text(body.body || body.text)) throw new ProviderError('A prompt needs some text', { status: 400, code: 'invalid_prompt' });
    const prompt = store.createPrompt({ title: body.title, category: body.category, mode: body.mode, body: body.body || body.text, icon: body.icon });
    json(res, 201, { prompt, prompts: store.listPrompts() });
  },

  'GET /api/automations': async ({ res }) => json(res, 200, { automations: store.listAutomations() }),

  'POST /api/automations': async ({ res, req }) => {
    const body = await readJsonBody(req);
    const automation = store.createAutomation({
      name: body.name,
      description: text(body.description, 400),
      trigger: text(body.trigger, 120) || 'On demand',
      action: text(body.action, 80) || 'Curate & summarize',
    });
    json(res, 201, { automation, automations: store.listAutomations() });
  },

  'GET /api/usage': async ({ res }) => json(res, 200, store.usageSummary()),

  'GET /api/activity': async ({ res, url }) => {
    json(res, 200, { activity: store.listActivity(Number(url.searchParams.get('limit')) || 8) });
  },

  'GET /api/settings': async ({ res }) => json(res, 200, { settings: store.getSettings(), providers: providerSummary() }),

  'PUT /api/settings': async ({ res, req }) => {
    const body = await readJsonBody(req);
    const allowed = ['name', 'email', 'workspace', 'timezone', 'startPage', 'defaultModel'];
    const patch = {};
    for (const key of allowed) if (key in body) patch[key] = text(body[key], 200);
    json(res, 200, { settings: store.saveSettings(patch) });
  },
};

/** Capability flags so the UI can hide or explain what this build cannot do yet. */
function capabilities() {
  return {
    generation: true,
    streaming: true,
    persistence: 'sqlite',
    imageGeneration: gateway.listModels().models.some((model) => model.kind === 'image' && model.selectable),
    realProviders: providerSummary().some((provider) => provider.configured && provider.id !== 'mock'),
    fileUploads: false,
    billing: false,
    scheduling: false,
  };
}

/** Activity lines render as HTML, so user and model text is neutralised first. */
const escapeForActivity = (value) => String(value ?? '')
  .replace(/<[^>]*>/g, '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

// ---------------------------------------------------------------------------
// SSE generation
// ---------------------------------------------------------------------------

async function handleGenerate(req, res) {
  const body = await readJsonBody(req);
  const prompt = text(body.prompt, 8_000);
  if (!prompt) throw new ProviderError('Describe what you want to create first.', { status: 400, code: 'missing_prompt' });

  const mode = text(body.mode, 20) || 'Writing';
  const kind = gateway.kindForMode(mode);

  // A generation always belongs to a project, so output never floats loose.
  let project = body.projectId ? store.getProject(body.projectId) : null;
  if (!project && body.createProject !== false) {
    project = store.createProject({
      title: body.title || titleFromPrompt(prompt),
      type: body.type || (kind === 'image' ? 'Image' : 'Writing'),
      model: text(body.model, 80) || 'Auto select',
      prompt,
      status: 'In progress',
    });
  }
  if (!project && body.projectId) throw new ProviderError('That project no longer exists', { status: 404, code: 'project_not_found' });

  const generationId = `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const abort = new AbortController();
  req.on('close', () => { if (!res.writableEnded) abort.abort(new Error('client disconnected')); });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, payload) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  send('meta', { generationId, projectId: project?.id || null, projectTitle: project?.title || '' });

  let accumulated = '';
  let summary = null;
  let failed = false;
  let failure = null;

  try {
    for await (const event of gateway.run({
      selection: body.model || 'Auto select',
      prompt,
      mode,
      system: text(body.system, 4_000),
      maxTokens: Math.min(Math.max(Number(body.maxTokens) || 1200, 64), 8_000),
      signal: abort.signal,
    })) {
      if (event.type === 'start') {
        store.createGeneration({
          id: generationId,
          projectId: project?.id || null,
          provider: event.provider,
          modelId: event.modelId,
          modelLabel: event.modelLabel,
          kind: event.kind,
          mode,
          prompt,
          status: 'streaming',
        });
        send('start', { ...event, generationId });
      } else if (event.type === 'delta') {
        accumulated += event.text;
        send('delta', { text: event.text });
      } else if (event.type === 'asset') {
        send('asset', event);
      } else if (event.type === 'notice') {
        send('notice', { message: event.message });
      } else if (event.type === 'usage') {
        send('usage', event);
      } else if (event.type === 'error') {
        failed = true;
        failure = event;
        send('error', event);
      } else if (event.type === 'summary') {
        summary = event;
        if (event.failed) failed = true;
      }
    }

    const finished = store.finishGeneration(generationId, {
      output: accumulated,
      assetUrl: summary?.assetUrl || '',
      status: failed ? 'failed' : 'succeeded',
      error: failure?.message || '',
      tokensIn: summary?.tokensIn || 0,
      tokensOut: summary?.tokensOut || 0,
      credits: summary?.credits || 0,
      costUsd: summary?.costUsd || 0,
      latencyMs: summary?.latencyMs || 0,
    });

    let activity = null;
    if (project) {
      store.recordOutput(project.id, { count: 1, status: failed ? project.status : 'In progress' });
      activity = store.addActivity({
        icon: failed ? 'close' : 'sparkles',
        tone: failed ? 'orange' : '',
        line: `<strong>${escapeForActivity(finished?.model || 'A model')}</strong> ${failed ? 'hit an error while generating' : `finished a ${kind === 'image' ? 'render' : 'generation'}`}`,
        project: project.title,
      });
    }

    send('done', {
      generation: finished,
      project: project ? store.getProject(project.id) : null,
      activity: activity || store.listActivity(6),
      usage: store.usageSummary(),
      failed,
    });
  } catch (error) {
    // Covers failures before the stream started (bad model, no provider).
    const status = error instanceof ProviderError ? error.status : 500;
    send('error', { message: error?.message || 'Generation failed', code: error?.code || 'server_error', hint: error?.hint || '', status });
    send('done', { generation: store.getGeneration(generationId), project, failed: true, error: error?.message });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

// ---------------------------------------------------------------------------
// Item routes with path parameters
// ---------------------------------------------------------------------------

async function handleItemRoute(req, res, pathname) {
  const parts = pathname.split('/').filter(Boolean); // ['api', ...]
  const [, group, id, sub] = parts;

  if (group === 'projects' && id) {
    if (!sub && req.method === 'GET') {
      const project = store.getProject(id);
      if (!project) return json(res, 404, { error: { message: 'Project not found', code: 'not_found' } });
      return json(res, 200, { project, generations: store.listGenerations({ projectId: id, limit: 20 }) });
    }
    if (!sub && (req.method === 'PATCH' || req.method === 'PUT')) {
      const body = await readJsonBody(req);
      const project = store.updateProject(id, {
        title: body.title,
        type: body.type,
        model: body.model,
        status: body.status,
        prompt: body.prompt,
      });
      if (!project) return json(res, 404, { error: { message: 'Project not found', code: 'not_found' } });
      return json(res, 200, { project });
    }
    if (!sub && req.method === 'DELETE') {
      const archived = store.archiveProject(id);
      if (!archived) return json(res, 404, { error: { message: 'Project not found', code: 'not_found' } });
      return json(res, 200, { archived: true, projects: store.listProjects() });
    }
    if (sub === 'duplicate' && req.method === 'POST') {
      const project = store.duplicateProject(id);
      if (!project) return json(res, 404, { error: { message: 'Project not found', code: 'not_found' } });
      return json(res, 201, { project, projects: store.listProjects() });
    }
  }

  if (group === 'prompts' && id && sub === 'use' && req.method === 'POST') {
    const prompt = store.incrementPromptUses(id);
    if (!prompt) return json(res, 404, { error: { message: 'Prompt not found', code: 'not_found' } });
    return json(res, 200, { prompt });
  }

  if (group === 'automations' && id) {
    if (!sub && (req.method === 'PATCH' || req.method === 'PUT')) {
      const body = await readJsonBody(req);
      const automation = store.updateAutomation(id, {
        name: body.name,
        description: body.description,
        trigger: body.trigger,
        action: body.action,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      });
      if (!automation) return json(res, 404, { error: { message: 'Automation not found', code: 'not_found' } });
      return json(res, 200, { automation });
    }
    if (sub === 'run' && req.method === 'POST') return runAutomation(res, id);
    if (sub === 'runs' && req.method === 'GET') return json(res, 200, { runs: store.listAutomationRuns(id, 10) });
  }

  if (group === 'generations' && id && req.method === 'GET') {
    const generation = store.getGeneration(id);
    if (!generation) return json(res, 404, { error: { message: 'Generation not found', code: 'not_found' } });
    return json(res, 200, { generation });
  }

  return json(res, 404, { error: { message: `No API route for ${req.method} ${pathname}`, code: 'not_found' } });
}

/**
 * "Run now" performs real work for generation-based actions and reports plainly
 * when an action is a workspace chore that is not automated yet.
 */
async function runAutomation(res, id) {
  const automation = store.getAutomation(id);
  if (!automation) return json(res, 404, { error: { message: 'Automation not found', code: 'not_found' } });

  const template = AUTOMATION_TEMPLATES[automation.action];
  if (!template || template.kind === 'navigate') {
    store.recordAutomationRun({ automationId: id, status: 'skipped', note: 'Workspace chore — no generator step in this build.' });
    return json(res, 200, {
      automation: store.getAutomation(id),
      status: 'skipped',
      message: `“${automation.name}” is a workspace chore. Scheduling and non-generation steps arrive with the scheduler phase.`,
    });
  }

  const project = store.listProjects()[0] || null;
  const prompt = template.buildPrompt({ project });
  let accumulated = '';
  let summary = null;

  try {
    for await (const event of gateway.run({ selection: 'Auto select', prompt, mode: 'Writing' })) {
      if (event.type === 'delta') accumulated += event.text;
      if (event.type === 'summary') summary = event;
      if (event.type === 'error') throw new ProviderError(event.message, { code: event.code, hint: event.hint });
    }
  } catch (error) {
    store.recordAutomationRun({ automationId: id, status: 'failed', note: error.message });
    return fail(res, error);
  }

  const generation = summary ? store.createGeneration({
    id: `g-${Date.now().toString(36)}-auto`,
    projectId: project?.id || null,
    provider: summary.provider,
    modelId: summary.modelId,
    modelLabel: summary.modelLabel,
    kind: 'text',
    mode: 'Writing',
    prompt,
    status: 'succeeded',
  }) : null;

  if (generation) {
    store.finishGeneration(generation.id, {
      output: accumulated,
      status: 'succeeded',
      tokensIn: summary.tokensIn,
      tokensOut: summary.tokensOut,
      credits: summary.credits,
      costUsd: summary.costUsd,
      latencyMs: summary.latencyMs,
    });
  }

  store.recordAutomationRun({ automationId: id, generationId: generation?.id || null, status: 'succeeded', note: prompt.slice(0, 160) });
  store.addActivity({
    icon: 'workflow',
    tone: 'green',
    line: `<strong>${escapeForActivity(automation.name)}</strong> ran ${summary?.isDemo ? 'in demo mode' : 'successfully'}`,
    project: project?.title || '',
  });

  json(res, 200, {
    automation: store.getAutomation(id),
    status: 'succeeded',
    generation: generation ? store.getGeneration(generation.id) : null,
    output: accumulated,
    isDemo: Boolean(summary?.isDemo),
    usage: store.usageSummary(),
  });
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

function serveFile(target, req, res) {
  fs.stat(target, (error, stats) => {
    if (error || !stats.isFile()) return json(res, 404, { error: { message: 'Not found', code: 'not_found' } });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stats.size,
      'Cache-Control': 'no-cache',
      'Last-Modified': stats.mtime.toUTCString(),
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).pipe(res);
  });
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.resolve(config.root, relative);
  // Never serve anything outside the repository root (and never the DB or .env).
  if (!target.startsWith(config.root + path.sep) && target !== path.join(config.root, 'index.html')) {
    return json(res, 403, { error: { message: 'Forbidden', code: 'forbidden' } });
  }
  const base = path.basename(target);
  if (base === '.env' || base.startsWith('.env.') || target.includes(`${path.sep}server${path.sep}`) || target.includes(`${path.sep}data${path.sep}`)) {
    return json(res, 404, { error: { message: 'Not found', code: 'not_found' } });
  }

  fs.stat(target, (error, stats) => {
    if (error || !stats.isFile()) {
      if (req.headers.accept?.includes('text/html')) {
        // Single-page app: unknown paths fall back to the shell.
        return serveFile(path.join(config.root, 'index.html'), req, res);
      }
      return json(res, 404, { error: { message: `Not found: ${pathname}`, code: 'not_found' } });
    }
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stats.size,
      // Always revalidate: this is a local prototype, and stale UI is worse
      // than a few extra bytes.
      'Cache-Control': 'no-cache',
      'Last-Modified': stats.mtime.toUTCString(),
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const started = Date.now();

  // Same-origin by default; permissive CORS so a separately hosted front end
  // can use the API. No credentials are involved — provider keys stay server-side.
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: { message: 'Method not allowed', code: 'method_not_allowed' } });
      return serveStatic(req, res, pathname);
    }

    if (pathname === '/api/generate' && req.method === 'POST') {
      await handleGenerate(req, res);
      return logRequest(req, pathname, 200, started);
    }

    const handler = routes[`${req.method} ${pathname}`];
    if (handler) {
      await handler({ req, res, url, pathname });
      return logRequest(req, pathname, res.statusCode, started);
    }
    await handleItemRoute(req, res, pathname);
    logRequest(req, pathname, res.statusCode, started);
  } catch (error) {
    if (res.headersSent) {
      // A stream already started: report the failure inside the stream.
      res.write(`event: error\ndata: ${JSON.stringify({ message: error?.message || 'Stream failed', code: error?.code || 'stream_error' })}\n\n`);
      res.end();
      return logRequest(req, pathname, 500, started);
    }
    fail(res, error);
    logRequest(req, pathname, error?.status || 500, started);
  }
});

function logRequest(req, pathname, status, started) {
  if (process.env.AI_STUDIO_QUIET === '1') return;
  const ms = Date.now() - started;
  const marker = status >= 400 ? '!' : '·';
  console.log(`${marker} ${req.method} ${pathname} ${status} ${ms}ms`);
}

server.on('clientError', (error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  console.error('Client error:', error.message);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}. Closing the studio…`);
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3_000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(config.port, config.host, () => {
  const mode = gateway.isDemoOnly() ? 'demo mode (no provider keys found)' : 'live mode';
  console.log('');
  console.log('  AI Studio OS');
  console.log(`  → http://localhost:${config.port}`);
  console.log(`  → database: ${config.dbPath}`);
  console.log(`  → ${mode}`);
  if (gateway.isDemoOnly()) console.log('  → add a provider key to .env for real generation (see .env.example)');
  console.log('');
});
