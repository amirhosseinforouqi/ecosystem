'use strict';

/**
 * Resets local data to a clean "broker only" state: brokerage settings,
 * stages, application types, document rules and email templates are all
 * seeded as usual, and a single admin account is created — but there are
 * ZERO clients. Useful for a live, step-by-step walkthrough of the
 * "create a client" flow from an empty dashboard.
 *
 * This DELETES the existing local database and any uploaded files in
 * DATA_DIR (default ./data) — including any clients from `npm run
 * seed:demo`. Nothing outside DATA_DIR is touched. Run `npm run seed:demo`
 * afterwards any time to bring the full sample dataset back.
 *
 * Run:  npm run reset:broker-only
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

process.env.ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1234';

console.log(`Resetting ${DATA_DIR} — this removes any existing clients, documents and messages.`);
fs.rmSync(DATA_DIR, { recursive: true, force: true });

// Loading the server module seeds settings, stages, application types,
// document rules, email templates and the admin account as a side effect.
// It does not start listening or create any clients — that only happens
// when the module is run directly (`npm start`), not required like this.
require('../server/index.js');

console.log('----------------------------------------------------------');
console.log('Broker-only demo ready — zero clients, ready for a live walkthrough.');
console.log(`  Broker portal (/broker): ${process.env.ADMIN_EMAIL} / ${process.env.ADMIN_PASSWORD}`);
console.log('Run "npm start" now, then sign in and try "+ New client".');
console.log('----------------------------------------------------------');
