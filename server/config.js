import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

/**
 * Minimal `.env` reader so the app has zero runtime dependencies.
 * Existing `process.env` values always win, which keeps real deployments
 * (Docker, CI, hosting dashboards) authoritative over a stray local file.
 */
function readEnvFile(file) {
  const values = {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return values;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

const fileEnv = { ...readEnvFile(path.join(ROOT, '.env')), ...readEnvFile(path.join(ROOT, '.env.local')) };
const env = { ...fileEnv, ...process.env };

const str = (key, fallback = '') => {
  const value = env[key];
  return value === undefined || value === null || String(value).trim() === '' ? fallback : String(value).trim();
};

/** Note: Number('') is 0, so an unset variable must be caught before parsing. */
const num = (key, fallback) => {
  const raw = str(key, '');
  if (raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

/**
 * Hosting platforms often inject PORT. An empty or 0 value means "any free
 * port", which is useless for a preview URL, so those fall back to the
 * documented default instead.
 */
const positiveInt = (key, fallback) => {
  const value = Number.parseInt(str(key, ''), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const bool = (key, fallback = false) => {
  const value = str(key, '').toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
};

/** Absolute paths keep the SQLite file predictable no matter where node is run from. */
function resolveDbPath(value) {
  if (value === ':memory:' || value.startsWith('file:')) return value;
  return path.isAbsolute(value) ? value : path.resolve(ROOT, value);
}

/**
 * Uploads sit next to the database by default, so "where is my data?" has one
 * answer. A throwaway database gets a throwaway upload directory instead of
 * scattering test files through the repository.
 */
function resolveUploadsDir(explicit, dbPath) {
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.resolve(ROOT, explicit);
  if (dbPath === ':memory:' || dbPath.startsWith('file:')) {
    return path.join(os.tmpdir(), 'ai-studio-os-uploads');
  }
  return path.join(path.dirname(dbPath), 'uploads');
}

const requestTimeoutMs = num('AI_STUDIO_TIMEOUT_MS', 60_000);

export const config = {
  root: ROOT,
  host: str('AI_STUDIO_HOST', '0.0.0.0'),
  port: positiveInt('PORT', positiveInt('AI_STUDIO_PORT', 4173)),
  dbPath: resolveDbPath(str('AI_STUDIO_DB', './data/studio.db')),
  workspace: str('AI_STUDIO_WORKSPACE', 'Northstar Studio'),
  timeoutMs: requestTimeoutMs,
  uploadsDir: '',
  scheduler: {
    enabled: bool('AI_STUDIO_SCHEDULER', true),
    // Floors rather than limits: a tick every 500ms is fine for tests, a tick
    // every 30s is sane in normal use, and neither can be set to zero.
    tickMs: Math.max(250, num('AI_STUDIO_SCHEDULER_TICK_MS', 30_000)),
    maxPerTick: Math.min(10, positiveInt('AI_STUDIO_SCHEDULER_MAX_PER_TICK', 3)),
    backoffMs: Math.max(5_000, num('AI_STUDIO_SCHEDULER_BACKOFF_MS', 5 * 60_000)),
  },
  allowMock: bool('AI_STUDIO_ALLOW_MOCK', true),
  providerOrder: str('AI_STUDIO_PROVIDER_ORDER', 'openai,anthropic,gemini,ollama,mock')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
  envFileLoaded: Boolean(env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || env.GEMINI_API_KEY),
  providers: {
    openai: {
      timeoutMs: requestTimeoutMs,
      apiKey: str('OPENAI_API_KEY', ''),
      baseUrl: str('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      chatPath: str('OPENAI_CHAT_PATH', '/chat/completions'),
      imagesPath: str('OPENAI_IMAGES_PATH', '/images/generations'),
    },
    anthropic: {
      timeoutMs: requestTimeoutMs,
      apiKey: str('ANTHROPIC_API_KEY', ''),
      baseUrl: str('ANTHROPIC_BASE_URL', 'https://api.anthropic.com/v1'),
      version: str('ANTHROPIC_VERSION', '2023-06-01'),
    },
    gemini: {
      timeoutMs: requestTimeoutMs,
      apiKey: str('GEMINI_API_KEY', str('GOOGLE_API_KEY', '')),
      baseUrl: str('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta'),
    },
    ollama: {
      timeoutMs: requestTimeoutMs,
      enabled: bool('OLLAMA_ENABLED', false),
      baseUrl: str('OLLAMA_BASE_URL', 'http://127.0.0.1:11434'),
    },
    mock: {
      enabled: true,
      label: 'Studio demo engine',
    },
  },
};

config.uploadsDir = resolveUploadsDir(str('AI_STUDIO_UPLOADS', ''), config.dbPath);

/**
 * Object storage.
 *
 * `local` is the default and needs nothing. `s3` covers anything that speaks the
 * S3 REST API — AWS, Cloudflare R2, MinIO, Backblaze B2, DigitalOcean Spaces —
 * because they differ only in endpoint, region, and URL style.
 *
 * The S3 credentials are kept even when local storage is active: rows remember
 * which driver holds their bytes, so a switch back to local must not make
 * already-uploaded files unreadable.
 */
const storageDriver = str('AI_STUDIO_STORAGE', 'local').toLowerCase() === 's3' ? 's3' : 'local';
const s3Bucket = str('AI_STUDIO_S3_BUCKET', '');
const s3AccessKey = str('AI_STUDIO_S3_ACCESS_KEY', str('AWS_ACCESS_KEY_ID', ''));
const s3SecretKey = str('AI_STUDIO_S3_SECRET_KEY', str('AWS_SECRET_ACCESS_KEY', ''));

config.storage = {
  driver: storageDriver,
  uploadsDir: config.uploadsDir,
  // Serve a presigned URL instead of streaming through the API. Faster and
  // cheaper for large files, but anyone with the link has the bytes for as long
  // as it lives — so it is off unless an operator asks for it.
  redirect: bool('AI_STUDIO_STORAGE_REDIRECT', false),
  presignTtlMs: Math.max(30_000, num('AI_STUDIO_STORAGE_PRESIGN_MS', 5 * 60_000)),
  s3: s3Bucket || s3AccessKey
    ? {
      bucket: s3Bucket,
      endpoint: str('AI_STUDIO_S3_ENDPOINT', ''),
      region: str('AI_STUDIO_S3_REGION', str('AWS_REGION', 'auto')),
      accessKeyId: s3AccessKey,
      secretAccessKey: s3SecretKey,
      sessionToken: str('AI_STUDIO_S3_SESSION_TOKEN', str('AWS_SESSION_TOKEN', '')),
      prefix: str('AI_STUDIO_S3_PREFIX', 'studio'),
      // MinIO and most self-hosted gateways want path-style; AWS and R2 accept
      // both, so path-style is the safer default and `0` switches to vhost.
      pathStyle: bool('AI_STUDIO_S3_PATH_STYLE', true),
      timeoutMs: num('AI_STUDIO_S3_TIMEOUT_MS', 30_000),
      presignTtlMs: Math.max(30_000, num('AI_STUDIO_STORAGE_PRESIGN_MS', 5 * 60_000)),
    }
    : null,
};

/**
 * Accounts and sessions. The defaults are sized for a small studio: a month-long
 * sliding session, week-long invites, and sign-in throttling that stops a
 * password-guessing loop without locking anyone out of their own workspace.
 */
config.auth = {
  sessionTtlDays: Math.min(365, Math.max(1, num('AI_STUDIO_SESSION_TTL_DAYS', 30))),
  inviteTtlDays: Math.min(90, Math.max(1, num('AI_STUDIO_INVITE_TTL_DAYS', 7))),
  allowSignups: bool('AI_STUDIO_ALLOW_SIGNUPS', true),
  loginMaxAttempts: Math.max(3, num('AI_STUDIO_LOGIN_MAX_ATTEMPTS', 10)),
  signupMaxAttempts: Math.max(3, num('AI_STUDIO_SIGNUP_MAX_ATTEMPTS', 10)),
  loginWindowMs: Math.max(60_000, num('AI_STUDIO_LOGIN_WINDOW_MS', 15 * 60_000)),
  maxWorkspacesPerUser: Math.max(1, num('AI_STUDIO_MAX_WORKSPACES', 10)),
};

/** Secrets never travel to the browser; this is the only shape clients ever see. */
export function providerSummary() {
  return [
    {
      id: 'openai',
      label: 'OpenAI',
      requiresKey: true,
      configured: Boolean(config.providers.openai.apiKey),
      hint: 'Set OPENAI_API_KEY in .env to generate with OpenAI models.',
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      requiresKey: true,
      configured: Boolean(config.providers.anthropic.apiKey),
      hint: 'Set ANTHROPIC_API_KEY in .env to generate with Claude models.',
    },
    {
      id: 'gemini',
      label: 'Google Gemini',
      requiresKey: true,
      configured: Boolean(config.providers.gemini.apiKey),
      hint: 'Set GEMINI_API_KEY in .env to generate with Gemini models.',
    },
    {
      id: 'ollama',
      label: 'Ollama (local)',
      requiresKey: false,
      configured: Boolean(config.providers.ollama.enabled),
      hint: 'Set OLLAMA_ENABLED=1 and run the Ollama daemon to use local models.',
    },
    {
      id: 'mock',
      label: 'Studio demo engine',
      requiresKey: false,
      configured: config.allowMock,
      hint: 'Local placeholder engine used when no provider key is available.',
    },
  ].map((provider) => ({ ...provider, ...(provider.id === 'mock' ? { isDemo: true } : {}) }));
}

export const anyRealProviderConfigured = () =>
  Boolean(config.providers.openai.apiKey || config.providers.anthropic.apiKey || config.providers.gemini.apiKey || config.providers.ollama.enabled);
