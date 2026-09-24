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
import { createAccounts } from './accounts.js';
import { escapeText } from './html.js';
import { clearCookie, parseCookies, roleRank, sameOrigin, serializeCookie } from './auth.js';
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
const accounts = createAccounts({ store, config });
const parseCookiesHeader = (header) => parseCookies(header);
const gateway = createGateway(config);
const files = createFileStore({ db, store, uploadDir: config.uploadsDir });
const automations = createAutomationRunner({ store, gateway });
const scheduler = createScheduler({ store, accounts, runner: automations, config });

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

/**
 * The per-request context.
 *
 * `auth` is resolved once, here, and every workspace route reads its data
 * through `ctx.data` — a store pinned to the caller's workspace. Routes cannot
 * accidentally query across workspaces because they never see the global store.
 */
function buildContext(req, res, url, pathname) {
  const auth = pathname.startsWith('/api/') ? accounts.resolve(req) : null;
  return { req, res, url, pathname, auth, data: auth?.data || null, user: auth?.user || null, workspace: auth?.workspace || null, role: auth?.role || null };
}

/** Require a capability before a handler runs. Returns the auth context. */
const guard = (ctx, capability) => accounts.require(ctx.auth, capability);

/** HTML-escapes a value for the activity feed, which stores markup. */
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
  // --- Public -------------------------------------------------------------
  'GET /api/health': async ({ res, url }) => {
    const probe = url.searchParams.get('probe') === '1';
    const providers = providerSummary();
    const base = {
      ok: true,
      mode: gateway.isDemoOnly() ? 'demo' : 'live',
      uptimeMs: Date.now() - startedAt,
      providers,
      auth: { required: true, firstRun: accounts.isFirstRun() },
    };
    if (!probe) return json(res, 200, { ...base, scheduler: scheduler.status() });
    const checks = await Promise.all(gateway.providers.filter((provider) => provider.isConfigured()).map(async (provider) => ({
      id: provider.id,
      ...(await provider.checkHealth({})),
    })));
    return json(res, 200, { ...base, checks });
  },

  /**
   * Who am I? Answered for both signed-in and signed-out callers, because the
   * sign-in screen needs to know whether this is a brand-new studio (offer to
   * claim the seeded workspace) or an existing one (plain sign-in form).
   */
  'GET /api/auth/session': async (ctx) => {
    const { res } = ctx;
    if (!ctx.auth) {
      return json(res, 200, {
        authenticated: false,
        firstRun: accounts.isFirstRun(),
        claimable: accounts.claimableWorkspaces().map((workspace) => ({ id: workspace.id, name: workspace.name })),
        signupsOpen: config.auth.allowSignups,
        providers: providerSummary(),
      });
    }
    json(res, 200, { authenticated: true, ...sessionPayload(ctx, gateway) });
  },

  'POST /api/auth/signup': async (ctx) => {
    const { res, req } = ctx;
    const body = await readJsonBody(req);
    const result = await accounts.signUp({
      email: body.email,
      name: text(body.name, 80),
      password: body.password,
      workspaceName: text(body.workspace, 80),
    }, req);
    const token = accounts.startSession(result.user, result.workspace, req);
    setSessionCookie(req, res, token, accounts.sessionTtlMs);
    json(res, 201, {
      user: result.user,
      workspace: result.workspace,
      claimed: result.claimed,
      workspaces: store.listWorkspacesForUser(result.user.id).map(({ id, name, role }) => ({ id, name, role })),
      capabilities: capabilities(),
      providers: providerSummary(),
    });
  },

  'POST /api/auth/login': async (ctx) => {
    const { res, req } = ctx;
    const body = await readJsonBody(req);
    const { user, workspace } = await accounts.signIn({ email: body.email, password: body.password }, req);
    const token = accounts.startSession(user, workspace, req);
    setSessionCookie(req, res, token, accounts.sessionTtlMs);
    json(res, 200, {
      user,
      workspace,
      workspaces: store.listWorkspacesForUser(user.id).map(({ id, name, role }) => ({ id, name, role })),
      capabilities: capabilities(),
      providers: providerSummary(),
    });
  },

  'POST /api/auth/logout': async (ctx) => {
    const { res, req } = ctx;
    accounts.signOut(ctx.auth?.token || '');
    clearSessionCookie(req, res);
    json(res, 200, { signedOut: true });
  },

  /** Public: the accept screen needs to describe the invite before sign-in. */
  'GET /api/invites/:token': null, // handled by the item routes (public branch)

  // --- Everything below requires a signed-in member -----------------------
  /** One call that boots the whole UI: workspace, members, models, the lot. */
  'GET /api/bootstrap': async (ctx) => {
    guard(ctx, 'read');
    const { res, data } = ctx;
    await gateway.refreshDiscovery();
    const { models, providers, curated } = gateway.listModels();
    const settings = data.getSettings();
    json(res, 200, {
      workspace: { ...ctx.workspace, settings: settings.workspace || ctx.workspace.name },
      user: ctx.user,
      role: ctx.role,
      workspaces: ctx.auth.workspaces,
      members: data.listMembers(),
      invites: roleRank(ctx.role) >= roleRank('admin') ? data.invites() : [],
      assignableRoles: assignableRoles(ctx.role),
      mode: gateway.isDemoOnly() ? 'demo' : 'live',
      allowMock: config.allowMock,
      providers,
      models,
      curatedModels: curated,
      projects: data.listProjects(),
      prompts: data.listPrompts(),
      automations: data.listAutomations().map(withRunLabel),
      activity: data.listActivity(6),
      settings,
      usage: data.usageSummary(),
      scheduler: scheduler.status(ctx.workspace.id),
      consent: config.consent,
      capabilities: capabilities(),
    });
  },

  'GET /api/models': async (ctx) => {
    guard(ctx, 'read');
    const { res, url } = ctx;
    if (url.searchParams.get('refresh') === '1') await gateway.refreshDiscovery({ force: true });
    else await gateway.refreshDiscovery();
    json(res, 200, gateway.listModels());
  },

  // --- Workspace and members ----------------------------------------------
  'GET /api/workspaces': async (ctx) => {
    guard(ctx, 'read');
    json(ctx.res, 200, { workspaces: ctx.auth.workspaces, active: ctx.workspace.id });
  },

  'POST /api/workspaces': async (ctx) => {
    guard(ctx, 'manage');
    const body = await readJsonBody(ctx.req);
    const workspace = accounts.createWorkspaceFor(ctx.user, text(body.name, 80));
    const token = accounts.startSession(ctx.user, workspace, ctx.req);
    setSessionCookie(ctx.req, ctx.res, token, accounts.sessionTtlMs);
    json(ctx.res, 201, {
      workspace,
      workspaces: store.listWorkspacesForUser(ctx.user.id).map(({ id, name, role }) => ({ id, name, role })),
    });
  },

  'POST /api/workspaces/switch': async (ctx) => {
    guard(ctx, 'read');
    const body = await readJsonBody(ctx.req);
    const { workspace } = accounts.switchWorkspace(ctx.auth, text(body.workspaceId, 60));
    json(ctx.res, 200, {
      workspace,
      workspaces: store.listWorkspacesForUser(ctx.user.id).map(({ id, name, role }) => ({ id, name, role })),
    });
  },

  'GET /api/members': async (ctx) => {
    guard(ctx, 'read');
    const canManage = roleRank(ctx.role) >= roleRank('admin');
    json(ctx.res, 200, {
      members: ctx.data.listMembers(),
      // Pending invites carry email addresses, so only managers see them.
      invites: canManage ? ctx.data.invites() : [],
      assignableRoles: assignableRoles(ctx.role),
      canManage,
      role: ctx.role,
    });
  },

  'POST /api/invites': async (ctx) => {
    guard(ctx, 'manage');
    const body = await readJsonBody(ctx.req);
    const origin = `${ctx.req.headers['x-forwarded-proto'] || 'http'}://${ctx.req.headers.host || `localhost:${config.port}`}`;
    const result = accounts.invite(ctx.auth, { email: body.email, role: text(body.role, 20) || 'editor' }, origin);
    json(ctx.res, 201, {
      invite: result.invite,
      // The link is returned once, for the inviter to pass on. Nothing is
      // emailed in this build, so the UI has to show it plainly.
      acceptUrl: result.acceptUrl,
      expiresInDays: result.expiresInDays,
      invites: ctx.data.invites(),
    });
  },

  'GET /api/projects': async (ctx) => {
    guard(ctx, 'read');
    json(ctx.res, 200, { projects: ctx.data.listProjects({ includeArchived: ctx.url.searchParams.get('archived') === '1' }) });
  },

  'POST /api/projects': async (ctx) => {
    guard(ctx, 'write');
    const { res, req, data } = ctx;
    const body = await readJsonBody(req);
    const project = data.createProject({
      title: body.title,
      type: body.type,
      model: body.model,
      prompt: body.prompt,
      status: body.status,
    });
    data.addActivity({ icon: 'folder', tone: 'orange', line: `<strong>${escapeText(project.model)}</strong> started a new project`, project: project.title });
    json(res, 201, { project, activity: data.listActivity(6) });
  },

  'GET /api/prompts': async (ctx) => {
    guard(ctx, 'read');
    json(ctx.res, 200, { prompts: ctx.data.listPrompts() });
  },

  'POST /api/prompts': async (ctx) => {
    guard(ctx, 'write');
    const { res, req, data } = ctx;
    const body = await readJsonBody(req);
    if (!text(body.body || body.text)) throw new ProviderError('A prompt needs some text', { status: 400, code: 'invalid_prompt' });
    const prompt = data.createPrompt({ title: body.title, category: body.category, mode: body.mode, body: body.body || body.text, icon: body.icon });
    json(res, 201, { prompt, prompts: data.listPrompts() });
  },

  'GET /api/automations': async (ctx) => {
    guard(ctx, 'read');
    const { res, url, data } = ctx;
    const withRuns = url.searchParams.get('runs') === '1';
    const automations = data.listAutomations().map((automation) => ({
      ...automation,
      nextRunLabel: automation.nextRunAt ? humanizeUntil(new Date(automation.nextRunAt).getTime()) : null,
      runs: withRuns ? data.listAutomationRuns(automation.id, 5).map(stripRunGeneration) : undefined,
    }));
    json(res, 200, { automations, scheduler: scheduler.status(ctx.workspace.id), stats: data.automationRunStats(monthStartIso()) });
  },

  'POST /api/automations': async (ctx) => {
    guard(ctx, 'write');
    const { res, req, data } = ctx;
    const body = await readJsonBody(req);
    const { schedule, error } = normalizeSchedule(body.schedule);
    if (error) throw new ProviderError(error, { status: 400, code: 'invalid_schedule' });
    const automation = data.createAutomation({
      name: body.name,
      description: text(body.description, 400),
      action: text(body.action, 80) || 'Curate & summarize',
      schedule,
      timeZone: data.getSettings().timezone || 'UTC',
    });
    json(res, 201, { automation: withRunLabel(automation), automations: data.listAutomations().map(withRunLabel) });
  },

  /** Scheduler health, for the Connections tab. */
  'GET /api/scheduler': async (ctx) => {
    guard(ctx, 'read');
    json(ctx.res, 200, scheduler.status(ctx.workspace.id));
  },

  'GET /api/files': async (ctx) => {
    guard(ctx, 'read');
    const { res, url, data } = ctx;
    const projectId = url.searchParams.get('projectId');
    json(res, 200, {
      files: projectId ? data.filesForProject(projectId, Number(url.searchParams.get('limit')) || 50) : data.listFiles({ limit: Number(url.searchParams.get('limit')) || 50 }),
      storage: data.fileStats(),
    });
  },

  /** Multipart upload of reference material. */
  'POST /api/files': async (ctx) => {
    guard(ctx, 'write');
    return handleUpload(ctx);
  },

  'GET /api/usage': async (ctx) => {
    guard(ctx, 'read');
    json(ctx.res, 200, ctx.data.usageSummary());
  },

  'GET /api/activity': async (ctx) => {
    guard(ctx, 'read');
    json(ctx.res, 200, { activity: ctx.data.listActivity(Number(ctx.url.searchParams.get('limit')) || 8) });
  },

  'GET /api/settings': async (ctx) => {
    guard(ctx, 'read');
    json(ctx.res, 200, { settings: ctx.data.getSettings(), providers: providerSummary(), role: ctx.role, workspace: ctx.workspace, user: ctx.user });
  },

  'PUT /api/settings': async (ctx) => {
    guard(ctx, 'write');
    const body = await readJsonBody(ctx.req);
    // Only known preference keys are stored: an unknown key would quietly become
    // workspace data that nothing reads.
    const patch = {};
    for (const key of ['name', 'email', 'timezone', 'startPage', 'defaultModel']) {
      if (body[key] !== undefined) patch[key] = text(body[key], 120);
    }
    if (body.workspace !== undefined) patch.workspace = text(body.workspace, 80);
    const settings = ctx.data.saveSettings(patch);
    // The workspace name lives on the workspace itself; the preference mirrors it.
    if (patch.workspace && patch.workspace !== ctx.workspace.name) {
      accounts.renameWorkspace(ctx.auth, patch.workspace);
      settings.workspace = patch.workspace;
    }
    json(ctx.res, 200, { settings, workspace: store.getWorkspace(ctx.workspace.id) });
  },
};

/**
 * The signed-in payload. Shared by `/api/auth/session`, sign-up, and sign-in so
 * a client can treat them identically.
 */
function sessionPayload(ctx, gatewayInstance = gateway) {
  return {
    user: ctx.user,
    workspace: ctx.workspace,
    workspaces: ctx.auth.workspaces,
    role: ctx.role,
    capabilities: capabilities(),
    mode: gatewayInstance.isDemoOnly() ? 'demo' : 'live',
    providers: providerSummary(),
  };
}

const cookieOptions = (req) => ({ secure: String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || req.socket?.encrypted === true });

function setSessionCookie(req, res, token, ttlMs) {
  res.setHeader('Set-Cookie', serializeCookie(accounts.cookieName, token, { maxAge: ttlMs / 1000, ...cookieOptions(req) }));
}

function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', clearCookie(accounts.cookieName, cookieOptions(req)));
}

/** Can a role do a capability? Kept next to the routes that need the answer. */
const canManageRole = (role, capability) => roleRank(role) >= roleRank(capability === 'own' ? 'owner' : 'admin');

const roleHint = (role, capability) => (capability === 'own'
  ? 'Only the workspace owner can do that. Ask them to transfer ownership.'
  : `Only an owner or an admin of that workspace can do that — yours is ${role}.`);

/** Adds the human label the UI shows next to a scheduled workflow. */
const withRunLabel = (automation) => ({
  ...automation,
  nextRunLabel: automation.nextRunAt ? humanizeUntil(new Date(automation.nextRunAt).getTime()) : null,
});

/** Roles an actor may hand out — the UI uses it to disable impossible choices. */
function assignableRoles(role) {
  if (role === 'owner') return ['admin', 'editor', 'viewer'];
  if (role === 'admin') return ['editor', 'viewer'];
  return [];
}

/** Run rows carry their generation inline for the UI, but not in list payloads. */
const stripRunGeneration = (run) => ({ ...run, generation: run.generation ? { id: run.generation.id, model: run.generation.model, status: run.generation.status, credits: run.generation.credits } : null });

/**
 * Uploads reference material for a generation. Accepts multipart/form-data
 * (browser drag-and-drop or file picker) and returns the stored file records.
 */
async function handleUpload(ctx) {
  const { req, res, url, data } = ctx;
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
  const project = projectId ? data.getProject(projectId) : null;
  const scoped = files.forWorkspace(data);
  const stored = parts.map((part) => scoped.write({
    name: part.filename || part.name,
    mime: part.type,
    buffer: part.data,
    kind: 'attachment',
    projectId: project?.id || null,
  }));

  if (project) data.touchProject(project.id);
  json(res, 201, { files: stored, project: project ? data.getProject(project.id) : null, storage: data.fileStats() });
}

/** Streams a stored upload with the headers a browser needs to show it inline. */
async function serveStoredFile(ctx, id, download = false) {
  const { res, req, data } = ctx;
  // Scoped lookup: a file id from another workspace simply does not resolve.
  const row = data.getFileRow(id);
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
function fireEventAutomations(data, event, value, project) {
  const matches = data.automationsForEvent(event, value);
  for (const automation of matches) {
    automations.execute({ automation, source: 'event', project, data })
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
    accounts: true,
    teams: true,
    invites: true,
    roles: ['owner', 'admin', 'editor', 'viewer'],
    sessions: 'cookie',
    storage: 'sqlite',
  };
}

// ---------------------------------------------------------------------------
// SSE generation
// ---------------------------------------------------------------------------

async function handleGenerate(ctx) {
  const { req, res, data, user, workspace, role } = ctx;
  guard(ctx, 'run');
  const body = await readJsonBody(req);
  const prompt = text(body.prompt, 8_000);
  if (!prompt) throw new ProviderError('Describe what you want to create first.', { status: 400, code: 'missing_prompt' });

  const mode = text(body.mode, 20) || 'Writing';
  const kind = gateway.kindForMode(mode);

  // A generation always belongs to a project, so output never floats loose.
  let project = body.projectId ? data.getProject(body.projectId) : null;
  if (!project && body.createProject !== false) {
    project = data.createProject({
      title: body.title || titleFromPrompt(prompt),
      type: body.type || (kind === 'image' ? 'Image' : 'Writing'),
      model: text(body.model, 80) || 'Auto select',
      prompt,
      status: 'In progress',
    });
  }
  if (!project && body.projectId) throw new ProviderError('That project no longer exists', { status: 404, code: 'project_not_found' });

  // Reference files the user attached to this prompt.
  const attachmentRows = Array.isArray(body.fileIds) ? data.filesByIds(body.fileIds) : [];
  const scopedFiles = files.forWorkspace(data);
  const attachments = attachmentRows.length ? await buildAttachments(scopedFiles, attachmentRows) : [];

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
        data.createGeneration({
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
      assetFile = scopedFiles.writeDataUrl({
        dataUrl: assetUrl,
        name: `${project?.title || 'generation'}`.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'output',
        projectId: project?.id || null,
        generationId,
      });
      if (assetFile) assetUrl = assetFile.url;
    }

    const finished = data.finishGeneration(generationId, {
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
      data.recordOutput(project.id, { count: 1, status: failed ? project.status : 'In progress' });
      activity = data.addActivity({
        icon: failed ? 'close' : 'sparkles',
        tone: failed ? 'orange' : '',
        line: `<strong>${escapeText(finished?.model || 'A model')}</strong> ${failed ? 'hit an error while generating' : `finished a ${kind === 'image' ? 'render' : 'generation'}`}`,
        project: project.title,
      });
    }

    send('done', {
      generation: finished ? { ...finished, assetFile } : finished,
      project: project ? { ...data.getProject(project.id), files: data.filesForProject(project.id, 50) } : null,
      activity: activity || data.listActivity(6),
      usage: data.usageSummary(),
      failed,
    });
  } catch (error) {
    // Covers failures before the stream started (bad model, no provider).
    const status = error instanceof ProviderError ? error.status : 500;
    console.error(`Generation ${generationId} failed: ${error?.message}`);
    try {
      send('error', { message: error?.message || 'Generation failed', code: error?.code || 'server_error', hint: error?.hint || '', status });
      send('done', { generation: data.getGeneration(generationId), project, failed: true, error: error?.message });
    } catch (nested) {
      // Reporting a failure must not become a bigger failure.
      send('error', { message: nested?.message || 'Generation failed', code: 'stream_error' });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
}

// ---------------------------------------------------------------------------
// Item routes with path parameters
// ---------------------------------------------------------------------------

async function handleItemRoute(ctx) {
  const { req, res, url, pathname } = ctx;
  const parts = pathname.split('/').filter(Boolean); // ['api', ...]
  const [, group, id, sub] = parts;

  // --- Public: invite lookup, so the accept screen works before sign-in -----
  if (group === 'invites' && id && req.method === 'GET') {
    const described = accounts.describeInvite(id);
    return json(res, 200, described);
  }
  if (group === 'invites' && id && sub === 'accept' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const result = await accounts.acceptInvite(id, { name: text(body.name, 80), password: body.password }, req);
    const token = accounts.startSession(result.user, result.workspace, req);
    setSessionCookie(req, res, token, accounts.sessionTtlMs);
    return json(res, 200, {
      user: result.user,
      workspace: result.workspace,
      workspaces: store.listWorkspacesForUser(result.user.id).map(({ id: workspaceId, name, role }) => ({ id: workspaceId, name, role })),
      providers: providerSummary(),
      capabilities: capabilities(),
    });
  }

  // Everything else needs a signed-in member of a workspace.
  guard(ctx, 'read');
  const { data, user } = ctx;

  /**
   * Workspace administration addresses a workspace by id, which may not be the
   * active one. Every check below therefore uses the *target's* membership and
   * role — never the caller's role in whatever workspace their session points at.
   */
  if (group === 'workspaces' && id && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const target = (ctx.auth.workspaces || []).find((workspace) => workspace.id === id);
    if (!target) return json(res, 404, { error: { message: 'That workspace is not one of yours.', code: 'workspace_not_found' } });
    if (!canManageRole(target.role, req.method === 'DELETE' ? 'own' : 'manage')) {
      return json(res, 403, {
        error: {
          message: `Your role in ${target.name} is ${target.role}, which cannot change it.`,
          code: 'forbidden',
          hint: roleHint(target.role, req.method === 'DELETE' ? 'own' : 'manage'),
        },
      });
    }

    if (req.method === 'PATCH') {
      const body = await readJsonBody(req);
      if (body.name !== undefined) return json(res, 200, { workspace: { ...store.renameWorkspace(id, text(body.name, 80)), role: target.role } });
      if (body.plan) return json(res, 200, { workspace: { ...store.setWorkspacePlan(id, text(body.plan, 40)), role: target.role } });
      if (body.transferTo) {
        if (!store.membershipOf(id, body.transferTo)) {
          return json(res, 404, { error: { message: 'That person is not in this workspace.', code: 'not_a_member' } });
        }
        const members = accounts.transferOwnership({ ...ctx.auth, workspace: store.getWorkspace(id), role: target.role }, body.transferTo);
        return json(res, 200, {
          members,
          // If it was the active workspace, the caller's role just changed.
          role: id === ctx.workspace.id ? 'admin' : ctx.role,
        });
      }
      return json(res, 400, { error: { message: 'Nothing to change.', code: 'empty_patch' } });
    }

    // DELETE: irreversible, so the target's own name has to come back.
    const body = await readJsonBody(req).catch(() => ({}));
    if (body.confirm !== target.name) {
      return json(res, 400, {
        error: {
          message: 'Deleting a workspace needs its name as confirmation.',
          code: 'confirmation_required',
          hint: `Send { "confirm": "${target.name}" }. Every project, generation, and file in it is removed.`,
        },
      });
    }
    const wasActive = id === ctx.workspace.id;
    store.deleteWorkspace(id);
    const remaining = store.listWorkspacesForUser(user.id);
    if (!remaining.length) {
      accounts.signOut(ctx.auth.token);
      clearSessionCookie(req, res);
      return json(res, 200, { deleted: true, signedOut: true });
    }
    if (wasActive) accounts.switchWorkspace(ctx.auth, remaining[0].id);
    return json(res, 200, {
      deleted: true,
      workspace: wasActive ? { ...store.getWorkspace(remaining[0].id), role: remaining[0].role } : ctx.workspace,
      workspaces: remaining.map(({ id: workspaceId, name, role }) => ({ id: workspaceId, name, role })),
    });
  }

  if (group === 'members' && id && (req.method === 'PATCH' || req.method === 'DELETE')) {
    // Leaving is not a management action — anyone may remove themselves.
    guard(ctx, id === user.id && req.method === 'DELETE' ? 'read' : 'manage');
    if (req.method === 'PATCH') {
      const body = await readJsonBody(req);
      return json(res, 200, { members: accounts.setMemberRole(ctx.auth, id, text(body.role, 20)) });
    }
    const members = accounts.removeMember(ctx.auth, id);
    if (id === user.id) {
      // They just removed themselves; the session pointed at this workspace.
      clearSessionCookie(req, res);
      return json(res, 200, { members, left: true });
    }
    return json(res, 200, { members });
  }

  if (group === 'invites' && id && req.method === 'DELETE') {
    guard(ctx, 'manage');
    return json(res, 200, { invites: accounts.revokeInvite(ctx.auth, id) });
  }

  if (group === 'me' && req.method === 'PATCH') {
    const body = await readJsonBody(req);
    if (body.password !== undefined) {
      await accounts.changePassword(user, body.currentPassword, body.password);
      clearSessionCookie(req, res);
      return json(res, 200, { passwordChanged: true, signedOut: true, hint: 'Sign in again with your new password.' });
    }
    if (body.name !== undefined) {
      const updated = store.setName(user.id, text(body.name, 80));
      // Every membership row shows the name, so refresh what this session sees.
      return json(res, 200, { user: updated, members: data.listMembers() });
    }
    return json(res, 200, { user });
  }

  if (group === 'projects' && id) {
    if (!sub && req.method === 'GET') {
      const project = data.getProject(id);
      if (!project) return json(res, 404, { error: { message: 'Project not found', code: 'not_found' } });
      return json(res, 200, { project, generations: data.listGenerations({ projectId: id, limit: 20 }) });
    }
    if (!sub && (req.method === 'PATCH' || req.method === 'PUT')) {
      guard(ctx, 'write');
      const body = await readJsonBody(req);
      const before = data.getProject(id);
      const project = data.updateProject(id, {
        title: body.title,
        type: body.type,
        model: body.model,
        status: body.status,
        prompt: body.prompt,
      });
      if (!project) return json(res, 404, { error: { message: 'Project not found', code: 'not_found' } });
      const statusChanged = before && body.status && before.status !== project.status;
      if (statusChanged) fireEventAutomations(data, 'project.status', project.status, project);
      return json(res, 200, { project, triggeredAutomations: statusChanged ? data.automationsForEvent('project.status', project.status).map((automation) => automation.name) : [] });
    }
    if (!sub && req.method === 'DELETE') {
      guard(ctx, 'write');
      const archived = data.archiveProject(id);
      if (!archived) return json(res, 404, { error: { message: 'Project not found', code: 'not_found' } });
      return json(res, 200, { archived: true, projects: data.listProjects() });
    }
    if (sub === 'files' && req.method === 'GET') {
      return json(res, 200, { files: data.filesForProject(id, 100) });
    }
    if (sub === 'duplicate' && req.method === 'POST') {
      guard(ctx, 'write');
      const project = data.duplicateProject(id);
      if (!project) return json(res, 404, { error: { message: 'Project not found', code: 'not_found' } });
      return json(res, 201, { project, projects: data.listProjects() });
    }
  }

  if (group === 'prompts' && id && sub === 'use' && req.method === 'POST') {
    guard(ctx, 'write');
    const prompt = data.incrementPromptUses(id);
    if (!prompt) return json(res, 404, { error: { message: 'Prompt not found', code: 'not_found' } });
    return json(res, 200, { prompt });
  }

  if (group === 'automations' && id) {
    if (!sub && (req.method === 'PATCH' || req.method === 'PUT')) {
      guard(ctx, 'write');
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
      const automation = data.updateAutomation(id, patch, { timeZone: data.getSettings().timezone || 'UTC' });
      if (!automation) return json(res, 404, { error: { message: 'Automation not found', code: 'not_found' } });
      return json(res, 200, { automation: withRunLabel(automation), automations: data.listAutomations().map(withRunLabel) });
    }
    if (sub === 'run' && req.method === 'POST') {
      guard(ctx, 'run');
      return runAutomation(ctx, id);
    }
    if (sub === 'runs' && req.method === 'GET') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 10, 1), 100);
      return json(res, 200, { runs: data.listAutomationRuns(id, limit) });
    }
  }

  if (group === 'files' && id) {
    if (req.method === 'GET' || req.method === 'HEAD') return serveStoredFile(ctx, id, url.searchParams?.get('download') === '1');
    if (req.method === 'DELETE') {
      guard(ctx, 'write');
      const removed = files.forWorkspace(data).remove(id);
      if (!removed) return json(res, 404, { error: { message: 'File not found', code: 'not_found' } });
      return json(res, 200, { deleted: true, storage: data.fileStats() });
    }
  }

  if (group === 'generations' && id && req.method === 'GET') {
    const generation = data.getGeneration(id);
    if (!generation) return json(res, 404, { error: { message: 'Generation not found', code: 'not_found' } });
    return json(res, 200, { generation, files: data.filesForGeneration(id) });
  }

  return json(res, 404, { error: { message: `No API route for ${req.method} ${pathname}`, code: 'not_found' } });
}

/**
 * "Run now" goes through the same executor the scheduler uses, so manual and
 * scheduled runs are recorded identically.
 */
async function runAutomation(ctx, id) {
  const { res, data } = ctx;
  const automation = data.getAutomation(id);
  if (!automation) return json(res, 404, { error: { message: 'Automation not found', code: 'not_found' } });

  const result = await automations.execute({ automation, source: 'manual', data });
  if (result.status === 'failed') {
    return json(res, 502, { error: { message: result.message, code: 'automation_failed' }, status: 'failed', output: result.output });
  }

  // A manual run shifts the clock forward, so pressing Run never causes a
  // duplicate scheduled run minutes later.
  const settings = data.getSettings();
  data.setNextRun(id, nextRunIso(automation, settings.timezone));

  json(res, 200, {
    automation: withRunLabel(data.getAutomation(id)),
    automations: data.listAutomations().map(withRunLabel),
    status: result.status,
    message: result.message,
    generation: result.generation,
    output: result.output,
    isDemo: result.isDemo,
    usage: data.usageSummary(),
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

  /**
   * The API now authenticates with a cookie, so it is same-origin only: no
   * `Access-Control-Allow-Origin`, no credential sharing, nothing for another
   * site to call with the user's session attached.
   */
  res.setHeader('Access-Control-Allow-Origin', 'same-origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: { message: 'Method not allowed', code: 'method_not_allowed' } });
      return serveStatic(req, res, pathname);
    }

    // A stream can outlive the browser tab that started it. Without this, the
    // socket's 'error' event is unhandled and takes the whole server down.
    res.on('error', (error) => {
      if (error?.code !== 'ERR_STREAM_WRITE_AFTER_END' && error?.code !== 'EPIPE') {
        console.error('Response error:', error?.message);
      }
    });

    const ctx = buildContext(req, res, url, pathname);

    /**
     * A cookie is ambient: the browser attaches it to any request that reaches
     * this origin. So every state-changing call has to prove it came from our
     * own pages. Bearer-token clients (scripts, tests) are exempt because they
     * hold the token deliberately rather than inheriting it.
     */
    const mutating = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    const usesCookie = Boolean(parseCookiesHeader(req.headers.cookie)[accounts.cookieName]);
    if (mutating && usesCookie && !sameOrigin(req)) {
      return json(res, 403, { error: { message: 'That request came from another site.', code: 'cross_origin', hint: 'Reload the Studio and try again.' } });
    }

    if (pathname === '/api/generate' && req.method === 'POST') {
      await handleGenerate(ctx);
      return logRequest(req, pathname, 200, started);
    }

    const handler = routes[`${req.method} ${pathname}`];
    if (handler) {
      await handler(ctx);
      return logRequest(req, pathname, res.statusCode, started);
    }
    await handleItemRoute(ctx);
    logRequest(req, pathname, res.statusCode, started);
  } catch (error) {
    if (res.headersSent) {
      if (!res.writableEnded) {
        // A stream already started: report the failure inside the stream.
        res.write(`event: error\ndata: ${JSON.stringify({ message: error?.message || 'Stream failed', code: error?.code || 'stream_error' })}\n\n`);
        res.end();
      } else {
        console.error(`Generation stream failed after it closed: ${error?.message}`);
      }
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
  if (accounts.isFirstRun()) {
    console.log('  → no accounts yet: the first sign-up claims the seeded workspace');
  } else {
    const accountCount = store.countUsers();
    console.log(`  → ${accountCount} account${accountCount === 1 ? '' : 's'} · sign in to continue`);
  }

  // Catch up on anything that came due while the server was off, once.
  scheduler.tickOnce({ reason: 'startup' }).catch((error) => console.error('Startup schedule check failed:', error.message));
  scheduler.start();
  console.log('');
});
