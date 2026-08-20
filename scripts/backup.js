'use strict';

/**
 * Write a full backup (database rows + document blobs).
 *
 *   npm run backup                      → ./backups/backup-<timestamp>/
 *   npm run backup -- --out /mnt/safe   → somewhere else
 *   npm run backup -- --verify-only DIR → check an existing archive
 *
 * Restore with `npm run restore -- <dir> --confirm`.
 */

const path = require('node:path');
const fsp = require('node:fs/promises');
const backup = require('../server/backup');
const db = require('../server/db');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const verifyOnly = arg('verify-only', null);
  if (verifyOnly) {
    const result = await backup.verifyBackup(path.resolve(verifyOnly));
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  const out = path.resolve(arg('out', path.join(__dirname, '..', 'backups')));
  await fsp.mkdir(out, { recursive: true, mode: 0o700 });

  const started = Date.now();
  const { dir, manifest } = await backup.createBackup(out, {
    includeTransient: process.argv.includes('--include-sessions'),
  });

  // Always verify what was just written — an unverified backup is a guess.
  const check = await backup.verifyBackup(dir);
  if (!check.ok) {
    console.error('Backup verification FAILED:', JSON.stringify(check.mismatches, null, 2));
    process.exit(1);
  }

  console.log(`Backup written to ${dir}`);
  console.log(`  rows:      ${manifest.rows} across ${manifest.tables.length} tables`);
  console.log(`  documents: ${manifest.documents} (${Math.round(manifest.document_bytes / 1024)} KB)`);
  console.log(`  encrypted: ${manifest.encrypted ? 'yes' : 'NO — set DOCUMENT_ENCRYPTION_KEYS'}`);
  console.log(`  verified:  yes (${Date.now() - started} ms)`);
  if (manifest.missing_documents.length) {
    console.warn(`  WARNING: ${manifest.missing_documents.length} document file(s) referenced by the database were not found on disk.`);
  }

  const pruned = await backup.pruneBackups(out, {
    days: Number(process.env.BACKUP_RETENTION_DAYS) || 30,
    keep: Number(process.env.BACKUP_KEEP_MIN) || 7,
  });
  if (pruned.removed) console.log(`  pruned:    ${pruned.removed} old backup(s)`);

  await db.close();
}

main().catch(async (err) => {
  console.error('Backup failed:', err.message);
  await db.close().catch(() => {});
  process.exit(1);
});
