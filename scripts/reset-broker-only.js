'use strict';

/**
 * Reset to a clean "broker only" state: brokerage settings, stages,
 * application types, document rules and email templates are seeded as usual,
 * and a single administrator account exists — but there are ZERO clients.
 * Useful for a live, step-by-step walkthrough of the "create a client" flow
 * from an empty dashboard.
 *
 * DESTRUCTIVE: this drops every row in the application's own tables and
 * deletes the uploaded documents in DATA_DIR. It refuses to run against a
 * production environment.
 *
 * Run:  npm run reset:broker-only
 */

const fs = require('node:fs');
const path = require('node:path');
const demo = require('./demo-lib');

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
demo.guardEnvironment('reset the database');

if (!process.argv.includes('--confirm')) {
  console.error(
    'Refusing to reset without --confirm.\n' +
    '  npm run reset:broker-only -- --confirm\n' +
    'This deletes every client, document and message in ' + (process.env.DATABASE_URL || '').replace(/:[^:@/]*@/, ':****@')
  );
  process.exit(1);
}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

async function main() {
  const db = require('../server/db');
  await db.migrate();

  // Delete children before parents; settings, stages, rules and templates are
  // left in place so the brokerage's configuration survives the reset.
  const TABLES = [
    'ai_reviews', 'document_versions', 'document_requests', 'checklist_exclusions',
    'consents', 'stage_history', 'activity_log', 'notes', 'tasks', 'messages',
    'notifications', 'email_log', 'applicants', 'client_files',
    'sessions', 'auth_tokens', 'login_attempts', 'rate_limits', 'mfa_recovery_codes',
  ];
  await db.tx(async () => {
    for (const table of TABLES) await db.run(`DELETE FROM ${table}`);
    // Client portal accounts belong to the deleted files; staff accounts stay.
    await db.run("DELETE FROM users WHERE role = 'client'");
    // Everyone must sign in again, and staff must re-enrol their second factor.
    await db.run('UPDATE users SET mfa_secret = NULL, mfa_enrolled_at = NULL, mfa_last_used_step = NULL');
    await db.run("DELETE FROM counters WHERE key LIKE 'file:%'");
  });

  fs.rmSync(path.join(DATA_DIR, 'uploads'), { recursive: true, force: true });

  const { server, base } = await demo.start();
  const admin = await demo.signInAdmin(base);
  const clients = await admin.get('/api/broker/clients?status=all');

  console.log('----------------------------------------------------------');
  console.log(`Broker-only state ready — ${clients.total} clients.`);
  console.log(`  Broker portal (/broker): ${admin.email} / ${admin.password}`);
  console.log('  Plus the two-step code from the authenticator entry above.');
  console.log('Run "npm start", sign in, and try "+ New client".');
  console.log('----------------------------------------------------------');

  server.close();
  await db.close();
}

main().catch(async (err) => {
  console.error('Reset failed:', err.message);
  await require('../server/db').close().catch(() => {});
  process.exit(1);
});
