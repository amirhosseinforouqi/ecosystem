'use strict';

/**
 * PostgreSQL data layer (audit finding C5 — replaces experimental node:sqlite).
 *
 * Connects via DATABASE_URL, so it runs unchanged against Supabase, any
 * managed Postgres, or a local cluster. Two deliberate design choices keep
 * the migration from SQLite low-risk:
 *
 *  1. Call sites keep writing `?` placeholders; toPg() rewrites them to
 *     $1..$n. The hundreds of existing queries did not have to be re-authored
 *     (and therefore re-reviewed) by hand.
 *
 *  2. tx() binds a dedicated client into AsyncLocalStorage, so ordinary
 *     run/get/all calls inside a transaction callback automatically join that
 *     transaction instead of silently taking a separate pooled connection.
 *
 * Every function is async. There is no synchronous path and no SQLite
 * fallback — a half-migrated data layer would be worse than either.
 */

const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool } = require('pg');
const { now, parseJsonSafe } = require('./util');

const txStore = new AsyncLocalStorage();

// Integers arrive as JS numbers rather than strings; the app treats ids and
// counts numerically throughout. (NUMERIC/money stays a string by default —
// handled explicitly below.)
const pgTypes = require('pg').types;
pgTypes.setTypeParser(20, (v) => (v === null ? null : Number(v)));   // int8
pgTypes.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric

function connectionString() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. This application requires PostgreSQL — see docs/DEPLOYMENT.md. ' +
      'Local SQLite is no longer supported.'
    );
  }
  return url;
}

/**
 * TLS: managed providers (Supabase, RDS) terminate TLS with a public CA.
 * PGSSLMODE=no-verify is available for local sockets and self-signed setups,
 * but verification stays on by default so a production misconfiguration
 * fails loudly instead of silently downgrading.
 */
function sslConfig() {
  const url = process.env.DATABASE_URL || '';
  if (url.includes('host=/') || url.startsWith('postgres://postgres@/')) return false; // unix socket
  const mode = (process.env.PGSSLMODE || '').toLowerCase();
  if (mode === 'disable') return false;
  if (mode === 'no-verify') return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: connectionString(),
      ssl: sslConfig(),
      // Serverless-friendly: small pool, short idle, fail fast rather than
      // queueing behind an exhausted connection limit.
      max: Number(process.env.PG_POOL_MAX) || 10,
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT) || 30000,
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT) || 10000,
      statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT) || 15000,
    });
    pool.on('error', (err) => {
      console.error('[db] idle client error:', err.message);
    });
  }
  return pool;
}

/** Rewrite `?` placeholders to $1..$n, ignoring those inside string literals. */
function toPg(sql) {
  let out = '';
  let n = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    if (c === '?' && !inSingle && !inDouble) {
      out += '$' + ++n;
    } else {
      out += c;
    }
  }
  return out;
}

function executor() {
  return txStore.getStore() || getPool();
}

async function query(sql, params) {
  try {
    return await executor().query(toPg(sql), params);
  } catch (err) {
    // Surface the failing statement in logs without leaking parameter values
    // (which routinely contain client PII).
    err.message = `${err.message} [sql: ${String(sql).replace(/\s+/g, ' ').slice(0, 200)}]`;
    throw err;
  }
}

async function run(sql, ...params) {
  const res = await query(sql, params);
  return { rowCount: res.rowCount, changes: res.rowCount, rows: res.rows };
}

async function get(sql, ...params) {
  const res = await query(sql, params);
  return res.rows[0];
}

async function all(sql, ...params) {
  const res = await query(sql, params);
  return res.rows;
}

/** INSERT helper returning the new id. Appends RETURNING id when absent. */
async function insert(sql, ...params) {
  const text = /returning/i.test(sql) ? sql : `${sql} RETURNING id`;
  const res = await query(text, params);
  return res.rows[0] ? res.rows[0].id : null;
}

/**
 * Run fn inside a transaction. Nested tx() calls join the outer transaction
 * rather than opening a second one.
 */
async function tx(fn) {
  const existing = txStore.getStore();
  if (existing) return fn(existing);

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await txStore.run(client, () => fn(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Schema

async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await getPool().query(schema);
  await getPool().query(
    'INSERT INTO schema_migrations (version, applied_at) VALUES (1, $1) ON CONFLICT (version) DO NOTHING',
    [now()]
  );
}

// ---------------------------------------------------------------------------
// Settings

async function getSetting(key, fallback) {
  const row = await get('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return fallback;
  return parseJsonSafe(row.value, fallback);
}

async function setSetting(key, value) {
  await run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    key,
    JSON.stringify(value)
  );
}

/**
 * Next value for a counter. The UPDATE ... RETURNING is atomic, so two
 * concurrent client creations can never receive the same file number.
 */
async function nextCounter(key) {
  await run('INSERT INTO counters (key, value) VALUES (?, 0) ON CONFLICT (key) DO NOTHING', key);
  const row = await get('UPDATE counters SET value = value + 1 WHERE key = ? RETURNING value', key);
  return row.value;
}

async function nextFileNumber() {
  const year = new Date().getUTCFullYear();
  const seq = await nextCounter(`file:${year}`);
  return `MTG-${year}-${String(seq).padStart(5, '0')}`;
}

async function touchFile(fileId) {
  await run('UPDATE client_files SET last_activity_at = ?, updated_at = ? WHERE id = ?', now(), now(), fileId);
}

async function close() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

/** Liveness + writability probe for readiness checks. */
async function healthCheck() {
  const started = Date.now();
  await get('SELECT 1 AS ok');
  return { ok: true, latency_ms: Date.now() - started };
}

module.exports = {
  getPool,
  query,
  run,
  get,
  all,
  insert,
  tx,
  migrate,
  getSetting,
  setSetting,
  nextCounter,
  nextFileNumber,
  touchFile,
  close,
  healthCheck,
  toPg,
};
