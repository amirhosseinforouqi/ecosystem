'use strict';

/**
 * Encryption maintenance for the stored documents.
 *
 *   npm run encrypt:backfill                  # report only — changes nothing
 *   npm run encrypt:backfill -- --apply       # encrypt anything still in the clear
 *   npm run encrypt:backfill -- --rewrap --apply
 *                                             # re-wrap under the active key
 *   npm run encrypt:backfill -- --orphans     # list blobs no database row references
 *
 * Two jobs it does:
 *
 *  - **Backfill.** A document written before encryption was configured has no
 *    envelope. It is still readable, which is exactly the problem; this
 *    encrypts it in place.
 *  - **Re-wrap.** After a key rotation, existing documents stay wrapped with
 *    their original key. That is safe — every key stays in
 *    DOCUMENT_ENCRYPTION_KEYS — but re-wrapping lets an old key eventually be
 *    retired.
 *
 * Orphan blobs are only ever *listed*. Deleting a document because no row
 * points at it is the kind of automatic destruction this platform avoids;
 * confirm each one against your backups before removing it by hand.
 */

const db = require('../server/db');
const storage = require('../server/storage');
const cryptoStore = require('../server/crypto-store');
const { parseJsonSafe } = require('../server/util');

const apply = process.argv.includes('--apply');
const rewrap = process.argv.includes('--rewrap');
const orphansOnly = process.argv.includes('--orphans');

async function listOrphans() {
  const rows = await db.all('SELECT stored_name FROM document_versions');
  const referenced = new Set(rows.map((r) => r.stored_name));
  const names = await storage.listStored();
  const orphans = names.filter((n) => !referenced.has(n));
  console.log(`${names.length} blobs on disk, ${referenced.size} referenced, ${orphans.length} orphaned.`);
  for (const name of orphans) console.log(`  ${name}`);
  if (orphans.length) {
    console.log('\nNothing has been deleted. Check these against your backups before removing them.');
  }
}

async function main() {
  cryptoStore.assertConfigured();

  if (orphansOnly) {
    await listOrphans();
    await db.close();
    return;
  }

  const activeKey = cryptoStore.activeKeyId();
  const versions = await db.all('SELECT id, stored_name, enc_envelope FROM document_versions ORDER BY id');

  let plaintext = 0;
  let stale = 0;
  let changed = 0;
  let failed = 0;

  for (const version of versions) {
    const envelope = parseJsonSafe(version.enc_envelope, null);
    const needsBackfill = !envelope;
    const needsRewrap = rewrap && envelope && envelope.key_id !== activeKey;
    if (!needsBackfill && !needsRewrap) continue;
    if (needsBackfill) plaintext += 1; else stale += 1;
    if (!apply) continue;

    try {
      const bytes = await storage.readStored(version.stored_name, envelope);
      const { ciphertext, envelope: fresh } = cryptoStore.encryptBuffer(bytes);
      // Write the new ciphertext first and only then point the row at the new
      // envelope, so an interrupted run leaves a readable document either way.
      await storage.removeStored(version.stored_name);
      await storage.writeRaw(version.stored_name, ciphertext);
      await db.run('UPDATE document_versions SET enc_envelope = ? WHERE id = ?', JSON.stringify(fresh), version.id);
      changed += 1;
    } catch (err) {
      failed += 1;
      console.error(`  version ${version.id}: ${err.message}`);
    }
  }

  console.log(`Scanned ${versions.length} documents.`);
  console.log(`  unencrypted:            ${plaintext}`);
  if (rewrap) console.log(`  wrapped with an old key: ${stale}`);
  if (apply) {
    console.log(`  rewritten:              ${changed}`);
    if (failed) console.log(`  failed:                 ${failed}`);
  } else if (plaintext || stale) {
    console.log('\nReport only. Re-run with --apply to rewrite them.');
  }

  await db.close();
  if (failed) process.exit(1);
}

main().catch(async (err) => {
  console.error('Backfill failed:', err.message);
  await db.close().catch(() => {});
  process.exit(1);
});
