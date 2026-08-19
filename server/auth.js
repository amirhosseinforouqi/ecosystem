'use strict';

const crypto = require('node:crypto');
const { run, get, all, getSetting } = require('./db');
const { ApiError, now, addDays, randomToken, sha256, normalizeEmail } = require('./util');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  return `scrypt:${SCRYPT_PARAMS.N}:${SCRYPT_PARAMS.r}:${SCRYPT_PARAMS.p}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt:')) return false;
  const [, N, r, p, saltB64, hashB64] = stored.split(':');
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(password), salt, expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return crypto.timingSafeEqual(actual, expected);
}

function validatePasswordStrength(password) {
  const p = String(password || '');
  if (p.length < 8) throw new ApiError(400, 'Password must be at least 8 characters long.', 'weak_password');
  if (p.length > 200) throw new ApiError(400, 'Password is too long.', 'weak_password');
  if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) {
    throw new ApiError(400, 'Password must contain at least one letter and one number.', 'weak_password');
  }
}

// ---------------------------------------------------------------------------
// Sessions

function createSession(userId, ip, userAgent) {
  const token = randomToken(32);
  const days = getSetting('security', {}).session_days || 7;
  run(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    sha256(token), userId, now(), addDays(now(), days), now(), ip || '', String(userAgent || '').slice(0, 300)
  );
  return token;
}

function getSessionUser(token) {
  if (!token) return null;
  const session = get(
    'SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?',
    sha256(token), now()
  );
  if (!session) return null;
  const user = get("SELECT * FROM users WHERE id = ? AND status = 'active'", session.user_id);
  if (!user) return null;
  // Sliding expiry, refreshed at most every 10 minutes to avoid write churn.
  if (!session.last_seen_at || Date.now() - Date.parse(session.last_seen_at) > 10 * 60 * 1000) {
    const days = getSetting('security', {}).session_days || 7;
    run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', now(), addDays(now(), days), session.id);
  }
  return { user, session };
}

function destroySession(token) {
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

function destroyAllSessions(userId) {
  run('DELETE FROM sessions WHERE user_id = ?', userId);
}

// ---------------------------------------------------------------------------
// One-time tokens (account activation, password reset)

function createAuthToken(userId, kind, hoursValid) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + hoursValid * 3600 * 1000).toISOString();
  run(
    'INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    userId, kind, sha256(token), expires, now()
  );
  return token;
}

function consumeAuthToken(token, kind) {
  const row = get(
    'SELECT * FROM auth_tokens WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?',
    sha256(String(token || '')), kind, now()
  );
  if (!row) return null;
  run('UPDATE auth_tokens SET used_at = ? WHERE id = ?', now(), row.id);
  return row;
}

function peekAuthToken(token, kind) {
  return get(
    'SELECT * FROM auth_tokens WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?',
    sha256(String(token || '')), kind, now()
  );
}

// ---------------------------------------------------------------------------
// Login with rate limiting and temporary lockout

function recordLoginAttempt(email, ip, success) {
  run('INSERT INTO login_attempts (email, ip, success, attempted_at) VALUES (?, ?, ?, ?)', email, ip, success ? 1 : 0, now());
  // Opportunistic cleanup of attempts older than 24h.
  run("DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-1 day')");
}

function ipRecentFailures(ip) {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const row = get(
    'SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND success = 0 AND attempted_at > ?',
    ip, cutoff
  );
  return row ? row.n : 0;
}

function login(email, password, ip, userAgent) {
  const normalized = normalizeEmail(email);
  const security = getSetting('security', {});
  const threshold = security.lockout_threshold || 5;
  const lockMinutes = security.lockout_minutes || 15;

  if (ipRecentFailures(ip) >= 25) {
    throw new ApiError(429, 'Too many sign-in attempts. Please wait a few minutes and try again.', 'rate_limited');
  }

  const user = get('SELECT * FROM users WHERE email = ?', normalized);

  if (user && user.locked_until && user.locked_until > now()) {
    recordLoginAttempt(normalized, ip, false);
    throw new ApiError(423, 'This account is temporarily locked after repeated failed attempts. Please try again later or reset your password.', 'locked');
  }

  const ok = user && user.status === 'active' && user.password_hash && verifyPassword(password, user.password_hash);
  if (!ok) {
    recordLoginAttempt(normalized, ip, false);
    if (user) {
      const failures = (user.failed_attempts || 0) + 1;
      if (failures >= threshold) {
        const until = new Date(Date.now() + lockMinutes * 60 * 1000).toISOString();
        run('UPDATE users SET failed_attempts = 0, locked_until = ? WHERE id = ?', until, user.id);
      } else {
        run('UPDATE users SET failed_attempts = ? WHERE id = ?', failures, user.id);
      }
    }
    throw new ApiError(401, 'Incorrect email or password.', 'bad_credentials');
  }

  run('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', now(), user.id);
  recordLoginAttempt(normalized, ip, true);
  const token = createSession(user.id, ip, userAgent);
  return { user, token };
}

// ---------------------------------------------------------------------------
// Authorization

const STAFF_ROLES = ['admin', 'manager', 'broker', 'processor', 'assistant'];

function permissionsForRole(role) {
  if (role === 'client') return [];
  const map = getSetting('role_permissions', {});
  const { DEFAULT_ROLE_PERMISSIONS } = require('./seed');
  return map[role] || DEFAULT_ROLE_PERMISSIONS[role] || [];
}

function hasPermission(user, permission) {
  return permissionsForRole(user.role).includes(permission);
}

/** Middleware: any signed-in user. */
function requireAuth(ctx) {
  if (!ctx.user) throw new ApiError(401, 'Please sign in to continue.', 'unauthenticated');
}

/** Middleware: any brokerage staff member. */
function requireStaff(ctx) {
  requireAuth(ctx);
  if (!STAFF_ROLES.includes(ctx.user.role)) {
    throw new ApiError(403, 'This area is only available to brokerage staff.', 'forbidden');
  }
}

/** Middleware: client portal users only. */
function requireClient(ctx) {
  requireAuth(ctx);
  if (ctx.user.role !== 'client') {
    throw new ApiError(403, 'This area is only available to clients.', 'forbidden');
  }
}

function requirePermission(permission) {
  return (ctx) => {
    requireStaff(ctx);
    if (!hasPermission(ctx.user, permission)) {
      throw new ApiError(403, 'You do not have permission to do that. Ask an administrator if you need access.', 'forbidden');
    }
  };
}

/** File IDs a client user may access — derived server-side from applicant links only. */
function clientFileIds(userId) {
  return all('SELECT DISTINCT file_id FROM applicants WHERE portal_user_id = ?', userId).map((r) => r.file_id);
}

/** Load a file for a client user, enforcing ownership. Throws 404 (not 403) to avoid leaking existence. */
function clientFileOrThrow(userId, fileId) {
  const ids = clientFileIds(userId);
  if (!ids.includes(Number(fileId))) throw new ApiError(404, 'Not found.', 'not_found');
  const file = get('SELECT * FROM client_files WHERE id = ?', Number(fileId));
  if (!file) throw new ApiError(404, 'Not found.', 'not_found');
  return file;
}

module.exports = {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  createSession,
  getSessionUser,
  destroySession,
  destroyAllSessions,
  createAuthToken,
  consumeAuthToken,
  peekAuthToken,
  login,
  recordLoginAttempt,
  STAFF_ROLES,
  permissionsForRole,
  hasPermission,
  requireAuth,
  requireStaff,
  requireClient,
  requirePermission,
  clientFileIds,
  clientFileOrThrow,
};
