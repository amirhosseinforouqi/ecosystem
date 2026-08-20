'use strict';

/**
 * Database-backed rate limiting (audit finding C3/H2).
 *
 * Counters live in Postgres rather than process memory so the limits hold
 * across serverless instances and restarts — an in-memory limiter on Vercel
 * would reset on every cold start and be trivially bypassed.
 *
 * The whole operation is a single atomic upsert: the window is reset and the
 * counter incremented in one statement, so concurrent requests cannot race
 * past the limit.
 */

const { get, run } = require('./db');
const { ApiError, now } = require('./util');

/**
 * Consume one unit from a bucket.
 * @returns {{allowed: boolean, count: number, limit: number, retry_after: number}}
 */
async function consume(bucket, limit, windowSeconds) {
  const cutoff = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const row = await get(
    `INSERT INTO rate_limits (bucket, count, window_start)
       VALUES (?, 1, ?)
     ON CONFLICT (bucket) DO UPDATE
       SET count = CASE WHEN rate_limits.window_start < ? THEN 1 ELSE rate_limits.count + 1 END,
           window_start = CASE WHEN rate_limits.window_start < ? THEN ? ELSE rate_limits.window_start END
     RETURNING count, window_start`,
    bucket, now(), cutoff, cutoff, now()
  );
  const count = row.count;
  const windowEnds = Date.parse(row.window_start) + windowSeconds * 1000;
  return {
    allowed: count <= limit,
    count,
    limit,
    retry_after: Math.max(1, Math.ceil((windowEnds - Date.now()) / 1000)),
  };
}

/** Consume and throw a 429 when the limit is exceeded. */
async function enforce(bucket, limit, windowSeconds, message) {
  const result = await consume(bucket, limit, windowSeconds);
  if (!result.allowed) {
    const err = new ApiError(
      429,
      message || 'Too many requests. Please wait a moment and try again.',
      'rate_limited'
    );
    err.retryAfter = result.retry_after;
    throw err;
  }
  return result;
}

/**
 * Limits by route class. Tuned so normal use never notices them and
 * automated abuse hits a wall quickly.
 */
const LIMITS = {
  // Unauthenticated / credential endpoints — strictest.
  login_ip:        { limit: 30,  window: 900,  message: 'Too many sign-in attempts from this network. Please wait and try again.' },
  login_account:   { limit: 10,  window: 900,  message: 'Too many sign-in attempts for this account. Please wait and try again.' },
  forgot_ip:       { limit: 10,  window: 3600, message: 'Too many password reset requests. Please wait and try again.' },
  forgot_account:  { limit: 5,   window: 3600, message: 'Too many password reset requests. Please wait and try again.' },
  reset_ip:        { limit: 20,  window: 3600 },
  mfa_account:     { limit: 10,  window: 900,  message: 'Too many verification attempts. Please wait and try again.' },
  // Authenticated but expensive.
  upload_user:     { limit: 60,  window: 3600, message: 'Upload limit reached for now. Please try again later or contact your broker.' },
  // Everything else.
  api_ip:          { limit: 600, window: 60 },
  api_user:        { limit: 900, window: 60 },
};

function rule(name) {
  return LIMITS[name];
}

/** Remove expired buckets. Called from the scheduled maintenance job. */
async function purgeExpired() {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const res = await run('DELETE FROM rate_limits WHERE window_start < ?', cutoff);
  return res.rowCount;
}

module.exports = { consume, enforce, rule, LIMITS, purgeExpired };
