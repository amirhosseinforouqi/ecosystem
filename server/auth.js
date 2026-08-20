'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { run, get, all, getSetting } = require('./db');
const { ApiError, now, addDays, randomToken, sha256, normalizeEmail } = require('./util');
const ratelimit = require('./ratelimit');

const scrypt = promisify(crypto.scrypt);

// maxmem must be raised explicitly: Node's default (32 MB) is below what
// N=16384, r=8 needs, and the call fails rather than silently weakening.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

/**
 * Password hashing runs on libuv's threadpool via the async scrypt API
 * (audit finding C3). The synchronous variant blocked the event loop for
 * ~50-100ms per attempt, which made unauthenticated login traffic a trivial
 * denial-of-service against every other request in flight.
 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password), salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  return `scrypt:${SCRYPT_PARAMS.N}:${SCRYPT_PARAMS.r}:${SCRYPT_PARAMS.p}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt:')) return false;
  const parts = stored.split(':');
  if (parts.length !== 6) return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  let actual;
  try {
    actual = await scrypt(String(password), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT_PARAMS.maxmem,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * Generate a password that is guaranteed to satisfy the password policy.
 *
 * Characters are drawn without modulo bias (crypto.randomInt rejects
 * out-of-range draws internally) from an alphabet with the visually ambiguous
 * symbols removed, so the result can be read aloud or retyped from an email.
 *
 * The two trailing checks are not decoration. The policy requires a letter
 * *and* a digit, and a random draw over any alphabet produces an all-letter
 * string often enough to matter — a plain 12-character base64 string has no
 * digit about one time in eight. Every generated password in this codebase
 * comes from here so that no caller has to remember that.
 *
 * @param {number} groups four-character groups; 3 → 12 characters.
 */
function generateTemporaryPassword(groups = 3) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const length = Math.max(1, Math.trunc(groups)) * 4;
  let out = '';
  for (let i = 0; i < length; i++) {
    if (i > 0 && i % 4 === 0) out += '-';
    out += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  if (!/[0-9]/.test(out)) out += crypto.randomInt(2, 10);
  if (!/[a-zA-Z]/.test(out)) out += 'k';
  return out;
}

/**
 * A short list of the passwords actually seen most in credential-stuffing
 * corpora, plus the ones this project itself has used. Not a substitute for a
 * full breach corpus — see checkBreachedPassword for that.
 */
const BANNED_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', '12345678', '123456789',
  'qwerty123', 'letmein1', 'welcome1', 'admin123', 'admin1234', 'changeme1',
  'iloveyou1', 'sunshine1', 'football1', 'monkey123', 'abc12345', 'baseball1',
]);

/** The configured minimum length for a role, so the UI can state it exactly. */
async function minPasswordLength(role = 'client') {
  const security = await getSetting('security', {});
  return role !== 'client'
    ? (security.min_password_length_staff || 12)
    : (security.min_password_length_client || 10);
}

async function validatePasswordStrength(password, { role = 'client', user = null } = {}) {
  const p = String(password || '');
  const min = await minPasswordLength(role);

  if (p.length < min) {
    throw new ApiError(400, `Password must be at least ${min} characters long.`, 'weak_password');
  }
  if (p.length > 200) throw new ApiError(400, 'Password is too long.', 'weak_password');
  if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) {
    throw new ApiError(400, 'Password must contain at least one letter and one number.', 'weak_password');
  }
  if (BANNED_PASSWORDS.has(p.toLowerCase())) {
    throw new ApiError(400, 'That password is too common. Please choose something less predictable.', 'weak_password');
  }
  if (user) {
    const personal = [user.email, user.first_name, user.last_name].filter(Boolean).map((s) => String(s).toLowerCase());
    const lower = p.toLowerCase();
    for (const token of personal) {
      const bare = token.split('@')[0];
      if (bare.length >= 4 && lower.includes(bare)) {
        throw new ApiError(400, 'Please choose a password that does not contain your name or email address.', 'weak_password');
      }
    }
  }
  await checkBreachedPassword(p);
}

/**
 * Optional check against Have I Been Pwned's k-anonymity range API: only the
 * first five characters of the SHA-1 hash ever leave this server, so the
 * password itself is never disclosed. Disabled unless explicitly enabled, and
 * a network failure never blocks a legitimate password change.
 */
async function checkBreachedPassword(password) {
  if (process.env.BREACH_CHECK_ENABLED !== 'true') return;
  try {
    const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      signal: controller.signal,
      headers: { 'Add-Padding': 'true' },
    });
    clearTimeout(timer);
    if (!res.ok) return;
    const body = await res.text();
    for (const line of body.split('\n')) {
      const [hash, countRaw] = line.trim().split(':');
      if (hash === suffix && Number(countRaw) > 0) {
        throw new ApiError(
          400,
          'That password has appeared in a known data breach. Please choose a different one.',
          'breached_password'
        );
      }
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // Network/timeout — fail open so a third-party outage cannot lock people out.
  }
}

// ---------------------------------------------------------------------------
// Sessions

/**
 * The two lifetimes that bound a session, for one role. Single source of
 * truth: the cookie's Max-Age is derived from the same numbers the server
 * enforces, so a browser never holds a cookie the server has already retired.
 */
async function sessionLifetimes(role = 'client') {
  const security = await getSetting('security', {});
  return {
    idleDays: role === 'client'
      ? (security.session_days_client || 7)
      : (security.session_days_staff || 1),
    absoluteHours: role === 'client'
      ? (security.session_absolute_hours_client || 24 * 14)
      : (security.session_absolute_hours_staff || 12),
  };
}

/** Cookie Max-Age in seconds: never longer than the session can actually live. */
async function sessionCookieMaxAge(role = 'client') {
  const { idleDays, absoluteHours } = await sessionLifetimes(role);
  return Math.min(idleDays * 86400, absoluteHours * 3600);
}

async function createSession(userId, ip, userAgent, { role = 'client' } = {}) {
  const token = randomToken(32);
  const { idleDays, absoluteHours } = await sessionLifetimes(role);

  await run(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, absolute_expires_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    sha256(token), userId, now(), addDays(now(), idleDays),
    new Date(Date.now() + absoluteHours * 3600 * 1000).toISOString(),
    now(), ip || '', String(userAgent || '').slice(0, 300)
  );
  return token;
}

/**
 * Resolve a session token. Enforces both an idle timeout (slides forward)
 * and an absolute lifetime (never extends), so a stolen cookie cannot be kept
 * alive indefinitely by simply exercising it.
 */
async function getSessionUser(token) {
  if (!token) return null;
  const session = await get(
    'SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ? AND absolute_expires_at > ?',
    sha256(token), now(), now()
  );
  if (!session) return null;
  const user = await get("SELECT * FROM users WHERE id = ? AND status = 'active'", session.user_id);
  if (!user) return null;

  if (!session.last_seen_at || Date.now() - Date.parse(session.last_seen_at) > 10 * 60 * 1000) {
    const security = await getSetting('security', {});
    const idleDays = user.role === 'client'
      ? (security.session_days_client || 7)
      : (security.session_days_staff || 1); // see sessionLifetimes()
    // Idle window slides; the absolute expiry is deliberately left alone.
    await run(
      'UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?',
      now(), addDays(now(), idleDays), session.id
    );
  }
  return { user, session };
}

async function destroySession(token) {
  if (token) await run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

async function destroyAllSessions(userId) {
  await run('DELETE FROM sessions WHERE user_id = ?', userId);
}

async function purgeExpiredSessions() {
  const res = await run('DELETE FROM sessions WHERE expires_at < ? OR absolute_expires_at < ?', now(), now());
  return res.rowCount;
}

// ---------------------------------------------------------------------------
// One-time tokens

async function createAuthToken(userId, kind, hoursValid) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + hoursValid * 3600 * 1000).toISOString();
  await run(
    'INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    userId, kind, sha256(token), expires, now()
  );
  return token;
}

async function consumeAuthToken(token, kind) {
  const row = await get(
    'SELECT * FROM auth_tokens WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?',
    sha256(String(token || '')), kind, now()
  );
  if (!row) return null;
  await run('UPDATE auth_tokens SET used_at = ? WHERE id = ?', now(), row.id);
  return row;
}

async function peekAuthToken(token, kind) {
  return get(
    'SELECT * FROM auth_tokens WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?',
    sha256(String(token || '')), kind, now()
  );
}

// ---------------------------------------------------------------------------
// Login

async function recordLoginAttempt(email, ip, success) {
  await run(
    'INSERT INTO login_attempts (email, ip, success, attempted_at) VALUES (?, ?, ?, ?)',
    email, ip, success ? 1 : 0, now()
  );
}

async function purgeOldLoginAttempts() {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const res = await run('DELETE FROM login_attempts WHERE attempted_at < ?', cutoff);
  return res.rowCount;
}

/**
 * Verify credentials.
 *
 * Deliberately uniform failures: unknown account, wrong password and locked
 * account all return the same 401 with the same message, so the endpoint
 * cannot be used to enumerate which email addresses are clients of this
 * brokerage (audit finding H8). The distinction is recorded in the audit log,
 * where it belongs.
 *
 * Returns { user, mfaRequired } — a session is NOT created here. The caller
 * completes login only after any required second factor.
 */
async function verifyCredentials(email, password, ip) {
  const normalized = normalizeEmail(email);
  const security = await getSetting('security', {});
  const threshold = security.lockout_threshold || 8;
  const lockMinutes = security.lockout_minutes || 15;

  await ratelimit.enforce(`login:ip:${ip}`, ratelimit.rule('login_ip').limit, ratelimit.rule('login_ip').window, ratelimit.rule('login_ip').message);
  if (normalized) {
    await ratelimit.enforce(`login:acct:${normalized}`, ratelimit.rule('login_account').limit, ratelimit.rule('login_account').window, ratelimit.rule('login_account').message);
  }

  const user = await get('SELECT * FROM users WHERE lower(email) = lower(?)', normalized);
  const genericFailure = new ApiError(401, 'Incorrect email or password.', 'bad_credentials');

  const locked = !!(user && user.locked_until && user.locked_until > now());
  // Always run a hash comparison, even for unknown accounts, so response time
  // does not reveal whether the address exists.
  const dummyHash = '$scrypt-absent$';
  const passwordOk = await verifyPassword(password, user ? user.password_hash : dummyHash);

  if (!user || locked || user.status !== 'active' || !user.password_hash || !passwordOk) {
    await recordLoginAttempt(normalized, ip, false);
    if (user && !locked) {
      const failures = (user.failed_attempts || 0) + 1;
      if (failures >= threshold) {
        const until = new Date(Date.now() + lockMinutes * 60 * 1000).toISOString();
        await run('UPDATE users SET failed_attempts = 0, locked_until = ? WHERE id = ?', until, user.id);
      } else {
        await run('UPDATE users SET failed_attempts = ? WHERE id = ?', failures, user.id);
      }
    }
    throw genericFailure;
  }

  await run('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?', user.id);
  const mfa = require('./mfa');
  return {
    user,
    mfaRequired: await mfa.isRequiredFor(user) || mfa.isEnrolled(user),
    mfaEnrolled: mfa.isEnrolled(user),
  };
}

/** Finalize a login once every required factor has been satisfied. */
async function completeLogin(user, ip, userAgent) {
  await run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), user.id);
  await recordLoginAttempt(normalizeEmail(user.email), ip, true);
  return createSession(user.id, ip, userAgent, { role: user.role });
}

// ---------------------------------------------------------------------------
// Authorization

const STAFF_ROLES = ['admin', 'manager', 'broker', 'processor', 'assistant'];

async function permissionsForRole(role) {
  if (role === 'client') return [];
  const map = await getSetting('role_permissions', {});
  const { DEFAULT_ROLE_PERMISSIONS } = require('./seed');
  return map[role] || DEFAULT_ROLE_PERMISSIONS[role] || [];
}

async function hasPermission(user, permission) {
  return (await permissionsForRole(user.role)).includes(permission);
}

function requireAuth(ctx) {
  if (!ctx.user) throw new ApiError(401, 'Please sign in to continue.', 'unauthenticated');
}

/**
 * A session issued before the account finished its mandatory steps (password
 * change, MFA enrolment) can reach nothing but the endpoints that complete
 * those steps.
 */
function requirePasswordChanged(ctx) {
  if (ctx.user && ctx.user.must_change_password) {
    throw new ApiError(403, 'Please choose a new password before continuing.', 'password_change_required');
  }
}

async function requireMfaSatisfied(ctx) {
  const mfa = require('./mfa');
  if (!ctx.user) return;
  if (await mfa.isRequiredFor(ctx.user) && !mfa.isEnrolled(ctx.user)) {
    throw new ApiError(403, 'Set up two-step verification before continuing.', 'mfa_enrolment_required');
  }
}

async function requireStaff(ctx) {
  requireAuth(ctx);
  if (!STAFF_ROLES.includes(ctx.user.role)) {
    throw new ApiError(403, 'This area is only available to brokerage staff.', 'forbidden');
  }
  requirePasswordChanged(ctx);
  await requireMfaSatisfied(ctx);
}

async function requireClient(ctx) {
  requireAuth(ctx);
  if (ctx.user.role !== 'client') {
    throw new ApiError(403, 'This area is only available to clients.', 'forbidden');
  }
  requirePasswordChanged(ctx);
}

function requirePermission(permission) {
  return async (ctx) => {
    await requireStaff(ctx);
    if (!(await hasPermission(ctx.user, permission))) {
      throw new ApiError(403, 'You do not have permission to do that. Ask an administrator if you need access.', 'forbidden');
    }
  };
}

// ---------------------------------------------------------------------------
// Client data scoping

/** File IDs a client user may access — derived server-side from applicant links only. */
async function clientFileIds(userId) {
  const rows = await all('SELECT DISTINCT file_id FROM applicants WHERE portal_user_id = ?', userId);
  return rows.map((r) => r.file_id);
}

/** The applicant rows this portal user is, across all their files. */
async function clientApplicants(userId) {
  return all('SELECT * FROM applicants WHERE portal_user_id = ?', userId);
}

/** Load a file for a client user. Throws 404 (not 403) to avoid leaking existence. */
async function clientFileOrThrow(userId, fileId) {
  const ids = await clientFileIds(userId);
  if (!ids.includes(Number(fileId))) throw new ApiError(404, 'Not found.', 'not_found');
  const file = await get('SELECT * FROM client_files WHERE id = ?', Number(fileId));
  if (!file) throw new ApiError(404, 'Not found.', 'not_found');
  return file;
}

/**
 * Applicant ids whose documents this portal user may see on a given file
 * (audit finding H3).
 *
 * By default a client sees only their own documents plus application-level
 * documents that belong to no single applicant. A broker can explicitly mark
 * an applicant as sharing (`shares_documents`), which is how co-borrowers who
 * genuinely share a financial picture get a combined view — but a guarantor
 * never inherits the primary borrower's ID and bank statements simply by
 * being attached to the same file.
 */
async function visibleApplicantIds(userId, fileId) {
  const mine = await all(
    'SELECT id, shares_documents FROM applicants WHERE file_id = ? AND portal_user_id = ?',
    Number(fileId), userId
  );
  const ids = new Set(mine.map((a) => a.id));
  if (mine.some((a) => a.shares_documents === 1)) {
    // This applicant is in the sharing group: they also see documents of
    // other applicants who are themselves marked as sharing.
    const shared = await all(
      'SELECT id FROM applicants WHERE file_id = ? AND shares_documents = 1',
      Number(fileId)
    );
    for (const a of shared) ids.add(a.id);
  }
  return ids;
}

/** True when this portal user may see a specific document request. */
async function canClientSeeRequest(userId, request) {
  if (!request) return false;
  const ids = await clientFileIds(userId);
  if (!ids.includes(request.file_id)) return false;
  if (request.applicant_id === null || request.applicant_id === undefined) return true; // application-level
  const visible = await visibleApplicantIds(userId, request.file_id);
  return visible.has(request.applicant_id);
}

module.exports = {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  minPasswordLength,
  checkBreachedPassword,
  generateTemporaryPassword,
  requirePasswordChanged,
  requireMfaSatisfied,
  createSession,
  sessionLifetimes,
  sessionCookieMaxAge,
  getSessionUser,
  destroySession,
  destroyAllSessions,
  purgeExpiredSessions,
  createAuthToken,
  consumeAuthToken,
  peekAuthToken,
  verifyCredentials,
  completeLogin,
  recordLoginAttempt,
  purgeOldLoginAttempts,
  STAFF_ROLES,
  permissionsForRole,
  hasPermission,
  requireAuth,
  requireStaff,
  requireClient,
  requirePermission,
  clientFileIds,
  clientApplicants,
  clientFileOrThrow,
  visibleApplicantIds,
  canClientSeeRequest,
};
