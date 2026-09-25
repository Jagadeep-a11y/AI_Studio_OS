import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SEED_ACTIVITY, SEED_AUTOMATIONS, SEED_PROJECTS, SEED_PROMPTS, SEED_SETTINGS } from './seed.js';
import { describeSchedule, nextOccurrence } from './schedule.js';
import { initialsFor } from './auth.js';

/**
 * SQLite persistence layer.
 *
 * Uses the built-in `node:sqlite` driver, so there is nothing to install and
 * nothing to compile. Every query in the app goes through this module: if the
 * storage layer ever moves to Postgres, this is the only file that changes.
 */

export const nowIso = () => new Date().toISOString();
export const minutesAgoIso = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
export const newId = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;

/**
 * Turns a timestamp into the relative label the prototype UI uses
 * ("12 min ago", "Yesterday"). Kept server-side so every client agrees.
 */
export function relativeTime(value) {
  if (!value) return 'Just now';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return 'Just now';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(then));
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'Campaign',
  model       TEXT NOT NULL DEFAULT 'Auto select',
  status      TEXT NOT NULL DEFAULT 'Draft',
  prompt      TEXT NOT NULL DEFAULT '',
  art         TEXT,
  outputs     INTEGER NOT NULL DEFAULT 0,
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generations (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id   TEXT REFERENCES projects(id) ON DELETE SET NULL,
  provider     TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  model_label  TEXT NOT NULL,
  kind         TEXT NOT NULL,
  mode         TEXT NOT NULL DEFAULT 'Writing',
  prompt       TEXT NOT NULL,
  output       TEXT NOT NULL DEFAULT '',
  asset_url    TEXT,
  status       TEXT NOT NULL DEFAULT 'queued',
  error        TEXT,
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  credits      REAL NOT NULL DEFAULT 0,
  cost_usd     REAL NOT NULL DEFAULT 0,
  latency_ms   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS generations_created_idx ON generations (created_at DESC);
CREATE INDEX IF NOT EXISTS generations_project_idx ON generations (project_id);

CREATE TABLE IF NOT EXISTS prompts (
  id         TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  category   TEXT NOT NULL,
  icon       TEXT NOT NULL DEFAULT 'sparkles',
  mode       TEXT NOT NULL DEFAULT 'Writing',
  body       TEXT NOT NULL,
  uses       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automations (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  trigger      TEXT NOT NULL DEFAULT 'On demand',
  trigger_label TEXT NOT NULL DEFAULT 'Manual only',
  schedule     TEXT,
  next_run_at  TEXT,
  last_status  TEXT,
  action       TEXT NOT NULL DEFAULT 'Curate & summarize',
  steps        TEXT,
  time_zone    TEXT,
  last_run     TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  tone         TEXT NOT NULL DEFAULT 'purple',
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id            TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  generation_id TEXT REFERENCES generations(id) ON DELETE SET NULL,
  status        TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_step_runs (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  action        TEXT NOT NULL,
  status        TEXT NOT NULL,
  message       TEXT NOT NULL DEFAULT '',
  ms            INTEGER NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 1,
  generation_id TEXT,
  file_id       TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL DEFAULT 0,
  path          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'attachment',
  excerpt       TEXT NOT NULL DEFAULT '',
  project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
  generation_id  TEXT REFERENCES generations(id) ON DELETE SET NULL,
  -- Which driver holds the bytes, and the key it knows them by. Rows written
  -- before object storage existed are 'local' with the filename they already have.
  storage_driver TEXT NOT NULL DEFAULT 'local',
  storage_key    TEXT,
  created_at     TEXT NOT NULL
);


CREATE TABLE IF NOT EXISTS activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  icon       TEXT NOT NULL DEFAULT 'sparkles',
  tone       TEXT NOT NULL DEFAULT '',
  line       TEXT NOT NULL,
  project    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  plan       TEXT NOT NULL DEFAULT 'Studio plan',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar        TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  last_seen_at  TEXT
);

CREATE TABLE IF NOT EXISTS memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'editor',
  created_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT,
  created_at   TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  user_agent   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS invites (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'editor',
  token_hash   TEXT NOT NULL,
  invited_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  accepted_at  TEXT,
  accepted_by  TEXT
);
CREATE INDEX IF NOT EXISTS invites_workspace_idx ON invites (workspace_id);

CREATE TABLE IF NOT EXISTS settings (
  workspace_id TEXT NOT NULL,
  key   TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);
`;

/**
 * Indexes are created *after* the migration, never inside SCHEMA: an index on a
 * column that an older database only gains during migration would otherwise fail
 * the whole schema exec (“no such column”), which is how a studio that predates
 * workspaces would stop booting.
 */
const INDEXES = `
CREATE INDEX IF NOT EXISTS projects_workspace_idx ON projects (workspace_id);
CREATE INDEX IF NOT EXISTS generations_workspace_idx ON generations (workspace_id);
CREATE INDEX IF NOT EXISTS prompts_workspace_idx ON prompts (workspace_id);
CREATE INDEX IF NOT EXISTS automations_workspace_idx ON automations (workspace_id);
CREATE INDEX IF NOT EXISTS files_workspace_idx ON files (workspace_id);
CREATE INDEX IF NOT EXISTS activity_workspace_idx ON activity (workspace_id);
CREATE INDEX IF NOT EXISTS step_runs_run_idx ON automation_step_runs (run_id, position);
CREATE INDEX IF NOT EXISTS files_project_idx ON files (project_id);
CREATE INDEX IF NOT EXISTS files_generation_idx ON files (generation_id);
`;

export function openDatabase(dbPath) {
  if (dbPath !== ':memory:' && !dbPath.startsWith('file:')) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  db.exec(INDEXES);
  seedIfEmpty(db);
  return db;
}

/**
 * Additive migrations for databases created by an earlier version.
 *
 * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so new columns are
 * added deliberately here. The app is a prototype but it does keep a real
 * database on disk, and losing a user's workspace to a schema change is not
 * acceptable.
 */
function migrate(db) {
  const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  const addColumn = (table, name, definition) => {
    if (!columnsOf(table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition};`);
  };
  // Object storage: existing rows keep their bytes on disk, so they are marked
  // as local and keyed by the filename they were already stored under.
  addColumn('files', 'storage_driver', "TEXT NOT NULL DEFAULT 'local'");
  addColumn('files', 'storage_key', 'TEXT');
  db.prepare("UPDATE files SET storage_key = path WHERE storage_key IS NULL").run();

  addColumn('automations', 'schedule', 'TEXT');
  // Chain steps and a per-automation time zone (a Monday 9am digest should mean
  // 9am where the studio is, not where the server happens to run).
  addColumn('automations', 'steps', 'TEXT');
  addColumn('automations', 'time_zone', 'TEXT');
  addColumn('automations', 'trigger_label', "TEXT NOT NULL DEFAULT 'Manual only'");
  addColumn('automations', 'next_run_at', 'TEXT');
  addColumn('automations', 'last_status', 'TEXT');

  // Tenancy: every row of content belongs to a workspace. Adding the columns is
  // additive; the backfill below decides which workspace the old rows belong to.
  for (const table of ['projects', 'generations', 'prompts', 'automations', 'files', 'activity']) {
    addColumn(table, 'workspace_id', 'TEXT');
  }
  migrateSettingsToWorkspaces(db);
  backfillLegacyWorkspace(db);
}

/**
 * `settings` used to be a global key/value table. Workspaces each have their own
 * preferences now, so the primary key has to gain a column — which SQLite can
 * only do by rebuilding the table. Old values are copied, never dropped.
 */
function migrateSettingsToWorkspaces(db) {
  const columns = db.prepare('PRAGMA table_info(settings)').all().map((row) => row.name);
  if (columns.includes('workspace_id')) return;

  const legacy = db.prepare('SELECT key, value FROM settings').all();
  db.exec('ALTER TABLE settings RENAME TO settings_legacy;');
  db.exec(`
    CREATE TABLE settings (
      workspace_id TEXT NOT NULL,
      key   TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (workspace_id, key)
    );`);
  const workspace = ensureLegacyWorkspace(db, legacy);
  const insert = db.prepare('INSERT OR REPLACE INTO settings (workspace_id, key, value) VALUES (?, ?, ?)');
  for (const row of legacy) insert.run(workspace.id, row.key, row.value);
  db.exec('DROP TABLE settings_legacy;');
}

/**
 * A database that predates accounts has content but nobody to own it. Rather
 * than inventing a user with a password nobody knows, the content is parked in a
 * workspace with no members: the next account created claims it (see
 * `adoptOrphanWorkspace` in the store). That keeps the demo workspace reachable
 * without shipping a default password.
 */
function ensureLegacyWorkspace(db, legacySettings = []) {
  const existing = db.prepare('SELECT * FROM workspaces ORDER BY created_at ASC LIMIT 1').get();
  if (existing) return existing;

  const name = (legacySettings.find((row) => row.key === 'workspace')?.value
    || db.prepare("SELECT value FROM settings WHERE key = 'workspace'").get()?.value
    || 'Northstar Studio');
  const id = newId('w');
  db.prepare('INSERT INTO workspaces (id, name, owner_id, plan, created_at) VALUES (?, ?, NULL, ?, ?)')
    .run(id, name, 'Studio plan', nowIso());
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
}

function backfillLegacyWorkspace(db) {
  const orphans = db.prepare('SELECT COUNT(*) AS count FROM projects WHERE workspace_id IS NULL').get();
  const total = db.prepare('SELECT COUNT(*) AS count FROM projects').get();
  if (!total.count || !orphans.count) return;

  const workspace = ensureLegacyWorkspace(db);
  for (const table of ['projects', 'generations', 'prompts', 'automations', 'files', 'activity']) {
    db.prepare(`UPDATE ${table} SET workspace_id = ? WHERE workspace_id IS NULL`).run(workspace.id);
  }
}

function seedIfEmpty(db) {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM projects').get();
  if (count > 0) return;

  // The demo workspace starts with no members: the first person to sign up
  // adopts it, so the seeded studio is never owned by a password we shipped.
  const workspaceId = newId('w');
  db.prepare('INSERT INTO workspaces (id, name, owner_id, plan, created_at) VALUES (?, ?, NULL, ?, ?)')
    .run(workspaceId, SEED_SETTINGS.workspace || 'Northstar Studio', 'Studio plan', nowIso());

  const insertProject = db.prepare(`INSERT INTO projects (id, workspace_id, title, type, model, status, prompt, art, outputs, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const project of SEED_PROJECTS) {
    const created = minutesAgoIso(project.ageMinutes + 240);
    insertProject.run(project.id, workspaceId, project.title, project.type, project.model, project.status, project.prompt, project.art, project.outputs, created, minutesAgoIso(project.ageMinutes));
  }

  const insertPrompt = db.prepare('INSERT INTO prompts (id, workspace_id, title, category, icon, mode, body, uses, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const prompt of SEED_PROMPTS) insertPrompt.run(prompt.id, workspaceId, prompt.title, prompt.category, prompt.icon, prompt.mode, prompt.text, prompt.uses, minutesAgoIso(5_000));

  const insertAutomation = db.prepare(`INSERT INTO automations
    (id, workspace_id, name, description, trigger, trigger_label, schedule, next_run_at, action, last_run, enabled, tone, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const automation of SEED_AUTOMATIONS) {
    const schedule = automation.schedule || { type: 'manual' };
    const nextRun = nextOccurrence(schedule, Date.now(), SEED_SETTINGS.timezone);
    insertAutomation.run(
      automation.id, workspaceId, automation.name, automation.description, automation.trigger, describeSchedule(schedule),
      JSON.stringify(schedule), nextRun ? new Date(nextRun).toISOString() : null,
      automation.action, null, automation.enabled ? 1 : 0, automation.tone, minutesAgoIso(9_000),
    );
  }

  const insertActivity = db.prepare('INSERT INTO activity (workspace_id, icon, tone, line, project, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const item of SEED_ACTIVITY) insertActivity.run(workspaceId, item.icon, item.tone, item.line, item.project, minutesAgoIso(item.ageMinutes));

  const insertSetting = db.prepare('INSERT INTO settings (workspace_id, key, value) VALUES (?, ?, ?)');
  for (const [key, value] of Object.entries(SEED_SETTINGS)) insertSetting.run(workspaceId, key, String(value));
}

// --- Row shaping ------------------------------------------------------------

export function projectFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    model: row.model,
    status: row.status,
    prompt: row.prompt || '',
    art: row.art,
    outputs: row.outputs,
    archived: Boolean(row.archived),
    created: row.created_at,
    updatedAt: row.updated_at,
    updated: relativeTime(row.updated_at),
  };
}

export function generationFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    provider: row.provider,
    modelId: row.model_id,
    model: row.model_label,
    kind: row.kind,
    mode: row.mode,
    prompt: row.prompt,
    output: row.output || '',
    assetUrl: row.asset_url || '',
    status: row.status,
    error: row.error || '',
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    credits: row.credits,
    costUsd: row.cost_usd,
    latencyMs: row.latency_ms,
    created: row.created_at,
    finished: row.finished_at,
    createdLabel: relativeTime(row.created_at),
  };
}

export function promptFromRow(row) {
  if (!row) return null;
  return { id: row.id, title: row.title, category: row.category, icon: row.icon, mode: row.mode, text: row.body, uses: row.uses };
}

/** Stored steps are JSON; a malformed value must not take the page down. */
function parseSteps(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function automationFromRow(row, lastRun = null) {
  if (!row) return null;
  let schedule = null;
  try {
    schedule = row.schedule ? JSON.parse(row.schedule) : null;
  } catch {
    schedule = null;
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    trigger: row.trigger,
    triggerLabel: row.trigger_label || describeSchedule(schedule),
    schedule: schedule || { type: 'manual' },
    nextRunAt: row.next_run_at || null,
    action: row.action,
    steps: parseSteps(row.steps),
    timeZone: row.time_zone || null,
    lastRun: lastRun || row.last_run || 'Not run yet',
    lastRunAt: row.last_run || null,
    lastStatus: row.last_status || null,
    enabled: Boolean(row.enabled),
    tone: row.tone,
  };
}

export function fileFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    kind: row.kind,
    // Where the bytes live: which driver, and the key that driver knows. `path`
    // is the pre-object-storage column and is kept only so a database from an
    // earlier version still opens.
    storageDriver: row.storage_driver || 'local',
    storageKey: row.storage_key || row.path,
    excerpt: row.excerpt || '',
    projectId: row.project_id,
    generationId: row.generation_id,
    created: row.created_at,
    url: `/api/files/${row.id}`,
    isImage: String(row.mime || '').startsWith('image/'),
    createdLabel: relativeTime(row.created_at),
  };
}

export function userFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatar: row.avatar || '',
    initials: initialsFor(row.name, row.email),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at || null,
  };
}

export function workspaceFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    ownerId: row.owner_id || null,
    plan: row.plan || 'Studio plan',
    createdAt: row.created_at,
  };
}

export function membershipFromRow(row) {
  if (!row) return null;
  return { workspaceId: row.workspace_id, userId: row.user_id, role: row.role, createdAt: row.created_at };
}

export function inviteFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    email: row.email,
    role: row.role,
    invitedBy: row.invited_by || null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at || null,
    status: row.accepted_at ? 'accepted' : (Date.parse(row.expires_at) < Date.now() ? 'expired' : 'pending'),
  };
}

export function activityFromRow(row) {
  return { id: row.id, icon: row.icon, tone: row.tone, line: row.line, project: row.project, time: relativeTime(row.created_at) };
}
