'use strict';

/**
 * One command that says exactly why the application is not running.
 *
 * Container setup output goes to a creation log nobody reads, so a failure
 * during setup shows up much later as a bare 502 on a forwarded port with no
 * explanation anywhere. This checks every prerequisite in order and prints a
 * verdict plus the next command to run.
 *
 *   npm run doctor
 */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');
const results = [];
let firstProblem = null;

function record(ok, label, detail, fix) {
  results.push({ ok, label, detail });
  if (!ok && !firstProblem) firstProblem = { label, detail, fix };
}

function mask(value) {
  if (!value) return value;
  return value.length <= 8 ? '***' : `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: 1500 });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

async function main() {
  const port = Number(process.env.PORT) || 3000;

  // --- 1. Secrets file --------------------------------------------------
  const envFile = path.join(ROOT, '.devcontainer', '.env.local');
  const hasEnvFile = fs.existsSync(envFile);
  if (fs.existsSync(path.join(ROOT, '.devcontainer'))) {
    record(
      hasEnvFile,
      '.devcontainer/.env.local',
      hasEnvFile ? 'present' : 'MISSING — container setup never finished',
      'bash .devcontainer/setup.sh'
    );
  }

  // --- 2. Environment ---------------------------------------------------
  const required = ['DATABASE_URL', 'DOCUMENT_ENCRYPTION_KEYS', 'DOCUMENT_ENCRYPTION_ACTIVE_KEY'];
  for (const key of required) {
    const value = process.env[key];
    record(
      !!value,
      key,
      value ? mask(value.replace(/:[^:@/]*@/, ':****@')) : 'not set',
      hasEnvFile
        ? 'source .devcontainer/.env.local   # then re-run npm run doctor'
        : 'bash .devcontainer/setup.sh'
    );
  }

  // --- 3. Dependencies --------------------------------------------------
  const hasPg = fs.existsSync(path.join(ROOT, 'node_modules', 'pg'));
  record(hasPg, 'node_modules/pg', hasPg ? 'installed' : 'missing', 'npm ci');

  // --- 4. Database ------------------------------------------------------
  let db = null;
  if (process.env.DATABASE_URL && hasPg) {
    try {
      db = require('../server/db');
      const health = await db.healthCheck();
      record(true, 'database connection', `reachable in ${health.latency_ms} ms`);

      const table = await db.get(
        "SELECT to_regclass('public.client_files') AS t"
      );
      const migrated = !!(table && table.t);
      record(migrated, 'schema applied', migrated ? 'tables present' : 'NOT applied', 'npm run migrate');

      if (migrated) {
        const admin = await db.get("SELECT email FROM users WHERE role <> 'client' ORDER BY id LIMIT 1");
        record(!!admin, 'administrator account', admin ? admin.email : 'none', 'npm run migrate');
        const clients = await db.get('SELECT COUNT(*)::int AS n FROM client_files');
        record(true, 'demo clients', `${clients.n} client file(s)`);
      }
    } catch (err) {
      record(false, 'database connection', err.message.split('\n')[0], 'Check the db container: docker ps');
    }
  }

  // --- 5. Document storage ----------------------------------------------
  try {
    const storage = require('../server/storage');
    storage.assertBackendUsable();
    record(true, 'document storage', `backend "${storage.backend()}"`);
  } catch (err) {
    record(false, 'document storage', err.message.split('\n')[0], 'See docs/DEPLOYMENT.md');
  }

  // --- 6. Is it actually serving? ---------------------------------------
  const listening = await portInUse(port);
  record(listening, `port ${port}`, listening ? 'something is listening' : 'NOTHING LISTENING', 'bash .devcontainer/start.sh');

  if (listening) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ready`);
      const body = await res.json().catch(() => ({}));
      record(res.ok, 'GET /ready', res.ok ? 'ok' : `HTTP ${res.status} ${JSON.stringify(body)}`);
    } catch (err) {
      record(false, 'GET /ready', err.message, 'bash .devcontainer/start.sh');
    }
  }

  // --- Report -----------------------------------------------------------
  const width = Math.max(...results.map((r) => r.label.length));
  console.log('');
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.label.padEnd(width)}  ${r.detail}`);
  }
  console.log('');

  if (!firstProblem) {
    console.log('Everything checks out. The application is running on port ' + port + '.');
    if (process.env.CODESPACE_NAME) {
      console.log(`URL: https://${process.env.CODESPACE_NAME}-${port}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev'}`);
      console.log('If that URL shows 401, set the port to Public in the PORTS tab.');
    }
  } else {
    console.log(`First problem: ${firstProblem.label} — ${firstProblem.detail}`);
    if (firstProblem.fix) console.log(`Try:           ${firstProblem.fix}`);
  }

  const log = '/tmp/mortgage-platform.log';
  if (!listening && fs.existsSync(log)) {
    const tail = fs.readFileSync(log, 'utf8').split('\n').slice(-25).join('\n').trim();
    if (tail) {
      console.log('\nLast lines of the server log:\n' + '-'.repeat(58));
      console.log(tail);
      console.log('-'.repeat(58));
    }
  }
  console.log('');

  if (db) await db.close().catch(() => {});
  process.exit(firstProblem ? 1 : 0);
}

main().catch(async (err) => {
  console.error('doctor itself failed:', err.message);
  try { await require('../server/db').close(); } catch { /* not connected */ }
  process.exit(1);
});
