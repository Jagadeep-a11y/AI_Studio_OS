import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SEED_ACTIVITY, SEED_AUTOMATIONS, SEED_PROJECTS, SEED_PROMPTS, SEED_SETTINGS } from './seed.js';
import { describeSchedule, nextOccurrence } from './schedule.js';

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
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  trigger      TEXT NOT NULL DEFAULT 'On demand',
  trigger_label TEXT NOT NULL DEFAULT 'Manual only',
  schedule     TEXT,
  next_run_at  TEXT,
  last_status  TEXT,
  action       TEXT NOT NULL DEFAULT 'Curate & summarize',
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

CREATE TABLE IF NOT EXISTS files (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL DEFAULT 0,
  path          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'attachment',
  excerpt       TEXT NOT NULL DEFAULT '',
  project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
  generation_id TEXT REFERENCES generations(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS files_project_idx ON files (project_id);
CREATE INDEX IF NOT EXISTS files_generation_idx ON files (generation_id);

CREATE TABLE IF NOT EXISTS activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  icon       TEXT NOT NULL DEFAULT 'sparkles',
  tone       TEXT NOT NULL DEFAULT '',
  line       TEXT NOT NULL,
  project    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
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
  addColumn('automations', 'schedule', 'TEXT');
  addColumn('automations', 'trigger_label', "TEXT NOT NULL DEFAULT 'Manual only'");
  addColumn('automations', 'next_run_at', 'TEXT');
  addColumn('automations', 'last_status', 'TEXT');
}

function seedIfEmpty(db) {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM projects').get();
  if (count > 0) return;

  const insertProject = db.prepare(`INSERT INTO projects (id, title, type, model, status, prompt, art, outputs, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const project of SEED_PROJECTS) {
    const created = minutesAgoIso(project.ageMinutes + 240);
    insertProject.run(project.id, project.title, project.type, project.model, project.status, project.prompt, project.art, project.outputs, created, minutesAgoIso(project.ageMinutes));
  }

  const insertPrompt = db.prepare('INSERT INTO prompts (id, title, category, icon, mode, body, uses, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  for (const prompt of SEED_PROMPTS) insertPrompt.run(prompt.id, prompt.title, prompt.category, prompt.icon, prompt.mode, prompt.text, prompt.uses, minutesAgoIso(5_000));

  const insertAutomation = db.prepare(`INSERT INTO automations
    (id, name, description, trigger, trigger_label, schedule, next_run_at, action, last_run, enabled, tone, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const automation of SEED_AUTOMATIONS) {
    const schedule = automation.schedule || { type: 'manual' };
    const nextRun = nextOccurrence(schedule, Date.now(), SEED_SETTINGS.timezone);
    insertAutomation.run(
      automation.id, automation.name, automation.description, automation.trigger, describeSchedule(schedule),
      JSON.stringify(schedule), nextRun ? new Date(nextRun).toISOString() : null,
      automation.action, null, automation.enabled ? 1 : 0, automation.tone, minutesAgoIso(9_000),
    );
  }

  const insertActivity = db.prepare('INSERT INTO activity (icon, tone, line, project, created_at) VALUES (?, ?, ?, ?, ?)');
  for (const item of SEED_ACTIVITY) insertActivity.run(item.icon, item.tone, item.line, item.project, minutesAgoIso(item.ageMinutes));

  const insertSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(SEED_SETTINGS)) insertSetting.run(key, String(value));
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
    // The stored filename (not a path): the file store resolves it against the
    // uploads directory, and clients read files through `url` instead.
    storedPath: row.path,
    excerpt: row.excerpt || '',
    projectId: row.project_id,
    generationId: row.generation_id,
    created: row.created_at,
    url: `/api/files/${row.id}`,
    isImage: String(row.mime || '').startsWith('image/'),
    createdLabel: relativeTime(row.created_at),
  };
}

export function activityFromRow(row) {
  return { id: row.id, icon: row.icon, tone: row.tone, line: row.line, project: row.project, time: relativeTime(row.created_at) };
}
