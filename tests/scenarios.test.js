'use strict';

/**
 * End-to-end tests for the 10 UX scenarios in the product spec, exercised
 * against the real HTTP API (not the UI), including cross-client isolation.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mortgage-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-test-1234';
process.env.EMAIL_TRANSPORT = 'log';

const { server } = require('../server/index');

let base;

/** Cookie-jar-aware client. */
function makeClient() {
  let cookie = null;
  return {
    async call(method, url, body, raw, filename) {
      const headers = { 'X-Requested-With': 'fetch' };
      if (cookie) headers.Cookie = cookie;
      let payload;
      if (raw) {
        headers['Content-Type'] = 'application/octet-stream';
        headers['X-Filename'] = encodeURIComponent(filename);
        payload = raw;
      } else if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      let data = null;
      try { data = await res.json(); } catch { /* streams */ }
      return { status: res.status, data, res };
    },
    get(url) { return this.call('GET', url); },
    post(url, body) { return this.call('POST', url, body); },
    patch(url, body) { return this.call('PATCH', url, body); },
    upload(url, buffer, filename) { return this.call('POST', url, undefined, buffer, filename); },
  };
}

const admin = makeClient();
const clientA = makeClient();
const clientB = makeClient();

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

let fileA;            // John Smith's file
let fileB;            // Second client's file
let activationA;
let activationB;

before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('setup: admin can sign in', async () => {
  const res = await admin.post('/api/auth/login', { email: 'admin@test.local', password: 'admin-test-1234' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.redirect, '/broker');
});

test('scenario 1 — broker creates a client; file, checklist and welcome email are automatic', async () => {
  const meta = await admin.get('/api/settings/meta');
  const purchase = meta.data.application_types.find((t) => t.key === 'purchase');

  const res = await admin.post('/api/broker/clients', {
    client: {
      first_name: 'John', last_name: 'Smith', email: 'john.smith@test.local',
      phone: '416-555-0001', employment_type: 'employee',
    },
    application: {
      application_type_id: purchase.id, purchase_price: 800000, down_payment: 160000,
      mortgage_amount: 640000,
    },
  });
  assert.strictEqual(res.status, 200);
  fileA = res.data.file;
  assert.match(fileA.file_number, /^MTG-\d{4}-\d{5}$/);
  assert.ok(fileA.checklist.total_required >= 4, 'checklist was generated');

  activationA = res.data.invites.find((i) => i.activation_link).activation_link;
  assert.ok(activationA.includes('/activate?token='));

  const emails = await admin.get(`/api/broker/files/${fileA.id}/emails`);
  assert.ok(emails.data.emails.some((e) => e.template_key === 'welcome' && e.status === 'sent'), 'welcome email sent');
});

test('scenario 3 — the rule engine produced the right documents for Employee + Purchase', async () => {
  const docs = await admin.get(`/api/broker/files/${fileA.id}/documents`);
  const names = docs.data.requests.map((r) => r.document_name);
  for (const expected of ['T4', 'Recent Pay Stub', 'Employment Letter', 'Purchase Agreement']) {
    assert.ok(names.includes(expected), `checklist includes ${expected}`);
  }
});

test('scenario 2 — client first login via activation link', async () => {
  const token = new URL(activationA).searchParams.get('token');
  const weak = await clientA.post('/api/auth/activate', { token, password: 'short' });
  assert.strictEqual(weak.status, 400, 'weak password rejected');

  const res = await clientA.post('/api/auth/activate', { token, password: 'JohnPass123' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.redirect, '/portal');

  const overview = await clientA.get('/api/client/overview');
  assert.strictEqual(overview.status, 200);
  assert.strictEqual(overview.data.files.length, 1);
  assert.strictEqual(overview.data.files[0].file_number, fileA.file_number);
  assert.ok(overview.data.files[0].needed.length >= 4, 'client sees needed documents');
  assert.ok(overview.data.files[0].next_step.text.length > 0, 'client sees a next step');

  const reused = await makeClient().post('/api/auth/activate', { token, password: 'JohnPass123' });
  assert.strictEqual(reused.status, 400, 'activation token is single-use');
});

test('scenario 4 — client uploads three documents; broker is notified', async () => {
  const docs = await clientA.get(`/api/client/files/${fileA.id}/documents`);
  const byName = (n) => docs.data.requests.find((r) => r.document_name === n);
  for (const name of ['T4', 'Recent Pay Stub', 'Employment Letter']) {
    const req = byName(name);
    const up = await clientA.upload(`/api/client/requests/${req.id}/upload`, PDF, `${name}.pdf`);
    assert.strictEqual(up.status, 200, `${name} uploaded`);
    assert.strictEqual(up.data.request.status, 'uploaded');
  }

  const evil = await clientA.upload(
    `/api/client/requests/${byName('Purchase Agreement').id}/upload`,
    Buffer.from('MZ\x90\x00 not really a pdf'), 'malware.pdf'
  );
  assert.strictEqual(evil.status, 400, 'content sniffing rejects a fake pdf');

  const notifs = await admin.get('/api/broker/notifications');
  assert.ok(notifs.data.notifications.some((n) => n.kind === 'document_uploaded'), 'broker notified of upload');
});

test('scenario 5 — broker approves two, rejects one with a client-facing reason', async () => {
  const docs = await admin.get(`/api/broker/files/${fileA.id}/documents`);
  const byName = (n) => docs.data.requests.find((r) => r.document_name === n);

  for (const name of ['T4', 'Employment Letter']) {
    const r = await admin.post(`/api/broker/requests/${byName(name).id}/review`, { action: 'approve' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.request.status, 'approved');
  }

  const noNote = await admin.post(`/api/broker/requests/${byName('Recent Pay Stub').id}/review`, { action: 'reject' });
  assert.strictEqual(noNote.status, 400, 'rejection requires a client-facing note');

  const rejected = await admin.post(`/api/broker/requests/${byName('Recent Pay Stub').id}/review`, {
    action: 'reject', client_note: 'Please upload your most recent pay stub.',
  });
  assert.strictEqual(rejected.status, 200);

  const clientDocs = await clientA.get(`/api/client/files/${fileA.id}/documents`);
  const stub = clientDocs.data.requests.find((r) => r.document_name === 'Recent Pay Stub');
  assert.strictEqual(stub.client_status.kind, 'action');
  assert.strictEqual(stub.client_status.reason, 'Please upload your most recent pay stub.');
  const t4 = clientDocs.data.requests.find((r) => r.document_name === 'T4');
  assert.strictEqual(t4.client_status.label, 'Approved');
});

test('scenario 6 — replacement upload preserves version history', async () => {
  const docs = await clientA.get(`/api/client/files/${fileA.id}/documents`);
  const stub = docs.data.requests.find((r) => r.document_name === 'Recent Pay Stub');
  const up = await clientA.upload(`/api/client/requests/${stub.id}/upload`, PDF, 'paystub-v2.pdf');
  assert.strictEqual(up.status, 200);
  assert.strictEqual(up.data.request.current_version.version, 2);

  const approved = await admin.post(`/api/broker/requests/${stub.id}/review`, { action: 'approve' });
  assert.strictEqual(approved.status, 200);

  const brokerDocs = await admin.get(`/api/broker/files/${fileA.id}/documents`);
  const brokerStub = brokerDocs.data.requests.find((r) => r.id === stub.id);
  assert.strictEqual(brokerStub.versions.length, 2, 'both versions preserved');
  assert.strictEqual(brokerStub.versions.find((v) => v.version === 1).status, 'rejected');
  assert.strictEqual(brokerStub.versions.find((v) => v.version === 2).status, 'approved');
});

test('scenario 7 — chat: client asks, broker is notified, replies, history persists', async () => {
  const sent = await clientA.post(`/api/client/files/${fileA.id}/messages`, { body: 'Do you need anything else from me?' });
  assert.strictEqual(sent.status, 200);

  const notifs = await admin.get('/api/broker/notifications');
  assert.ok(notifs.data.notifications.some((n) => n.kind === 'new_message' && /John/.test(n.title)), 'broker notified of message');

  const reply = await admin.post(`/api/broker/files/${fileA.id}/messages`, { body: 'Just the purchase agreement — thank you!' });
  assert.strictEqual(reply.status, 200);

  const thread = await clientA.get(`/api/client/files/${fileA.id}/messages`);
  assert.strictEqual(thread.data.messages.length, 2);
  assert.strictEqual(thread.data.messages[0].sender_kind, 'client');
  assert.strictEqual(thread.data.messages[1].sender_kind, 'staff');
});

test('scenario 8 — stage change updates the client dashboard and sends the configured email', async () => {
  const meta = await admin.get('/api/settings/meta');
  const submitted = meta.data.stages.find((s) => s.key === 'submitted');
  assert.strictEqual(submitted.send_email, 1);

  const res = await admin.post(`/api/broker/files/${fileA.id}/stage`, { stage_id: submitted.id, note: 'Sent to lender' });
  assert.strictEqual(res.status, 200);

  const overview = await clientA.get('/api/client/overview');
  const f = overview.data.files[0];
  assert.strictEqual(f.stage.label, submitted.client_label, 'client sees friendly stage wording');
  assert.strictEqual(f.stage.step, submitted.client_step);

  const emails = await admin.get(`/api/broker/files/${fileA.id}/emails`);
  assert.ok(emails.data.emails.some((e) => e.template_key === 'stage_changed'), 'stage email recorded');

  const history = await admin.get(`/api/broker/files/${fileA.id}`);
  assert.ok(history.data.stage_history.some((h) => h.to_name === 'Submitted'), 'stage history recorded');
});

test('scenario 9 — follow-up task appears in the task views', async () => {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const created = await admin.post('/api/broker/tasks', {
    file_id: fileA.id, title: 'Follow up with John', due_date: tomorrow,
  });
  assert.strictEqual(created.status, 200);

  const upcoming = await admin.get('/api/broker/tasks?filter=upcoming');
  assert.ok(upcoming.data.tasks.some((t) => t.title === 'Follow up with John'), 'task visible in upcoming');
});

test('scenario 10 — client isolation is enforced at the API level', async () => {
  // Create a second, unrelated client.
  const meta = await admin.get('/api/settings/meta');
  const refinance = meta.data.application_types.find((t) => t.key === 'refinance');
  const created = await admin.post('/api/broker/clients', {
    client: { first_name: 'Sarah', last_name: 'Brown', email: 'sarah.brown@test.local', employment_type: 'self_employed' },
    application: { application_type_id: refinance.id },
  });
  assert.strictEqual(created.status, 200);
  fileB = created.data.file;
  activationB = created.data.invites.find((i) => i.activation_link).activation_link;
  const token = new URL(activationB).searchParams.get('token');
  await clientB.post('/api/auth/activate', { token, password: 'SarahPass123' });

  // B's own overview never contains A's file.
  const overviewB = await clientB.get('/api/client/overview');
  assert.strictEqual(overviewB.data.files.length, 1);
  assert.strictEqual(overviewB.data.files[0].file_number, fileB.file_number);

  // B cannot read A's documents, messages, or files by changing IDs.
  assert.strictEqual((await clientB.get(`/api/client/files/${fileA.id}/documents`)).status, 404);
  assert.strictEqual((await clientB.get(`/api/client/files/${fileA.id}/messages`)).status, 404);
  assert.strictEqual((await clientB.post(`/api/client/files/${fileA.id}/messages`, { body: 'hi' })).status, 404);

  // B cannot upload into A's document requests or read A's uploaded files.
  const docsA = await admin.get(`/api/broker/files/${fileA.id}/documents`);
  const someRequest = docsA.data.requests.find((r) => r.current_version);
  assert.strictEqual((await clientB.upload(`/api/client/requests/${someRequest.id}/upload`, PDF, 'x.pdf')).status, 404);
  assert.strictEqual((await clientB.get(`/api/client/versions/${someRequest.current_version.id}/file`)).status, 404);
  // ...but A can read their own uploaded file.
  assert.strictEqual((await clientA.get(`/api/client/versions/${someRequest.current_version.id}/file`)).status, 200);

  // Clients can never use staff APIs.
  assert.strictEqual((await clientB.get('/api/broker/dashboard')).status, 403);
  assert.strictEqual((await clientB.get(`/api/broker/files/${fileA.id}`)).status, 403);
  assert.strictEqual((await clientB.get('/api/settings/users')).status, 403);

  // Unauthenticated requests are rejected outright.
  const anon = makeClient();
  assert.strictEqual((await anon.get('/api/client/overview')).status, 401);
  assert.strictEqual((await anon.get('/api/broker/dashboard')).status, 401);
});

test('security — repeated failed logins lock the account temporarily', async () => {
  const attacker = makeClient();
  for (let i = 0; i < 5; i++) {
    const r = await attacker.post('/api/auth/login', { email: 'john.smith@test.local', password: 'wrong-guess' });
    assert.ok([401, 423].includes(r.status));
  }
  const locked = await attacker.post('/api/auth/login', { email: 'john.smith@test.local', password: 'JohnPass123' });
  assert.strictEqual(locked.status, 423, 'account locked even with the right password');
});

test('security — state-changing requests without the CSRF header are refused', async () => {
  const res = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@test.local', password: 'admin-test-1234' }),
  });
  assert.strictEqual(res.status, 403);
});

test('duplicate protection warns before creating a confusing second record', async () => {
  const dup = await admin.post('/api/broker/clients', {
    client: { first_name: 'John', last_name: 'Smith', email: 'john.smith@test.local' },
    application: {},
  });
  assert.strictEqual(dup.status, 409);
  assert.strictEqual(dup.data.code, 'possible_duplicate');
  assert.ok(dup.data.duplicates[0].reasons.includes('Same email'));
});

test('permissions — an assistant cannot change stages or settings', async () => {
  const invited = await admin.post('/api/settings/users', {
    first_name: 'Amy', last_name: 'Assistant', email: 'amy@test.local', role: 'assistant',
  });
  assert.strictEqual(invited.status, 200);
  const token = new URL(invited.data.activation_link).searchParams.get('token');
  const assistant = makeClient();
  await assistant.post('/api/auth/activate', { token, password: 'AmyPass123' });

  assert.strictEqual((await assistant.get('/api/broker/dashboard')).status, 200, 'assistant can view clients');
  const meta = await admin.get('/api/settings/meta');
  const stage = meta.data.stages.find((s) => s.key === 'broker_review');
  assert.strictEqual((await assistant.post(`/api/broker/files/${fileA.id}/stage`, { stage_id: stage.id })).status, 403);
  assert.strictEqual((await assistant.post('/api/settings/stages', { name: 'X' })).status, 403);
  assert.strictEqual((await assistant.get('/api/settings/users')).status, 403);
});

test('rule engine — adding a self-employed co-borrower extends the checklist', async () => {
  const before = await admin.get(`/api/broker/files/${fileB.id}/documents`);
  const res = await admin.post(`/api/broker/files/${fileB.id}/applicants`, {
    role: 'spouse', first_name: 'Michael', last_name: 'Brown', employment_type: 'employee',
  });
  assert.strictEqual(res.status, 200);
  const afterDocs = await admin.get(`/api/broker/files/${fileB.id}/documents`);
  assert.ok(afterDocs.data.requests.length > before.data.requests.length, 'new applicant added items');
  const michaelT4 = afterDocs.data.requests.find((r) => r.document_name === 'T4' && r.applicant_name === 'Michael Brown');
  assert.ok(michaelT4, "Michael's T4 is on the checklist, labelled with his name");
});
