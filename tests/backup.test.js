'use strict';

/**
 * Backup and restore (audit finding C2).
 *
 * The only backup worth having is one that has been restored, so this is a
 * real drill: take a backup, destroy the database and the document store,
 * restore, and then check that the application still works and that the
 * client's document still decrypts to the original bytes.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const helpers = require('./helpers');

let ctx;
let admin;
let client;
let backupRoot;
let fileId;
let versionId;
let fileNumber;
const CLIENT_PASSWORD = 'Meridian-Cobalt-Anchor-56';

before(async () => {
  ctx = await helpers.startTestServer('backup');
  admin = await helpers.signInAdmin(ctx.base);
  backupRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'mortgage-backups-'));

  const created = await admin.post('/api/broker/clients', {
    client: {
      first_name: 'Nadia', last_name: 'Okafor', email: 'nadia@test.local',
      phone: '905-555-0303', employment_type: 'employee',
    },
    application: { application_type_id: 1, purchase_price: 640000, property_address: '5 Yonge St' },
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  fileId = created.data.file.id;
  fileNumber = created.data.file.file_number;

  const invite = created.data.invites[0];
  client = await helpers.signInFreshClient(ctx.base, invite.username, invite.temporary_password, CLIENT_PASSWORD);

  const docs = await client.get(`/api/client/files/${fileId}/documents`);
  const uploaded = await client.upload(`/api/client/requests/${docs.data.requests[0].id}/upload`, helpers.PDF, 'id.pdf');
  assert.equal(uploaded.status, 200);
  versionId = uploaded.data.request.current_version.id;

  await admin.post(`/api/broker/files/${fileId}/notes`, { body: 'Nadia prefers evening calls.' });
  await admin.post(`/api/broker/files/${fileId}/messages`, { body: 'Thanks — reviewing now.' });
});

after(async () => {
  if (backupRoot) await fsp.rm(backupRoot, { recursive: true, force: true });
  if (ctx) await ctx.stop();
});

describe('taking a backup', () => {
  let dir;

  test('a backup captures every table and every document', async () => {
    const backup = require('../server/backup');
    const result = await backup.createBackup(backupRoot);
    dir = result.dir;

    assert.ok(result.manifest.rows > 0);
    assert.ok(result.manifest.counts.client_files >= 1);
    assert.ok(result.manifest.counts.document_versions >= 1);
    assert.equal(result.manifest.documents, result.manifest.counts.document_versions);
    assert.deepEqual(result.manifest.missing_documents, [], 'no referenced document is missing from disk');
    assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(dir, 'data.jsonl.gz')));
  });

  test('the archive contains no readable client data', async () => {
    const bytes = await fsp.readFile(path.join(dir, 'data.jsonl.gz'));
    assert.ok(!bytes.includes(Buffer.from('nadia@test.local')), 'PII must not be readable in the archive');
    assert.ok(!bytes.includes(Buffer.from(fileNumber)));

    const docDir = path.join(dir, 'documents');
    for (const name of await fsp.readdir(docDir)) {
      const doc = await fsp.readFile(path.join(docDir, name));
      assert.ok(!doc.includes(Buffer.from('%PDF')), 'document blobs stay encrypted in the archive');
    }
  });

  test('sessions are deliberately excluded, so a restore does not resurrect them', async () => {
    const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    for (const transient of ['sessions', 'auth_tokens', 'login_attempts', 'rate_limits']) {
      assert.ok(!manifest.tables.includes(transient), `${transient} should not be backed up by default`);
    }
  });

  test('verification detects a corrupted archive rather than restoring it', async () => {
    const backup = require('../server/backup');
    assert.equal((await backup.verifyBackup(dir)).ok, true);

    const dataFile = path.join(dir, 'data.jsonl.gz');
    const original = await fsp.readFile(dataFile);
    const damaged = Buffer.from(original);
    damaged[Math.floor(damaged.length / 2)] ^= 0xff;
    await fsp.writeFile(dataFile, damaged);

    await assert.rejects(
      () => backup.verifyBackup(dir),
      /corrupt|checksum|authenticate|Unsupported/i,
      'a damaged archive must fail loudly'
    );
    await assert.rejects(
      () => backup.restoreBackup(dir, { confirm: true }),
      /corrupt|checksum|authenticate|Unsupported/i,
      'and must never be restored'
    );

    await fsp.writeFile(dataFile, original);
    assert.equal((await backup.verifyBackup(dir)).ok, true);
  });

  test('a restore without explicit confirmation is refused', async () => {
    const backup = require('../server/backup');
    await assert.rejects(() => backup.restoreBackup(dir, {}), /confirm/i);
  });

  test('an archive naming an unknown table is refused, not executed', async () => {
    const backup = require('../server/backup');
    const manifestPath = path.join(dir, 'manifest.json');
    const original = await fsp.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(original);
    manifest.tables.push('users; DROP TABLE client_files; --');
    await fsp.writeFile(manifestPath, JSON.stringify(manifest));

    await assert.rejects(
      () => backup.restoreBackup(dir, { confirm: true }),
      /does not have/i,
      'a table name is an identifier and cannot be parameterized, so it must be checked'
    );
    await fsp.writeFile(manifestPath, original);
  });
});

describe('restoring after total loss', () => {
  test('wipe the database and the document store, then restore both', async () => {
    const backup = require('../server/backup');
    const db = require('../server/db');
    const storage = require('../server/storage');

    const dirs = (await fsp.readdir(backupRoot)).filter((n) => n.startsWith('backup-'));
    const dir = path.join(backupRoot, dirs[dirs.length - 1]);

    const before = await db.get(
      `SELECT (SELECT COUNT(*)::int FROM client_files) files,
              (SELECT COUNT(*)::int FROM applicants) applicants,
              (SELECT COUNT(*)::int FROM document_requests) requests,
              (SELECT COUNT(*)::int FROM document_versions) versions,
              (SELECT COUNT(*)::int FROM notes) notes,
              (SELECT COUNT(*)::int FROM messages) messages,
              (SELECT COUNT(*)::int FROM audit_log) audit`
    );

    // Destroy everything a disaster would destroy.
    await db.run('DELETE FROM document_versions');
    await db.run('DELETE FROM document_requests');
    await db.run('DELETE FROM messages');
    await db.run('DELETE FROM notes');
    await db.run('DELETE FROM applicants');
    await db.run('DELETE FROM client_files');
    await fsp.rm(storage.UPLOAD_DIR, { recursive: true, force: true });

    const wiped = await db.get('SELECT COUNT(*)::int AS n FROM client_files');
    assert.equal(wiped.n, 0, 'the data really is gone');
    assert.equal((await admin.get(`/api/broker/files/${fileId}`)).status, 404);

    const result = await backup.restoreBackup(dir, { confirm: true });
    assert.ok(result.rows > 0);
    assert.equal(result.documents, before.versions);

    const after = await db.get(
      `SELECT (SELECT COUNT(*)::int FROM client_files) files,
              (SELECT COUNT(*)::int FROM applicants) applicants,
              (SELECT COUNT(*)::int FROM document_requests) requests,
              (SELECT COUNT(*)::int FROM document_versions) versions,
              (SELECT COUNT(*)::int FROM notes) notes,
              (SELECT COUNT(*)::int FROM messages) messages,
              (SELECT COUNT(*)::int FROM audit_log) audit`
    );
    assert.deepEqual(after, before, 'every row count matches the pre-loss state');
  });

  test('the application works against the restored data', async () => {
    // Sessions were not backed up, so everyone signs in again — which is the
    // correct behaviour after a restore.
    await helpers.clearRateLimits();
    const freshAdmin = await helpers.signInAdmin(ctx.base, { password: admin.password, mfaSecret: admin.mfaSecret });

    const file = await freshAdmin.get(`/api/broker/files/${fileId}`);
    assert.equal(file.status, 200);
    assert.equal(file.data.file.file_number, fileNumber);
    assert.equal(file.data.file.client_name, 'Nadia Okafor');
    assert.equal(file.data.applicants.length, 1);

    const notes = await freshAdmin.get(`/api/broker/files/${fileId}/notes`);
    assert.ok(notes.data.notes.some((n) => n.body.includes('evening calls')));

    const messages = await freshAdmin.get(`/api/broker/files/${fileId}/messages`);
    assert.ok(messages.data.messages.some((m) => m.body.includes('reviewing now')));
  });

  test('the restored document still decrypts to the original bytes', async () => {
    await helpers.clearRateLimits();
    const freshAdmin = await helpers.signInAdmin(ctx.base, { password: admin.password, mfaSecret: admin.mfaSecret });
    const res = await freshAdmin.get(`/api/broker/versions/${versionId}/file`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.bytes, helpers.PDF, 'byte-for-byte identical after a full restore');
  });

  test('the audit hash chain still verifies after the restore', async () => {
    await helpers.clearRateLimits();
    const freshAdmin = await helpers.signInAdmin(ctx.base, { password: admin.password, mfaSecret: admin.mfaSecret });
    const chain = await freshAdmin.get('/api/broker/audit/verify');
    assert.equal(chain.data.ok, true, 'restoring must not break tamper evidence');
  });

  test('new records can still be created — identity sequences were repaired', async () => {
    await helpers.clearRateLimits();
    const freshAdmin = await helpers.signInAdmin(ctx.base, { password: admin.password, mfaSecret: admin.mfaSecret });
    const created = await freshAdmin.post('/api/broker/clients', {
      client: { first_name: 'Post', last_name: 'Restore', email: 'post.restore@test.local' },
      application: { application_type_id: 1 },
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    assert.ok(created.data.file.id > fileId, 'the id sequence continues past the restored rows');
    assert.notEqual(created.data.file.file_number, fileNumber, 'and so does the file-number counter');
  });
});

describe('retention', () => {
  test('pruning keeps a minimum number of recent backups', async () => {
    const backup = require('../server/backup');
    await backup.createBackup(backupRoot);
    const before = (await fsp.readdir(backupRoot)).filter((n) => n.startsWith('backup-')).length;
    const pruned = await backup.pruneBackups(backupRoot, { days: 30, keep: 1 });
    const after = (await fsp.readdir(backupRoot)).filter((n) => n.startsWith('backup-')).length;
    assert.equal(pruned.removed, 0, 'recent backups are never pruned by age');
    assert.equal(after, before);
  });
});
