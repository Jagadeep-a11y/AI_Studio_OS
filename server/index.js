import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import { config, providerSummary } from './config.js';
import { openDatabase } from './db.js';
import { createGateway } from './gateway.js';
import { createStore } from './store.js';
import { createAutomationRunner } from './automations.js';
import { createScheduler } from './scheduler.js';
import { buildAttachments, createFileStore, MAX_FILES_PER_REQUEST, parseMultipart } from './files.js';
import { humanizeUntil, nextOccurrence, normalizeSchedule } from './schedule.js';
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
const files = createFileStore({ db, store, uploadDir: config.uploadsDir });
const automations = createAutomationRunner({ store, gateway });
const scheduler = createScheduler({ store, runner: automations, config });

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
    if (!probe) return json(res, 200, { ok: true, mode: gateway.isDemoOnly() ? 'demo' : 'live', uptimeMs: Date.now() - startedAt, providers, scheduler: scheduler.status() });
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
      scheduler: scheduler.status(),
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

  'GET /api/automations': async ({ res, url }) => {
    const withRuns = url.searchParams.get('runs') === '1';
    const automations = store.listAutomations().map((automation) => ({
      ...automation,
      nextRunLabel: automation.nextRunAt ? humanizeUntil(new Date(automation.nextRunAt).getTime()) : null,
      runs: withRuns ? store.listAutomationRuns(automation.id, 5).map(stripRunGeneration) : undefined,
    }));
    json(res, 200, { automations, scheduler: scheduler.status(), stats: store.automationRunStats(monthStartIso()) });
  },

  'POST /api/automations': async ({ res, req }) => {
    const body = await readJsonBody(req);
    const { schedule, error } = normalizeSchedule(body.schedule);
    if (error) throw new ProviderError(error, { status: 400, code: 'invalid_schedule' });
    const automation = store.createAutomation({
      name: body.name,
      description: text(body.description, 400),
      action: text(body.action, 80) || 'Curate & summarize',
      schedule,
      timeZone: store.getSettings().timezone || 'UTC',
    });
    json(res, 201, { automation: withRunLabel(automation), automations: store.listAutomations().map(withRunLabel) });
  },

  /** Scheduler health, for the Connections tab. */
  'GET /api/scheduler': async ({ res }) => json(res, 200, scheduler.status()),

  'GET /api/files': async ({ res, url }) => {
    const projectId = url.searchParams.get('projectId');
    json(res, 200, {
      files: projectId ? store.filesForProject(projectId, Number(url.searchParams.get('limit')) || 50) : store.listFiles({ limit: Number(url.searchParams.get('limit')) || 50 }),
      storage: files.stats(),
    });
  },

  /** Multipart upload of reference material. */
  'POST /api/files': async ({ res, req, url }) => handleUpload(req, res, url),

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

const withRunLabel = (automation) => ({
  ...automation,
  nextRunLabel: automation.nextRunAt ? humanizeUntil(new Date(automation.nextRunAt).getTime()) : null,
});

/** Run rows carry their generation inline for the UI, but not in list payloads. */
const stripRunGeneration = (run) => ({ ...run, generation: run.generation ? { id: run.generation.id, model: run.generation.model, status: run.generation.status, credits: run.generation.credits } : null });

/**
 * Uploads reference material for a generation. Accepts multipart/form-data
 * (browser drag-and-drop or file picker) and returns the stored file records.
 */
async function handleUpload(req, res, url) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.startsWith('multipart/form-data')) {
    throw new ProviderError('Uploads must be sent as multipart/form-data', { status: 415, code: 'expected_multipart' });
  }
  const buffer = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_FILES_PER_REQUEST * 10 * 1024 * 1024 + 1_000_000) {
      throw new ProviderError('That upload is too large', { status: 413, code: 'payload_too_large' });
    }
    buffer.push(chunk);
  }
  const parts = parseMultipart(Buffer.concat(buffer), contentType).filter((part) => part.data?.length);
  if (!parts.length) throw new ProviderError('No files were found in the upload', { status: 400, code: 'no_files' });
  if (parts.length > MAX_FILES_PER_REQUEST) {
    throw new ProviderError(`Attach up to ${MAX_FILES_PER_REQUEST} files at once`, { status: 413, code: 'too_many_files' });
  }

  const projectId = url.searchParams.get('projectId') || parts.find((part) => part.name === 'projectId')?.data?.toString('utf8') || null;
  const project = projectId ? store.getProject(projectId) : null;
  const stored = parts.map((part) => files.write({
    name: part.filename || part.name,
    mime: part.type,
    buffer: part.data,
    kind: 'attachment',
    projectId: project?.id || null,
  }));

  if (project) store.touchProject(project.id);
  json(res, 201, { files: stored, project: project ? store.getProject(project.id) : null, storage: files.stats() });
}

/** Streams a stored upload with the headers a browser needs to show it inline. */
async function serveStoredFile(res, req, id, download = false) {
  const row = store.getFile(id);
  if (!row) return json(res, 404, { error: { message: 'File not found', code: 'not_found' } });
  const body = await files.read(row);
  res.writeHead(200, {
    'Content-Type': row.mime,
    'Content-Length': body.length,
    'Cache-Control': 'private, max-age=300',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${row.name.replace(/["\\]/g, '')}"`,
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}

/**
 * Event triggers run in the background: a status change should never make the
 * user wait for a model to finish. Failures land in the run history.
 */
function fireEventAutomations(event, value, project) {
  const matches = store.automationsForEvent(event, value);
  for (const automation of matches) {
    automations.execute({ automation, source: 'event', project })
      .then((result) => {
        if (result.status === 'succeeded') console.log(`⟳ “${automation.name}” ran on ${event}=${value}`);
      })
      .catch((error) => console.error(`⟳ “${automation.name}” event run failed: ${error.message}`));
  }
  return matches.length;
}

/** Capability flags so the UI can hide or explain what this build cannot do yet. */
function capabilities() {
  return {
    generation: true,
    streaming: true,
    persistence: 'sqlite',
    imageGeneration: gateway.listModels().models.some((model) => model.kind === 'image' && model.selectable),
    realProviders: providerSummary().some((provider) => provider.configured && provider.id !== 'mock'),
    fileUploads: true,
    attachments: true,
    fileStorage: 'local-disk',
    billing: false,
    scheduling: Boolean(config.scheduler.enabled),
    eventTriggers: true,
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

  // Reference files the user attached to this prompt.
  const attachmentRows = Array.isArray(body.fileIds) ? store.filesByIds(body.fileIds) : [];
  const attachments = attachmentRows.length ? await buildAttachments(files, attachmentRows) : [];

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

  send('meta', {
    generationId,
    projectId: project?.id || null,
    projectTitle: project?.title || '',
    references: attachments.map((item) => ({ id: item.id, name: item.name, kind: item.kind, bytes: item.bytes })),
  });

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
      attachments,
    })) {
      if (event.type === 'start') {
        send('references', { references: event.references || [], imagesSent: event.imagesSent || 0 });
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

    // Generated images are written to disk and referenced by URL, so rows stay
    // small and the browser can cache them like any other file.
    let assetUrl = summary?.assetUrl || '';
    let assetFile = null;
    if (assetUrl.startsWith('data:')) {
      assetFile = files.writeDataUrl({
        dataUrl: assetUrl,
        name: `${project?.title || 'generation'}`.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'output',
        projectId: project?.id || null,
        generationId,
      });
      if (assetFile) assetUrl = assetFile.url;
    }

    const finished = store.finishGeneration(generationId, {
      output: accumulated,
      assetUrl,
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
      generation: finished ? { ...finished, assetFile } : finished,
      project: project ? { ...store.getProject(project.id), files: store.filesForProject(project.id, 50) } : null,
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

async function handleItemRoute(req, res, pathname, url = new URL('http://localhost/')) {
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
      const before = store.getProject(id);
      const project = store.updateProject(id, {
        title: body.title,
        type: body.type,
        model: body.model,
        status: body.status,
        prompt: body.prompt,
      });
      if (!project) return json(res, 404, { error: { message: 'Project not found', code: 'not_found' } });
      const statusChanged = before && body.status && before.status !== project.status;
      if (statusChanged) fireEventAutomations('project.status', project.status, project);
      return json(res, 200, { project, triggeredAutomations: statusChanged ? store.automationsForEvent('project.status', project.status).map((automation) => automation.name) : [] });
    }
    if (!sub && req.method === 'DELETE') {
      const archived = store.archiveProject(id);
      if (!archived) return json(res, 404, { error: { message: 'Project not found', code: 'not_found' } });
      return json(res, 200, { archived: true, projects: store.listProjects() });
    }
    if (sub === 'files' && req.method === 'GET') {
      return json(res, 200, { files: store.filesForProject(id, 100) });
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
      const patch = {
        name: body.name,
        description: body.description,
        action: body.action,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      };
      if (body.schedule !== undefined) {
        const { schedule, error } = normalizeSchedule(body.schedule);
        if (error) throw new ProviderError(error, { status: 400, code: 'invalid_schedule' });
        patch.schedule = schedule;
      }
      const automation = store.updateAutomation(id, patch, { timeZone: store.getSettings().timezone || 'UTC' });
      if (!automation) return json(res, 404, { error: { message: 'Automation not found', code: 'not_found' } });
      return json(res, 200, { automation: withRunLabel(automation), automations: store.listAutomations().map(withRunLabel) });
    }
    if (sub === 'run' && req.method === 'POST') return runAutomation(res, id);
    if (sub === 'runs' && req.method === 'GET') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 1), 100);
      return json(res, 200, { runs: store.listAutomationRuns(id, limit) });
    }
  }

  if (group === 'files' && id) {
    if (req.method === 'GET' || req.method === 'HEAD') return serveStoredFile(res, req, id, url.searchParams?.get('download') === '1');
    if (req.method === 'DELETE') {
      const removed = files.remove(id);
      if (!removed) return json(res, 404, { error: { message: 'File not found', code: 'not_found' } });
      return json(res, 200, { deleted: true, storage: files.stats() });
    }
  }

  if (group === 'generations' && id && req.method === 'GET') {
    const generation = store.getGeneration(id);
    if (!generation) return json(res, 404, { error: { message: 'Generation not found', code: 'not_found' } });
    return json(res, 200, { generation, files: store.filesForGeneration(id) });
  }

  return json(res, 404, { error: { message: `No API route for ${req.method} ${pathname}`, code: 'not_found' } });
}

/**
 * "Run now" goes through the same executor the scheduler uses, so manual and
 * scheduled runs are recorded identically.
 */
async function runAutomation(res, id) {
  const automation = store.getAutomation(id);
  if (!automation) return json(res, 404, { error: { message: 'Automation not found', code: 'not_found' } });

  const result = await automations.execute({ automation, source: 'manual' });
  if (result.status === 'failed') {
    return json(res, 502, { error: { message: result.message, code: 'automation_failed' }, status: 'failed', output: result.output });
  }

  // A manual run shifts the clock forward, so pressing Run never causes a
  // duplicate scheduled run minutes later.
  const settings = store.getSettings();
  store.setNextRun(id, nextRunIso(automation, settings.timezone));

  json(res, 200, {
    automation: withRunLabel(store.getAutomation(id)),
    automations: store.listAutomations().map(withRunLabel),
    status: result.status,
    message: result.message,
    generation: result.generation,
    output: result.output,
    isDemo: result.isDemo,
    usage: store.usageSummary(),
  });
}

/** Start of the current month in UTC, for the "runs this month" figure. */
function monthStartIso() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function nextRunIso(automation, timeZone) {
  const next = nextOccurrence(automation.schedule, Date.now(), timeZone || 'UTC');
  return next ? new Date(next).toISOString() : null;
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
    await handleItemRoute(req, res, pathname, url);
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
  console.log(`  → uploads:  ${config.uploadsDir}`);
  console.log(`  → ${mode}`);
  if (gateway.isDemoOnly()) console.log('  → add a provider key to .env for real generation (see .env.example)');

  // Catch up on anything that came due while the server was off, once.
  scheduler.tickOnce({ reason: 'startup' }).catch((error) => console.error('Startup schedule check failed:', error.message));
  scheduler.start();
  console.log('');
});
