'use strict';

/**
 * Security tests.
 *
 * Every assertion here is made against the HTTP API, because that is the
 * boundary an attacker reaches. Hiding a control in the UI proves nothing.
 *
 * Covers audit findings C1 (encryption at rest), C3 (rate limiting), C4 (no
 * default credential), C7 (MFA), H3 (applicant-level isolation), H6
 * (preview/download parity) and spec Scenario 10 (client isolation).
 */

const { test, before, beforeEach, after, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const helpers = require('./helpers');

let ctx;      // { base, stop, dataDir }
let admin;    // brokerage administrator
let alice;    // primary applicant, file A
let adam;     // co-borrower on the same file A
let bob;      // primary applicant, file B
let sam;      // assistant: documents.view but NOT documents.download
let fileA;
let fileB;
let aliceRequestId;
let adamRequestId;
let aliceVersionId;

before(async () => {
  ctx = await helpers.startTestServer('security');
  admin = await helpers.signInAdmin(ctx.base);

  const created = await admin.post('/api/broker/clients', {
    client: {
      first_name: 'Alice', last_name: 'Anderson', email: 'alice@test.local',
      phone: '416-555-0101', employment_type: 'employee',
    },
    application: { application_type_id: 1, purchase_price: 700000, mortgage_amount: 560000, fthb: true },
    co_applicants: [{
      first_name: 'Adam', last_name: 'Anderson', email: 'adam@test.local',
      role: 'co_borrower', employment_type: 'employee', invite: true,
    }],
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  fileA = created.data.file.id;

  const createdB = await admin.post('/api/broker/clients', {
    client: {
      first_name: 'Bob', last_name: 'Baker', email: 'bob@test.local',
      phone: '416-555-0202', employment_type: 'employee',
    },
    application: { application_type_id: 1, purchase_price: 500000 },
  });
  fileB = createdB.data.file.id;

  alice = await helpers.signInFreshClient(
    ctx.base, 'alice@test.local',
    created.data.invites.find((i) => i.applicant_id === 1 || i.email === 'alice@test.local').temporary_password,
    'Willow-Harbour-Signal-12'
  );
  adam = await helpers.signInFreshClient(
    ctx.base, 'adam@test.local',
    created.data.invites.find((i) => i.username === 'adam@test.local').temporary_password,
    'Cedar-Compass-Marble-13'
  );
  bob = await helpers.signInFreshClient(
    ctx.base, 'bob@test.local',
    createdB.data.invites[0].temporary_password,
    'Basalt-Lantern-Meadow-14'
  );

  // An assistant: has documents.view, deliberately lacks documents.download.
  const invite = await admin.post('/api/settings/users', {
    email: 'sam@test.local', role: 'assistant', first_name: 'Sam', last_name: 'Assist',
  });
  const token = new URL(invite.data.activation_link).searchParams.get('token');
  sam = helpers.makeClient(ctx.base);
  await sam.post('/api/auth/activate', { token, password: 'Granite-Harbor-Signal-21' });

  // Documents: one belonging to Alice, one belonging to Adam.
  const docs = await admin.get(`/api/broker/files/${fileA}/documents`);
  const applicants = await admin.get(`/api/broker/files/${fileA}`);
  const aliceApplicant = applicants.data.applicants.find((a) => a.first_name === 'Alice');
  const adamApplicant = applicants.data.applicants.find((a) => a.first_name === 'Adam');
  aliceRequestId = docs.data.requests.find((r) => r.applicant_id === aliceApplicant.id).id;
  adamRequestId = docs.data.requests.find((r) => r.applicant_id === adamApplicant.id).id;

  const uploaded = await alice.upload(`/api/client/requests/${aliceRequestId}/upload`, helpers.PDF, 'alice-id.pdf');
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
  aliceVersionId = uploaded.data.request.current_version.id;
});

after(async () => { if (ctx) await ctx.stop(); });

// ---------------------------------------------------------------------------

describe('unauthenticated access', () => {
  test('every broker endpoint refuses an anonymous caller', async () => {
    const anon = helpers.makeClient(ctx.base);
    for (const url of [
      '/api/broker/dashboard',
      '/api/broker/clients',
      `/api/broker/files/${fileA}`,
      `/api/broker/files/${fileA}/documents`,
      `/api/broker/versions/${aliceVersionId}/file`,
      '/api/broker/audit',
      '/api/broker/reports',
      '/api/settings/meta',
      '/api/settings/users',
      '/api/ops/status',
    ]) {
      const res = await anon.get(url);
      assert.ok([401, 403].includes(res.status), `${url} returned ${res.status}`);
    }
  });

  test('client endpoints refuse an anonymous caller', async () => {
    const anon = helpers.makeClient(ctx.base);
    for (const url of ['/api/client/overview', `/api/client/files/${fileA}/documents`, `/api/client/versions/${aliceVersionId}/file`]) {
      const res = await anon.get(url);
      assert.ok([401, 403].includes(res.status), `${url} returned ${res.status}`);
    }
  });

  test('a forged session cookie is rejected', async () => {
    const forged = helpers.makeClient(ctx.base);
    forged.cookies.set('sid', 'a'.repeat(64));
    const res = await forged.get('/api/broker/dashboard');
    assert.equal(res.status, 401);
  });

  test('the cron endpoint is not reachable without the secret', async () => {
    const anon = helpers.makeClient(ctx.base);
    assert.equal((await anon.post('/api/cron/jobs')).status, 404);
    assert.equal((await anon.post('/api/cron/jobs', undefined, { headers: { 'x-cron-secret': 'guess' } })).status, 404);
  });
});

describe('client-to-client isolation (spec scenario 10)', () => {
  test('client B cannot read client A\'s file, documents or messages', async () => {
    for (const url of [
      `/api/client/files/${fileA}/documents`,
      `/api/client/files/${fileA}/messages`,
    ]) {
      const res = await bob.get(url);
      assert.equal(res.status, 404, `${url} returned ${res.status}`);
    }
  });

  test('client B cannot read client A\'s document bytes', async () => {
    const res = await bob.get(`/api/client/versions/${aliceVersionId}/file`);
    assert.equal(res.status, 404);
  });

  test('client B cannot upload into client A\'s document request', async () => {
    const res = await bob.upload(`/api/client/requests/${aliceRequestId}/upload`, helpers.PDF, 'x.pdf');
    assert.equal(res.status, 404);
  });

  test('client B cannot post a message onto client A\'s file', async () => {
    const res = await bob.post(`/api/client/files/${fileA}/messages`, { body: 'hello' });
    assert.equal(res.status, 404);
  });

  test('the overview only ever contains the caller\'s own files', async () => {
    const a = await alice.get('/api/client/overview');
    const b = await bob.get('/api/client/overview');
    assert.deepEqual(a.data.files.map((f) => f.file_id), [fileA]);
    assert.deepEqual(b.data.files.map((f) => f.file_id), [fileB]);
  });

  test('not-found is used rather than forbidden, so file existence does not leak', async () => {
    const real = await bob.get(`/api/client/files/${fileA}/documents`);
    const fake = await bob.get('/api/client/files/999999/documents');
    assert.equal(real.status, fake.status);
    assert.deepEqual(real.data, fake.data);
  });
});

describe('applicant-to-applicant isolation (audit finding H3)', () => {
  test('co-applicants on the same file do not see each other\'s documents', async () => {
    const aliceDocs = await alice.get(`/api/client/files/${fileA}/documents`);
    const adamDocs = await adam.get(`/api/client/files/${fileA}/documents`);
    const aliceIds = aliceDocs.data.requests.map((r) => r.id);
    const adamIds = adamDocs.data.requests.map((r) => r.id);

    assert.ok(aliceIds.includes(aliceRequestId), 'Alice should see her own request');
    assert.ok(!aliceIds.includes(adamRequestId), 'Alice must not see Adam\'s request');
    assert.ok(adamIds.includes(adamRequestId), 'Adam should see his own request');
    assert.ok(!adamIds.includes(aliceRequestId), 'Adam must not see Alice\'s request');
  });

  test('file-level documents are shared by both applicants', async () => {
    const aliceDocs = await alice.get(`/api/client/files/${fileA}/documents`);
    const adamDocs = await adam.get(`/api/client/files/${fileA}/documents`);
    const aliceShared = aliceDocs.data.requests.filter((r) => r.applicant_id === null).map((r) => r.id);
    const adamShared = adamDocs.data.requests.filter((r) => r.applicant_id === null).map((r) => r.id);
    assert.ok(aliceShared.length > 0, 'expected at least one file-level document');
    assert.deepEqual(aliceShared, adamShared);
  });

  test('a co-applicant cannot fetch the other applicant\'s document bytes', async () => {
    const res = await adam.get(`/api/client/versions/${aliceVersionId}/file`);
    assert.equal(res.status, 404);
  });

  test('a co-applicant cannot upload into the other applicant\'s request', async () => {
    const res = await adam.upload(`/api/client/requests/${aliceRequestId}/upload`, helpers.PDF, 'x.pdf');
    assert.equal(res.status, 404);
  });

  test('sharing is opt-in per applicant, and set by the broker', async () => {
    const applicants = await admin.get(`/api/broker/files/${fileA}`);
    const aliceApplicant = applicants.data.applicants.find((a) => a.first_name === 'Alice');
    const adamApplicant = applicants.data.applicants.find((a) => a.first_name === 'Adam');
    assert.equal(aliceApplicant.shares_documents, false);

    await admin.patch(`/api/broker/applicants/${aliceApplicant.id}`, { shares_documents: true });
    await admin.patch(`/api/broker/applicants/${adamApplicant.id}`, { shares_documents: true });

    const shared = await adam.get(`/api/client/files/${fileA}/documents`);
    assert.ok(
      shared.data.requests.map((r) => r.id).includes(aliceRequestId),
      'once both applicants share, each sees the other\'s documents'
    );
    const bytes = await adam.get(`/api/client/versions/${aliceVersionId}/file`);
    assert.equal(bytes.status, 200);

    // Put it back so later tests see the private default.
    await admin.patch(`/api/broker/applicants/${aliceApplicant.id}`, { shares_documents: false });
    await admin.patch(`/api/broker/applicants/${adamApplicant.id}`, { shares_documents: false });
    assert.equal((await adam.get(`/api/client/versions/${aliceVersionId}/file`)).status, 404);
  });
});

describe('role permissions (audit finding H6)', () => {
  test('an assistant may list documents but is told they cannot download', async () => {
    const res = await sam.get(`/api/broker/files/${fileA}/documents`);
    assert.equal(res.status, 200);
    assert.equal(res.data.can_download, false);
    for (const request of res.data.requests) {
      if (request.current_version) assert.equal(request.current_version.can_download, false);
    }
  });

  test('the preview endpoint does NOT bypass the download permission', async () => {
    const preview = await sam.get(`/api/broker/versions/${aliceVersionId}/file`);
    const download = await sam.get(`/api/broker/versions/${aliceVersionId}/file?disposition=attachment`);
    assert.equal(preview.status, 403, 'inline preview must be refused without documents.download');
    assert.equal(download.status, 403);
  });

  test('a role that has the permission does get the bytes', async () => {
    const res = await admin.get(`/api/broker/versions/${aliceVersionId}/file`);
    assert.equal(res.status, 200);
    assert.ok(res.bytes.subarray(0, 4).toString() === '%PDF', 'should be the original document');
  });

  test('served documents carry hardening headers', async () => {
    const res = await admin.get(`/api/broker/versions/${aliceVersionId}/file`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /sandbox/, 'the document runs with no privileges of its own');
    assert.match(csp, /script-src 'none'/);
    assert.match(csp, /frame-ancestors 'self'/, 'framable by this app, by nobody else');
    // The application-wide DENY would break our own preview modal, so this
    // response narrows it rather than inheriting it.
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  });

  test('the same headers protect the client portal\'s copy', async () => {
    const res = await alice.get(`/api/client/versions/${aliceVersionId}/file`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  });

  test('an assistant cannot reach settings, audit or user management', async () => {
    assert.equal((await sam.get('/api/broker/audit')).status, 403);
    assert.equal((await sam.get('/api/settings/users')).status, 403);
    assert.equal((await sam.put('/api/settings/config/security', { value: {} })).status, 403);
    assert.equal((await sam.post('/api/settings/users', { email: 'x@y.z', role: 'admin' })).status, 403);
  });

  test('staff cannot use client endpoints and clients cannot use staff endpoints', async () => {
    assert.equal((await sam.get('/api/client/overview')).status, 403);
    assert.equal((await alice.get('/api/broker/dashboard')).status, 403);
    assert.equal((await alice.get('/api/settings/meta')).status, 403);
  });

  test('a permission change drops the affected user\'s sessions immediately', async () => {
    const before = await sam.get('/api/broker/dashboard');
    assert.equal(before.status, 200);
    const users = await admin.get('/api/settings/users');
    const samRow = users.data.users.find((u) => u.email === 'sam@test.local');
    await admin.patch(`/api/settings/users/${samRow.id}`, { role: 'processor' });
    const after = await sam.get('/api/broker/dashboard');
    assert.equal(after.status, 401, 'the old session must not survive a role change');
    await admin.patch(`/api/settings/users/${samRow.id}`, { role: 'assistant' });
    sam = helpers.makeClient(ctx.base);
    await sam.post('/api/auth/login', { email: 'sam@test.local', password: 'Granite-Harbor-Signal-21' });
  });
});

describe('encryption at rest (audit finding C1)', () => {
  test('the stored document is not readable from disk', async () => {
    const uploads = path.join(ctx.dataDir, 'uploads');
    const names = fs.readdirSync(uploads);
    assert.ok(names.length > 0, 'a document should have been written');
    for (const name of names) {
      assert.match(name, /\.enc$/, 'stored documents carry the .enc suffix');
      const bytes = fs.readFileSync(path.join(uploads, name));
      assert.ok(!bytes.includes(Buffer.from('%PDF')), 'ciphertext must not contain the plaintext header');
      const mode = fs.statSync(path.join(uploads, name)).mode & 0o777;
      assert.equal(mode, 0o600, 'stored documents must not be world- or group-readable');
    }
  });

  test('the API still returns the original bytes', async () => {
    const res = await alice.get(`/api/client/versions/${aliceVersionId}/file`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.bytes, helpers.PDF);
  });

  test('a key rotation keeps old documents readable, and can re-wrap them', async () => {
    const crypto = require('node:crypto');
    const cryptoStore = require('../server/crypto-store');
    const db = require('../server/db');
    const { parseJsonSafe } = require('../server/util');

    const before = parseJsonSafe(
      (await db.get('SELECT enc_envelope FROM document_versions WHERE id = ?', aliceVersionId)).enc_envelope,
      null
    );
    assert.equal(before.key_id, 'v1');

    // Rotate: the new key becomes active, the old one is retained.
    const original = process.env.DOCUMENT_ENCRYPTION_KEYS;
    process.env.DOCUMENT_ENCRYPTION_KEYS = `${original},v2:${crypto.randomBytes(32).toString('base64')}`;
    process.env.DOCUMENT_ENCRYPTION_ACTIVE_KEY = 'v2';
    cryptoStore.resetKeyCache();

    // Documents wrapped with v1 must keep working — dropping an old key is
    // how a brokerage loses its own files permanently.
    const stillReadable = await alice.get(`/api/client/versions/${aliceVersionId}/file`);
    assert.equal(stillReadable.status, 200);
    assert.deepEqual(stillReadable.bytes, helpers.PDF);

    // A new upload uses the new key.
    const docs = await alice.get(`/api/client/files/${fileA}/documents`);
    const target = docs.data.requests.find((r) => r.id !== aliceRequestId && r.applicant_id === null);
    const uploaded = await alice.upload(`/api/client/requests/${target.id}/upload`, helpers.PDF, 'new.pdf');
    assert.equal(uploaded.status, 200);
    const fresh = parseJsonSafe(
      (await db.get('SELECT enc_envelope FROM document_versions WHERE id = ?', uploaded.data.request.current_version.id)).enc_envelope,
      null
    );
    assert.equal(fresh.key_id, 'v2');

    // Removing the old key makes v1 documents unreadable — refused, not served.
    process.env.DOCUMENT_ENCRYPTION_KEYS = `v2:${process.env.DOCUMENT_ENCRYPTION_KEYS.split('v2:')[1]}`;
    cryptoStore.resetKeyCache();
    const lost = await alice.get(`/api/client/versions/${aliceVersionId}/file`);
    assert.equal(lost.status, 500, 'a missing key must fail closed, never serve garbage');

    process.env.DOCUMENT_ENCRYPTION_KEYS = original;
    process.env.DOCUMENT_ENCRYPTION_ACTIVE_KEY = 'v1';
    cryptoStore.resetKeyCache();
    assert.equal((await alice.get(`/api/client/versions/${aliceVersionId}/file`)).status, 200);
  });

  test('tampering with the ciphertext is detected rather than served', async () => {
    const db = require('../server/db');
    const version = await db.get('SELECT * FROM document_versions WHERE id = ?', aliceVersionId);
    const file = path.join(ctx.dataDir, 'uploads', version.stored_name);
    const original = fs.readFileSync(file);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 1] ^= 0xff;
    fs.writeFileSync(file, tampered);
    const res = await alice.get(`/api/client/versions/${aliceVersionId}/file`);
    assert.equal(res.status, 500, 'an authentication failure must not be served as content');
    fs.writeFileSync(file, original);
    assert.equal((await alice.get(`/api/client/versions/${aliceVersionId}/file`)).status, 200);
  });
});

describe('credentials (audit findings C4, M1)', () => {
  beforeEach(async () => { await helpers.clearRateLimits(); });

  test('there is no default administrator password', async () => {
    const anon = helpers.makeClient(ctx.base);
    for (const password of ['admin1234', 'admin', 'password', 'Password1', 'changeme']) {
      const res = await anon.post('/api/auth/login', { email: helpers.ADMIN_EMAIL, password });
      assert.equal(res.status, 401, `"${password}" must not authenticate`);
    }
  });

  test('every password the platform generates satisfies its own policy', async () => {
    // A demo script that fails one run in eight is worse than one that never
    // works: the failure looks like flakiness rather than a bug. Randomly
    // generated passwords must therefore be *guaranteed* to pass the policy,
    // not merely likely to — a plain base64 string has no digit about 13% of
    // the time, and the policy requires a letter and a digit.
    const { generateTemporaryPassword, validatePasswordStrength } = require('../server/auth');
    for (let i = 0; i < 500; i++) {
      const password = generateTemporaryPassword();
      await assert.doesNotReject(
        () => validatePasswordStrength(password, { role: 'client' }),
        `client policy rejected a generated password: ${password}`
      );
    }
    for (let i = 0; i < 200; i++) {
      const password = generateTemporaryPassword(4);
      await assert.doesNotReject(
        () => validatePasswordStrength(password, { role: 'admin' }),
        `staff policy rejected a generated password: ${password}`
      );
    }
  });

  test('a generated password is long enough for the stricter staff minimum', async () => {
    const { generateTemporaryPassword } = require('../server/auth');
    assert.ok(generateTemporaryPassword().replace(/-/g, '').length >= 10, 'client minimum');
    assert.ok(generateTemporaryPassword(4).replace(/-/g, '').length >= 12, 'staff minimum');
  });

  test('a weak new password is rejected with a helpful reason', async () => {
    const res = await alice.post('/api/auth/change-password', {
      current_password: 'Willow-Harbour-Signal-12',
      new_password: 'password123',
    });
    assert.equal(res.status, 400);
    assert.match(res.data.message, /password/i);
  });

  test('a password containing the account\'s own email is rejected', async () => {
    const res = await alice.post('/api/auth/change-password', {
      current_password: 'Willow-Harbour-Signal-12',
      new_password: 'alice@test.local-2026',
    });
    assert.equal(res.status, 400);
  });

  test('unknown and known accounts fail identically', async () => {
    const anon = helpers.makeClient(ctx.base);
    const unknown = await anon.post('/api/auth/login', { email: 'nobody@test.local', password: 'whatever-1234' });
    const known = await anon.post('/api/auth/login', { email: 'alice@test.local', password: 'whatever-1234' });
    assert.equal(unknown.status, known.status);
    assert.deepEqual(unknown.data, known.data);
  });

  test('password reset does not disclose whether an address exists', async () => {
    const anon = helpers.makeClient(ctx.base);
    const known = await anon.post('/api/auth/forgot', { email: 'alice@test.local' });
    const unknown = await anon.post('/api/auth/forgot', { email: 'nobody@test.local' });
    assert.equal(known.status, unknown.status);
    assert.deepEqual(known.data, unknown.data);
  });
});

describe('multi-factor authentication (audit finding C7)', () => {
  // These tests sign the same account in repeatedly. The per-account login
  // limit is real and is exercised in its own suite below; here it would just
  // mask what is being tested, so the counters are cleared first.
  beforeEach(async () => {
    await helpers.clearRateLimits();
    await helpers.newTotpWindow(admin.id);
  });

  test('a staff sign-in stops at the MFA challenge and issues no session', async () => {
    const attacker = helpers.makeClient(ctx.base);
    const login = await attacker.post('/api/auth/login', {
      email: helpers.ADMIN_EMAIL, password: admin.password,
    });
    assert.equal(login.status, 200);
    assert.equal(login.data.mfa_required, true);
    assert.ok(!attacker.cookies.has('sid'), 'no session cookie until the second factor is verified');
    assert.equal((await attacker.get('/api/broker/dashboard')).status, 401);
  });

  test('a wrong code does not complete the challenge', async () => {
    const attacker = helpers.makeClient(ctx.base);
    await attacker.post('/api/auth/login', { email: helpers.ADMIN_EMAIL, password: admin.password });
    const res = await attacker.post('/api/auth/mfa/verify', { code: '000000' });
    assert.equal(res.status, 400);
    assert.ok(!attacker.cookies.has('sid'));
  });

  test('the correct code completes the challenge', async () => {
    const user = helpers.makeClient(ctx.base);
    const login = await user.post('/api/auth/login', { email: helpers.ADMIN_EMAIL, password: admin.password });
    assert.equal(login.status, 200, JSON.stringify(login.data));
    const code = helpers.totpNow(admin.mfaSecret);
    const res = await user.post('/api/auth/mfa/verify', { code });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.ok(user.cookies.has('sid'));
    assert.equal((await user.get('/api/broker/dashboard')).status, 200);
  });

  test('a code cannot be replayed', async () => {
    const first = helpers.makeClient(ctx.base);
    await first.post('/api/auth/login', { email: helpers.ADMIN_EMAIL, password: admin.password });
    const code = helpers.totpNow(admin.mfaSecret);
    assert.equal((await first.post('/api/auth/mfa/verify', { code })).status, 200);

    const replay = helpers.makeClient(ctx.base);
    await replay.post('/api/auth/login', { email: helpers.ADMIN_EMAIL, password: admin.password });
    const res = await replay.post('/api/auth/mfa/verify', { code });
    assert.equal(res.status, 400, 'a step that was already used must be refused');
    assert.ok(!replay.cookies.has('sid'), 'a replayed code must not produce a session');
  });

  test('a recovery code works once and only once', async () => {
    const code = admin.recoveryCodes[0];
    const first = helpers.makeClient(ctx.base);
    const login = await first.post('/api/auth/login', { email: helpers.ADMIN_EMAIL, password: admin.password });
    assert.equal(login.status, 200, JSON.stringify(login.data));
    assert.equal((await first.post('/api/auth/mfa/verify', { code })).status, 200);

    const second = helpers.makeClient(ctx.base);
    await second.post('/api/auth/login', { email: helpers.ADMIN_EMAIL, password: admin.password });
    assert.equal((await second.post('/api/auth/mfa/verify', { code })).status, 400);
  });

  test('an administrator can clear a lost second factor, and the user must re-enrol', async () => {
    const users = await admin.get('/api/settings/users');
    const samRow = users.data.users.find((u) => u.email === 'sam@test.local');
    const res = await admin.post(`/api/settings/users/${samRow.id}/mfa/reset`);
    assert.equal(res.status, 200);
    const after = await admin.get('/api/settings/users');
    assert.equal(after.data.users.find((u) => u.email === 'sam@test.local').mfa_enrolled, false);
  });

  test('administrators can never be exempted from MFA', async () => {
    const res = await admin.put('/api/settings/config/security', {
      value: { mfa_required_roles: ['broker'] },
    });
    assert.equal(res.status, 200);
    assert.ok(res.data.value.mfa_required_roles.includes('admin'));
    await admin.put('/api/settings/config/security', {
      value: { mfa_required_roles: ['admin', 'manager', 'broker', 'processor'] },
    });
  });
});

describe('rate limiting (audit findings C3, H2)', () => {
  test('repeated bad passwords for one account are throttled', async () => {
    const anon = helpers.makeClient(ctx.base);
    let sawLimit = false;
    for (let i = 0; i < 20; i++) {
      const res = await anon.post('/api/auth/login', { email: 'bob@test.local', password: `wrong-${i}-attempt` });
      if (res.status === 429) {
        sawLimit = true;
        assert.equal(res.data.code, 'rate_limited');
        assert.ok(Number(res.headers.get('retry-after')) > 0, 'a Retry-After header tells the client when to come back');
        break;
      }
    }
    assert.ok(sawLimit, 'the account should have been rate limited within 20 attempts');
  });

  test('the limit is stored in the database, so it survives a restart', async () => {
    const db = require('../server/db');
    const row = await db.get("SELECT * FROM rate_limits WHERE bucket LIKE 'login:acct:%' LIMIT 1");
    assert.ok(row, 'rate limit counters must be persisted, not held in process memory');
    assert.ok(row.count > 0);
  });

  test('X-Forwarded-For is ignored unless a proxy is configured to be trusted', async () => {
    // TRUST_PROXY is unset in the test environment, so a spoofed header must
    // not create a fresh per-IP bucket.
    const db = require('../server/db');
    const before = await db.get("SELECT COUNT(*)::int AS n FROM rate_limits WHERE bucket = 'api:ip:203.0.113.9'");
    const spoofer = helpers.makeClient(ctx.base);
    await spoofer.get('/api/auth/me', { headers: { 'X-Forwarded-For': '203.0.113.9' } });
    const after = await db.get("SELECT COUNT(*)::int AS n FROM rate_limits WHERE bucket = 'api:ip:203.0.113.9'");
    assert.equal(after.n, before.n, 'a spoofed X-Forwarded-For must not be trusted');
  });
});

describe('cross-site request forgery', () => {
  test('a state-changing request without the custom header is refused', async () => {
    const res = await admin.post(`/api/broker/files/${fileA}/notes`, { body: 'csrf' }, { omitCsrf: true });
    assert.equal(res.status, 403);
    assert.equal(res.data.code, 'csrf');
  });

  test('a state-changing request from another origin is refused', async () => {
    const res = await admin.post(
      `/api/broker/files/${fileA}/notes`,
      { body: 'csrf' },
      { headers: { Origin: 'https://evil.example' } }
    );
    assert.equal(res.status, 403);
  });
});

describe('error reporting (Sentry)', () => {
  test('nothing that reaches Sentry carries a secret or client PII', () => {
    const sentry = require('../server/sentry');
    const scrubbed = sentry.scrub({
      env: 'DOCUMENT_ENCRYPTION_KEYS=v1:AAAABBBBCCCC failed to parse',
      db: 'connect ECONNREFUSED for postgres://app:hunter2@db.example.com:5432/mortgage',
      anthropic: 'Anthropic rejected sk-ant-api03-abcdefghijklmnop',
      contact: 'call the client on 416-555-0101',
      client: 'alice@test.local uploaded SIN 123456789',
      graph: 'MS_CLIENT_SECRET: Abc~9defGHI',
      nested: { password: 'hunter2' },
      harmless: 'document 42 failed validation',
    });
    assert.ok(!JSON.stringify(scrubbed).includes('AAAABBBBCCCC'));
    assert.ok(!JSON.stringify(scrubbed).includes('hunter2'));
    assert.ok(!JSON.stringify(scrubbed).includes('sk-ant-'));
    assert.ok(!JSON.stringify(scrubbed).includes('416-555-0101'));
    assert.ok(!JSON.stringify(scrubbed).includes('alice@test.local'));
    assert.ok(!JSON.stringify(scrubbed).includes('123456789'));
    assert.ok(!JSON.stringify(scrubbed).includes('Abc~9defGHI'));
    assert.equal(scrubbed.harmless, 'document 42 failed validation', 'useful detail survives');
  });

  test('reporting is off unless a DSN is configured, and never throws', () => {
    const sentry = require('../server/sentry');
    assert.equal(sentry.isEnabled(), false);
    assert.doesNotThrow(() => sentry.captureException(new Error('boom'), { request: { path: '/x' } }));
  });
});

describe('response hardening', () => {
  test('security headers are present on application responses', async () => {
    const res = await admin.get('/api/auth/me');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  });

  test('an unexpected server error does not leak internals', async () => {
    const res = await admin.get('/api/broker/files/not-a-number');
    assert.equal(res.status, 404);
    assert.ok(!JSON.stringify(res.data).includes('SELECT'), 'no SQL in the response');
  });

  test('the audit log records document access and forms a verifiable chain', async () => {
    await admin.get(`/api/broker/versions/${aliceVersionId}/file?disposition=attachment`);
    const audit = await admin.get('/api/broker/audit');
    assert.equal(audit.status, 200);
    const actions = audit.data.audit.map((a) => a.action);
    assert.ok(actions.includes('document_downloaded'));
    const chain = await admin.get('/api/broker/audit/verify');
    assert.equal(chain.data.ok, true, 'the audit hash chain must verify');
  });
});
