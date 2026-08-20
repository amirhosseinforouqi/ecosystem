'use strict';

/**
 * Build-time sanity check.
 *
 * Runs on every deploy before the function is published: it parses every
 * server module (so a syntax error fails the build rather than the first
 * request) and reports which production settings are missing. It never
 * connects to the database — build environments do not have that access.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function jsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

let failed = 0;
for (const file of [...jsFiles(path.join(ROOT, 'server')), ...jsFiles(path.join(ROOT, 'api'))]) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed += 1;
    console.error(`[build] syntax error in ${path.relative(ROOT, file)}`);
    console.error(String(err.stderr || err.message));
  }
}
if (failed) process.exit(1);

const REQUIRED = [
  'DATABASE_URL',
  'STORAGE_BACKEND',
  'DOCUMENT_ENCRYPTION_KEYS',
  'DOCUMENT_ENCRYPTION_ACTIVE_KEY',
  'APP_URL',
  'FORCE_SECURE_COOKIES',
  'CRON_SECRET',
];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.warn(
    `[build] warning: these environment variables are not set in this environment: ${missing.join(', ')}.\n` +
    '        The application refuses to start in production without them — set them in your ' +
    'hosting provider before promoting this deployment.'
  );
}

console.log('[build] ok');
