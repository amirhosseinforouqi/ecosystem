'use strict';

/**
 * Restore a backup over the current database. DESTRUCTIVE.
 *
 *   npm run restore -- ./backups/backup-2026-08-20T… --confirm
 *
 * Refuses to run without --confirm, and refuses to run against a production
 * database unless --i-understand-this-deletes-production is also given.
 */

const path = require('node:path');
const backup = require('../server/backup');
const db = require('../server/db');

async function main() {
  const dir = process.argv[2];
  if (!dir || dir.startsWith('--')) {
    console.error('Usage: npm run restore -- <backup-directory> --confirm');
    process.exit(1);
  }
  if (!process.argv.includes('--confirm')) {
    console.error('Refusing to restore without --confirm. This deletes all current data.');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production' && !process.argv.includes('--i-understand-this-deletes-production')) {
    console.error(
      'NODE_ENV=production. Add --i-understand-this-deletes-production if you really mean to\n' +
      'overwrite the live database. Consider restoring into a fresh database first.'
    );
    process.exit(1);
  }

  const resolved = path.resolve(dir);
  const check = await backup.verifyBackup(resolved);
  if (!check.ok) {
    console.error('Refusing to restore: the archive did not verify.');
    console.error(JSON.stringify(check.mismatches, null, 2));
    process.exit(1);
  }
  console.log(`Archive verified (${check.rows} rows, ${check.documents_present} documents). Restoring…`);

  await db.migrate();
  const result = await backup.restoreBackup(resolved, { confirm: true });
  console.log(`Restored ${result.rows} rows across ${result.tables} tables and ${result.documents} documents.`);
  console.log('Every session was invalidated by the restore — all users must sign in again.');
  await db.close();
}

main().catch(async (err) => {
  console.error('Restore failed:', err.message);
  await db.close().catch(() => {});
  process.exit(1);
});
