'use strict';

/**
 * TOTP multi-factor authentication (audit finding C7).
 *
 * RFC 6238 / RFC 4226 implemented on Node's own HMAC — no dependency, and
 * compatible with every standard authenticator (Microsoft Authenticator,
 * Google Authenticator, 1Password, Authy).
 *
 * Two anti-replay controls matter here and are easy to get wrong:
 *  - the accepted step is recorded, so a code cannot be used twice even
 *    inside its validity window (a shoulder-surfed or phished code is
 *    single-use);
 *  - verification attempts are rate limited per account by the caller.
 *
 * Recovery codes are stored only as scrypt hashes and are single-use.
 */

const crypto = require('node:crypto');
const { run, get, all, getSetting } = require('./db');
const { now, ApiError } = require('./util');

const STEP_SECONDS = 30;
const DIGITS = 6;
const DRIFT_STEPS = 1; // accept one step either side for clock skew

// ---------------------------------------------------------------------------
// base32 (RFC 4648) — the encoding authenticator apps expect

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '')) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new ApiError(400, 'That authenticator secret is not valid.', 'bad_secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---------------------------------------------------------------------------
// TOTP

function generateSecret() {
  return base32Encode(crypto.randomBytes(20)); // 160-bit, per RFC 4226
}

function codeForStep(secretBase32, step) {
  const key = base32Decode(secretBase32);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

function currentStep(atMs = Date.now()) {
  return Math.floor(atMs / 1000 / STEP_SECONDS);
}

/**
 * Verify a code against a secret. Returns the matched step, or null.
 * Comparison is constant-time.
 */
function verifyCode(secretBase32, code, atMs = Date.now()) {
  const cleaned = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleaned)) return null;
  const step = currentStep(atMs);
  for (let drift = -DRIFT_STEPS; drift <= DRIFT_STEPS; drift++) {
    const candidate = codeForStep(secretBase32, step + drift);
    const a = Buffer.from(candidate);
    const b = Buffer.from(cleaned);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return step + drift;
  }
  return null;
}

/** otpauth:// URI for authenticator apps (also renderable as a QR code). */
function provisioningUri(secretBase32, accountEmail, issuer) {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Policy

const DEFAULT_REQUIRED_ROLES = ['admin', 'manager', 'broker', 'processor'];

/** Roles for which MFA is mandatory. Configurable, but never empty for admin. */
async function requiredRoles() {
  const cfg = await getSetting('security', {});
  const roles = Array.isArray(cfg.mfa_required_roles) ? cfg.mfa_required_roles : DEFAULT_REQUIRED_ROLES;
  // Administrators can never be exempted — that would defeat the control.
  return roles.includes('admin') ? roles : ['admin', ...roles];
}

async function isRequiredFor(user) {
  if (!user || user.role === 'client') {
    // Clients may enrol voluntarily; it is never forced on them.
    return false;
  }
  return (await requiredRoles()).includes(user.role);
}

function isEnrolled(user) {
  return !!(user && user.mfa_secret && user.mfa_enrolled_at);
}

// ---------------------------------------------------------------------------
// Enrolment and verification against a stored user

/** Begin enrolment: returns a secret to display once. Not yet active. */
async function beginEnrolment(user, issuer) {
  const secret = generateSecret();
  // Held unconfirmed until the user proves they can generate a code.
  await run('UPDATE users SET mfa_secret = ?, mfa_enrolled_at = NULL, updated_at = ? WHERE id = ?', secret, now(), user.id);
  return { secret, uri: provisioningUri(secret, user.email, issuer) };
}

/** Confirm enrolment with a code; returns single-use recovery codes. */
async function confirmEnrolment(user, code) {
  const fresh = await get('SELECT * FROM users WHERE id = ?', user.id);
  if (!fresh || !fresh.mfa_secret) {
    throw new ApiError(400, 'Start authenticator setup again — no pending secret was found.', 'no_pending_mfa');
  }
  const step = verifyCode(fresh.mfa_secret, code);
  if (step === null) {
    throw new ApiError(400, 'That code was not correct. Check your authenticator app and try again.', 'bad_code');
  }
  await run(
    'UPDATE users SET mfa_enrolled_at = ?, mfa_last_used_step = ?, updated_at = ? WHERE id = ?',
    now(), step, now(), user.id
  );
  return generateRecoveryCodes(user.id);
}

/** Replace all recovery codes with a fresh set; returns the plaintext once. */
async function generateRecoveryCodes(userId, count = 10) {
  const { hashPassword } = require('./auth');
  await run('DELETE FROM mfa_recovery_codes WHERE user_id = ?', userId);
  const codes = [];
  for (let i = 0; i < count; i++) {
    const code = `${crypto.randomBytes(4).toString('hex')}-${crypto.randomBytes(4).toString('hex')}`;
    codes.push(code);
    await run(
      'INSERT INTO mfa_recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)',
      userId, await hashPassword(code), now()
    );
  }
  return codes;
}

/**
 * Verify a login second factor: a TOTP code, or a single-use recovery code.
 * Replay of an already-used TOTP step is rejected.
 */
async function verifySecondFactor(user, code) {
  const fresh = await get('SELECT * FROM users WHERE id = ?', user.id);
  if (!fresh || !fresh.mfa_secret) return { ok: false };

  const step = verifyCode(fresh.mfa_secret, code);
  if (step !== null) {
    if (fresh.mfa_last_used_step !== null && Number(fresh.mfa_last_used_step) >= step) {
      return { ok: false, reason: 'replayed' };
    }
    await run('UPDATE users SET mfa_last_used_step = ? WHERE id = ?', step, user.id);
    return { ok: true, method: 'totp' };
  }

  // Fall back to recovery codes.
  const { verifyPassword } = require('./auth');
  const candidate = String(code || '').trim().toLowerCase();
  if (!candidate) return { ok: false };
  const rows = await all('SELECT * FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL', user.id);
  for (const row of rows) {
    if (await verifyPassword(candidate, row.code_hash)) {
      await run('UPDATE mfa_recovery_codes SET used_at = ? WHERE id = ?', now(), row.id);
      return { ok: true, method: 'recovery_code', remaining: rows.length - 1 };
    }
  }
  return { ok: false };
}

/** Turn MFA off for a user (administrator action; always audited by caller). */
async function resetMfa(userId) {
  await run(
    'UPDATE users SET mfa_secret = NULL, mfa_enrolled_at = NULL, mfa_last_used_step = NULL, updated_at = ? WHERE id = ?',
    now(), userId
  );
  await run('DELETE FROM mfa_recovery_codes WHERE user_id = ?', userId);
}

async function remainingRecoveryCodes(userId) {
  const row = await get(
    'SELECT COUNT(*)::int AS n FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL',
    userId
  );
  return row ? row.n : 0;
}

module.exports = {
  generateSecret,
  verifyCode,
  codeForStep,
  currentStep,
  provisioningUri,
  requiredRoles,
  isRequiredFor,
  isEnrolled,
  beginEnrolment,
  confirmEnrolment,
  generateRecoveryCodes,
  verifySecondFactor,
  resetMfa,
  remainingRecoveryCodes,
  base32Encode,
  base32Decode,
};
