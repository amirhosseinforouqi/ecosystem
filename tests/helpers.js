'use strict';

/**
 * Shared test harness.
 *
 * Every suite gets its own PostgreSQL database and its own DATA_DIR, so tests
 * can wipe and restore data without interfering with each other or with a
 * developer's local database. Tests talk to the real HTTP server over the
 * network — never to internal functions — so what is verified is what a
 * client or an attacker would actually reach.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { Client } = require('pg');

const ADMIN_EMAIL = 'admin@test.local';
const ADMIN_PASSWORD = 'Quartz-Meadow-Bridge-31';

/** Split a connection string into {adminUrl, name} so we can CREATE DATABASE. */
function databaseUrls(dbName) {
  const source = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!source) {
    throw new Error(
      'Set TEST_DATABASE_URL (or DATABASE_URL) to a PostgreSQL server the tests may create ' +
      'databases on, e.g. postgres://postgres@127.0.0.1:5432/postgres'
    );
  }
  const url = new URL(source);
  const target = new URL(source);
  target.pathname = `/${dbName}`;
  url.pathname = '/postgres';
  return { adminUrl: url.toString(), testUrl: target.toString() };
}

/**
 * Prepare the environment and boot the server.
 * Must be called before anything requires ../server/*.
 */
async function startTestServer(suiteName, envOverrides = {}) {
  const dbName = `mortgage_test_${suiteName}_${process.pid}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const { adminUrl, testUrl } = databaseUrls(dbName);

  const admin = new Client({ connectionString: adminUrl, ssl: sslForTests() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mortgage-test-'));

  process.env.DATABASE_URL = testUrl;
  process.env.DATA_DIR = dataDir;
  process.env.NODE_ENV = 'test';
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.EMAIL_TRANSPORT = 'log';
  process.env.MALWARE_SCAN_MODE = 'disabled';
  process.env.DOCUMENT_ENCRYPTION_KEYS = `v1:${crypto.randomBytes(32).toString('base64')}`;
  process.env.DOCUMENT_ENCRYPTION_ACTIVE_KEY = 'v1';
  process.env.DISABLE_SCHEDULER = '1';
  // Suites run in parallel; keep each one's pool small so the whole run stays
  // well inside a default PostgreSQL connection limit.
  process.env.PG_POOL_MAX = process.env.PG_POOL_MAX || '4';
  delete process.env.AI_DOCUMENT_REVIEW_ENABLED;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SENTRY_DSN;
  delete process.env.TRUST_PROXY;

  // Suite-specific overrides (integration endpoints, feature flags) must be
  // in place before any server module is loaded.
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === null || value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }

  const app = require('../server/app');
  await app.ready();

  const server = http.createServer((req, res) => { app.handle(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    server,
    dataDir,
    dbName,
    testUrl,
    adminUrl,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await require('../server/db').close();
      await fsp.rm(dataDir, { recursive: true, force: true });
      const cleanup = new Client({ connectionString: adminUrl, ssl: sslForTests() });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

function sslForTests() {
  const mode = (process.env.PGSSLMODE || '').toLowerCase();
  if (mode === 'disable' || !mode) return false;
  if (mode === 'no-verify') return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

/** A cookie-jar-aware HTTP client, one per simulated person. */
function makeClient(base) {
  let cookies = new Map();

  function cookieHeader() {
    return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  return {
    get cookies() { return cookies; },
    clearCookies() { cookies = new Map(); },

    async call(method, url, { body, raw, filename, headers = {}, omitCsrf = false } = {}) {
      const h = { ...headers };
      if (!omitCsrf) h['X-Requested-With'] = 'fetch';
      if (cookies.size) h.Cookie = cookieHeader();
      let payload;
      if (raw !== undefined) {
        h['Content-Type'] = h['Content-Type'] || 'application/octet-stream';
        if (filename !== undefined) h['X-Filename'] = encodeURIComponent(filename);
        payload = raw;
      } else if (body !== undefined) {
        h['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' });
      for (const line of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
        const [pair] = line.split(';');
        const i = pair.indexOf('=');
        const name = pair.slice(0, i).trim();
        const value = pair.slice(i + 1).trim();
        if (value === '' || /Max-Age=0/i.test(line)) cookies.delete(name);
        else cookies.set(name, value);
      }
      const type = res.headers.get('content-type') || '';
      let data = null;
      let bytes = null;
      if (type.includes('application/json')) {
        data = await res.json().catch(() => null);
      } else {
        bytes = Buffer.from(await res.arrayBuffer());
      }
      return { status: res.status, data, bytes, headers: res.headers };
    },

    get(url, opts) { return this.call('GET', url, opts); },
    post(url, body, opts) { return this.call('POST', url, { body, ...opts }); },
    patch(url, body, opts) { return this.call('PATCH', url, { body, ...opts }); },
    put(url, body, opts) { return this.call('PUT', url, { body, ...opts }); },
    del(url, body, opts) { return this.call('DELETE', url, { body, ...opts }); },
    upload(url, buffer, filename) { return this.call('POST', url, { raw: buffer, filename }); },
  };
}

/**
 * Sign in the bootstrap administrator and take them all the way through the
 * mandatory steps (password change, MFA enrolment), leaving a usable session.
 */
async function signInAdmin(base, { password = ADMIN_PASSWORD, mfaSecret = null } = {}) {
  const mfa = require('../server/mfa');
  const db = require('../server/db');
  const client = makeClient(base);
  const newPassword = 'Amber-Ridge-Compass-88';

  let res = await client.post('/api/auth/login', { email: ADMIN_EMAIL, password });
  if (res.status !== 200) throw new Error(`admin login failed: ${JSON.stringify(res.data)}`);

  // Already enrolled in MFA: answer the challenge. Clearing the last-used
  // step first stands in for the passage of time between sign-ins.
  if (res.data.mfa_required) {
    const secret = mfaSecret || (await db.get('SELECT mfa_secret FROM users WHERE lower(email) = ?', ADMIN_EMAIL)).mfa_secret;
    await newTotpWindow((await db.get('SELECT id FROM users WHERE lower(email) = ?', ADMIN_EMAIL)).id);
    res = await client.post('/api/auth/mfa/verify', { code: totpNow(secret) });
    if (res.status !== 200) throw new Error(`admin MFA challenge failed: ${JSON.stringify(res.data)}`);
    client.mfaSecret = secret;
  }

  if (res.data.must_change_password) {
    res = await client.post('/api/auth/change-password', {
      current_password: password,
      new_password: newPassword,
    });
    if (res.status !== 200) throw new Error(`admin password change failed: ${JSON.stringify(res.data)}`);
    client.password = newPassword;
  } else {
    client.password = password;
  }

  const status = await client.get('/api/auth/mfa/status');
  if (status.data && status.data.required && !status.data.enrolled) {
    const begin = await client.post('/api/auth/mfa/begin');
    const code = mfa.codeForStep(begin.data.secret, mfa.currentStep());
    const confirm = await client.post('/api/auth/mfa/confirm', { code });
    if (confirm.status !== 200) throw new Error(`admin MFA enrolment failed: ${JSON.stringify(confirm.data)}`);
    client.mfaSecret = begin.data.secret;
    client.recoveryCodes = confirm.data.recovery_codes;
  }

  const me = await client.get('/api/auth/me');
  client.id = me.data && me.data.user ? me.data.user.id : null;
  client.email = ADMIN_EMAIL;
  return client;
}

/** Sign in a client portal user who still has a temporary password. */
async function signInFreshClient(base, email, temporaryPassword, newPassword) {
  const client = makeClient(base);
  const login = await client.post('/api/auth/login', { email, password: temporaryPassword });
  if (login.status !== 200) throw new Error(`client login failed: ${JSON.stringify(login.data)}`);
  if (login.data.must_change_password) {
    const changed = await client.post('/api/auth/change-password', {
      current_password: temporaryPassword,
      new_password: newPassword,
    });
    if (changed.status !== 200) throw new Error(`client password change failed: ${JSON.stringify(changed.data)}`);
  }
  client.email = email;
  client.password = newPassword;
  return client;
}

/**
 * Clear the persisted rate-limit counters.
 *
 * Used by suites that sign the same account in many times while testing
 * something other than rate limiting — without this they trip the (real,
 * deliberate) per-account login limit. The rate limiter itself is tested
 * directly in tests/security.test.js.
 */
async function clearRateLimits() {
  await require('../server/db').run('DELETE FROM rate_limits');
}

/**
 * Simulate a sign-in in a later TOTP window.
 *
 * TOTP steps are single-use (replay protection) and a 30-second step is much
 * longer than a test takes, so consecutive sign-in tests would otherwise run
 * out of unused steps inside the ±1 drift window. Clearing the last-used step
 * is exactly what the passage of time does in production; replay protection
 * itself is asserted inside a single test, where nothing resets it.
 */
async function newTotpWindow(userId) {
  await require('../server/db').run('UPDATE users SET mfa_last_used_step = NULL WHERE id = ?', userId);
}

/** The TOTP code for the current step. */
function totpNow(secret) {
  const mfa = require('../server/mfa');
  return mfa.codeForStep(secret, mfa.currentStep());
}

/** A syntactically valid, tiny PDF — passes the magic-byte check. */
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<</Type/Catalog>>\nendobj\ntrailer\n<</Root 1 0 R>>\n%%EOF\n');
/** A 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

module.exports = {
  startTestServer,
  makeClient,
  clearRateLimits,
  newTotpWindow,
  totpNow,
  signInAdmin,
  signInFreshClient,
  PDF,
  PNG,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  fs,
  path,
};
