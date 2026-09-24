import crypto from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Accounts, sessions, and roles.
 *
 * Everything here is built on `node:crypto` — no dependency, no native build.
 * Three decisions worth stating:
 *
 *   • Passwords are stored as scrypt hashes with a per-user salt, never as
 *     anything reversible. The parameters are recorded in the hash string so
 *     they can be raised later without invalidating existing logins.
 *   • Session cookies carry a random token; the database only ever stores its
 *     SHA-256 digest. A stolen database does not hand over live sessions.
 *   • Roles are a ranking, and every check goes through `can()`. Anything that
 *     is not in the matrix is denied, so a new route defaults to closed.
 */

const scrypt = promisify(crypto.scrypt);

export const ROLES = ['owner', 'admin', 'editor', 'viewer'];

const RANK = { owner: 4, admin: 3, editor: 2, viewer: 1 };

/**
 * What each capability needs. A route asks for a capability, not a role, so the
 * matrix can change without touching every handler.
 *
 *   read    — see the workspace (viewers can look at everything)
 *   write   — create and edit content: projects, prompts, generates, uploads
 *   run     — run automations and generate (same rank as write, separate name
 *             so it can diverge later)
 *   manage  — members, invites, workspace settings
 *   own     — the things only an owner may do: delete the workspace, transfer it
 */
const CAPABILITIES = {
  read: 1,
  write: 2,
  run: 2,
  manage: 3,
  own: 4,
};

export const roleRank = (role) => RANK[role] || 0;

/** Can `role` do `capability`? Unknown roles and capabilities are denied. */
export function can(role, capability) {
  const needed = CAPABILITIES[capability];
  if (!needed) return false;
  return roleRank(role) >= needed;
}

export const isRole = (value) => ROLES.includes(String(value || ''));

/**
 * Which roles an actor may hand out. Admins run the everyday work of a
 * workspace; only owners can create peers or change what an admin is.
 */
export function assignableRoles(actorRole) {
  if (actorRole === 'owner') return ['admin', 'editor', 'viewer'];
  if (actorRole === 'admin') return ['editor', 'viewer'];
  return [];
}

/**
 * Can `actorRole` change or remove a member who currently holds `targetRole`?
 * Nobody edits the owner except the owner, and admins cannot touch each other.
 */
export function canManageMember(actorRole, targetRole) {
  if (targetRole === 'owner') return actorRole === 'owner';
  if (actorRole === 'owner') return true;
  if (actorRole === 'admin') return targetRole !== 'admin';
  return false;
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 32 };

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** Constant-time comparison against a stored hash. */
export async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [scheme, n, r, p, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  try {
    const derived = await scrypt(String(password), Buffer.from(salt, 'base64'), Buffer.from(expected, 'base64').length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    const a = Buffer.from(expected, 'base64');
    return derived.length === a.length && crypto.timingSafeEqual(derived, a);
  } catch {
    return false;
  }
}

/**
 * A password check the user can act on: length is the only rule worth having,
 * because complexity rules push people to predictable substitutions.
 */
export function checkPasswordStrength(password) {
  const value = String(password || '');
  if (value.length < 8) return 'Use at least 8 characters for your password.';
  if (value.length > 200) return 'That password is longer than 200 characters.';
  if (/^\s+$/.test(value)) return 'That password is only whitespace.';
  return null;
}

// ---------------------------------------------------------------------------
// Session tokens and cookies
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = 'studio_session';

export const createSessionToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** Parses a `Cookie:` header. Returns {} when there is nothing to parse. */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, secure = false, path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax'];
  if (Number.isFinite(maxAge)) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export const clearCookie = (name, { secure = false } = {}) => serializeCookie(name, '', { maxAge: 0, secure });

/** True when the request arrived over TLS, including behind a proxy. */
export const isSecureRequest = (req) => {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https';
};

/**
 * Cookie-authenticated writes must come from our own origin. A browser sends
 * `Origin` on every non-GET request; if it does not match the host, the request
 * was made from somewhere else with our cookie attached.
 */
export function sameOrigin(req) {
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return true; // non-browser client (curl, tests) — no ambient cookie
  try {
    const host = String(req.headers.host || '');
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * A tiny in-memory limiter for the auth endpoints. Per process, which is honest
 * for a single-server app and useless for a fleet — a shared store is the next
 * step if this ever runs behind a load balancer.
 */
export function createRateLimiter({ windowMs = 15 * 60_000, max = 10 } = {}) {
  const hits = new Map();
  return {
    check(key) {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || now - entry.start > windowMs) {
        hits.set(key, { start: now, count: 1 });
        return { allowed: true, remaining: max - 1 };
      }
      entry.count += 1;
      if (entry.count > max) {
        return { allowed: false, retryAfterMs: windowMs - (now - entry.start) };
      }
      return { allowed: true, remaining: max - entry.count };
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

export const normaliseEmail = (value) => String(value || '').trim().toLowerCase();
export const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));

/** "Alex Chen" → "AC"; falls back to the first letter of an email. */
export function initialsFor(name, email = '') {
  const source = String(name || '').trim() || String(email).split('@')[0];
  const words = source.split(/[\s._-]+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word[0]).join('');
  return (letters || source.slice(0, 2) || '?').toUpperCase();
}
