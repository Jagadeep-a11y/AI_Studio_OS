-- The schema as it existed before accounts and workspaces were introduced
-- (Phase 3, commit 8e4e052). The self test builds a database with this schema and
-- real rows, then boots the current server against it to prove that an existing
-- studio is migrated rather than lost.
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
